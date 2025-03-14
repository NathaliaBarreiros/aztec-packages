import { INITIAL_L2_BLOCK_NUM, MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX } from '@aztec/constants';
import { Fr } from '@aztec/foundation/fields';
import { createLogger } from '@aztec/foundation/log';
import { FunctionSelector } from '@aztec/stdlib/abi';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';
import { type InBlock, type L2Block, L2BlockHash, wrapInBlock } from '@aztec/stdlib/block';
import type {
  ContractClassPublic,
  ContractClassPublicWithBlockNumber,
  ContractInstanceUpdateWithAddress,
  ContractInstanceWithAddress,
  ExecutablePrivateFunctionWithMembershipProof,
  UnconstrainedFunctionWithMembershipProof,
} from '@aztec/stdlib/contract';
import type { GetContractClassLogsResponse, GetPublicLogsResponse } from '@aztec/stdlib/interfaces/client';
import {
  ContractClassLog,
  ExtendedContractClassLog,
  ExtendedPublicLog,
  type LogFilter,
  LogId,
  type PrivateLog,
  type PublicLog,
  TxScopedL2Log,
} from '@aztec/stdlib/logs';
import type { InboxLeaf } from '@aztec/stdlib/messaging';
import { type BlockHeader, TxEffect, TxHash, TxReceipt } from '@aztec/stdlib/tx';

import type { ArchiverDataStore, ArchiverL1SynchPoint } from '../archiver_store.js';
import type { DataRetrieval } from '../structs/data_retrieval.js';
import type { PublishedL2Block } from '../structs/published.js';
import { L1ToL2MessageStore } from './l1_to_l2_message_store.js';

type StoredContractInstanceUpdate = ContractInstanceUpdateWithAddress & { blockNumber: number; logIndex: number };

/**
 * Simple, in-memory implementation of an archiver data store.
 */
export class MemoryArchiverStore implements ArchiverDataStore {
  /**
   * An array containing all the L2 blocks that have been fetched so far.
   */
  private l2Blocks: PublishedL2Block[] = [];

  /**
   * An array containing all the tx effects in the L2 blocks that have been fetched so far.
   */
  private txEffects: InBlock<TxEffect>[] = [];

  private taggedLogs: Map<string, TxScopedL2Log[]> = new Map();

  private logTagsPerBlock: Map<number, Fr[]> = new Map();

  private privateLogsPerBlock: Map<number, PrivateLog[]> = new Map();

  private publicLogsPerBlock: Map<number, PublicLog[]> = new Map();

  private contractClassLogsPerBlock: Map<number, ContractClassLog[]> = new Map();

  private blockScopedNullifiers: Map<string, { blockNumber: number; blockHash: string; index: bigint }> = new Map();

  /**
   * Contains all L1 to L2 messages.
   */
  private l1ToL2Messages = new L1ToL2MessageStore();

  private contractClasses: Map<string, ContractClassPublicWithBlockNumber> = new Map();

  private bytecodeCommitments: Map<string, Fr> = new Map();

  private privateFunctions: Map<string, ExecutablePrivateFunctionWithMembershipProof[]> = new Map();

  private unconstrainedFunctions: Map<string, UnconstrainedFunctionWithMembershipProof[]> = new Map();

  private contractInstances: Map<string, ContractInstanceWithAddress> = new Map();

  private contractInstanceUpdates: Map<string, StoredContractInstanceUpdate[]> = new Map();

  private lastL1BlockNewBlocks: bigint | undefined = undefined;

  private lastL1BlockNewMessages: bigint | undefined = undefined;

  private lastProvenL2BlockNumber: number = 0;
  private lastProvenL2EpochNumber: number = 0;

  private functionNames = new Map<string, string>();

  #log = createLogger('archiver:data-store');

  constructor(
    /** The max number of logs that can be obtained in 1 "getPublicLogs" call. */
    public readonly maxLogs: number,
  ) {}

  public getContractClass(id: Fr): Promise<ContractClassPublic | undefined> {
    const contractClass = this.contractClasses.get(id.toString());
    return Promise.resolve(
      contractClass && {
        ...contractClass,
        privateFunctions: this.privateFunctions.get(id.toString()) ?? [],
        unconstrainedFunctions: this.unconstrainedFunctions.get(id.toString()) ?? [],
      },
    );
  }

  public getContractClassIds(): Promise<Fr[]> {
    return Promise.resolve(Array.from(this.contractClasses.keys()).map(key => Fr.fromHexString(key)));
  }

  public getContractInstance(
    address: AztecAddress,
    blockNumber: number,
  ): Promise<ContractInstanceWithAddress | undefined> {
    const instance = this.contractInstances.get(address.toString());
    if (!instance) {
      return Promise.resolve(undefined);
    }
    const updates = this.contractInstanceUpdates.get(address.toString()) || [];
    if (updates.length > 0) {
      const lastUpdate = updates[0];
      if (blockNumber >= lastUpdate.blockOfChange) {
        instance.currentContractClassId = lastUpdate.newContractClassId;
      } else if (!lastUpdate.prevContractClassId.isZero()) {
        instance.currentContractClassId = lastUpdate.prevContractClassId;
      } else {
        instance.currentContractClassId = instance.originalContractClassId;
      }
    }
    return Promise.resolve(instance);
  }

  public getBytecodeCommitment(contractClassId: Fr): Promise<Fr | undefined> {
    return Promise.resolve(this.bytecodeCommitments.get(contractClassId.toString()));
  }

  public addFunctions(
    contractClassId: Fr,
    newPrivateFunctions: ExecutablePrivateFunctionWithMembershipProof[],
    newUnconstrainedFunctions: UnconstrainedFunctionWithMembershipProof[],
  ): Promise<boolean> {
    const privateFunctions = this.privateFunctions.get(contractClassId.toString()) ?? [];
    const unconstrainedFunctions = this.unconstrainedFunctions.get(contractClassId.toString()) ?? [];
    const updatedPrivateFunctions = [
      ...privateFunctions,
      ...newPrivateFunctions.filter(newFn => !privateFunctions.find(f => f.selector.equals(newFn.selector))),
    ];
    const updatedUnconstrainedFunctions = [
      ...unconstrainedFunctions,
      ...newUnconstrainedFunctions.filter(
        newFn => !unconstrainedFunctions.find(f => f.selector.equals(newFn.selector)),
      ),
    ];
    this.privateFunctions.set(contractClassId.toString(), updatedPrivateFunctions);
    this.unconstrainedFunctions.set(contractClassId.toString(), updatedUnconstrainedFunctions);
    return Promise.resolve(true);
  }

  public addContractClasses(
    data: ContractClassPublic[],
    bytecodeCommitments: Fr[],
    blockNumber: number,
  ): Promise<boolean> {
    for (let i = 0; i < data.length; i++) {
      const contractClass = data[i];
      if (!this.contractClasses.has(contractClass.id.toString())) {
        this.contractClasses.set(contractClass.id.toString(), {
          ...contractClass,
          l2BlockNumber: blockNumber,
        });
      }
      if (!this.bytecodeCommitments.has(contractClass.id.toString())) {
        this.bytecodeCommitments.set(contractClass.id.toString(), bytecodeCommitments[i]);
      }
    }
    return Promise.resolve(true);
  }

  public deleteContractClasses(data: ContractClassPublic[], blockNumber: number): Promise<boolean> {
    for (const contractClass of data) {
      const restored = this.contractClasses.get(contractClass.id.toString());
      if (restored && restored.l2BlockNumber >= blockNumber) {
        this.contractClasses.delete(contractClass.id.toString());
        this.bytecodeCommitments.delete(contractClass.id.toString());
      }
    }
    return Promise.resolve(true);
  }

  public addContractInstances(data: ContractInstanceWithAddress[], _blockNumber: number): Promise<boolean> {
    for (const contractInstance of data) {
      this.contractInstances.set(contractInstance.address.toString(), contractInstance);
    }
    return Promise.resolve(true);
  }

  public deleteContractInstances(data: ContractInstanceWithAddress[], _blockNumber: number): Promise<boolean> {
    for (const contractInstance of data) {
      this.contractInstances.delete(contractInstance.address.toString());
    }
    return Promise.resolve(true);
  }

  public addContractInstanceUpdates(data: ContractInstanceUpdateWithAddress[], blockNumber: number): Promise<boolean> {
    for (let logIndex = 0; logIndex < data.length; logIndex++) {
      const contractInstanceUpdate = data[logIndex];
      const updates = this.contractInstanceUpdates.get(contractInstanceUpdate.address.toString()) || [];
      updates.unshift({
        ...contractInstanceUpdate,
        blockNumber,
        logIndex,
      });
      this.contractInstanceUpdates.set(contractInstanceUpdate.address.toString(), updates);
    }
    return Promise.resolve(true);
  }

  public deleteContractInstanceUpdates(
    data: ContractInstanceUpdateWithAddress[],
    blockNumber: number,
  ): Promise<boolean> {
    for (let logIndex = 0; logIndex < data.length; logIndex++) {
      const contractInstanceUpdate = data[logIndex];
      let updates = this.contractInstanceUpdates.get(contractInstanceUpdate.address.toString()) || [];
      updates = updates.filter(update => !(update.blockNumber === blockNumber && update.logIndex === logIndex));
      this.contractInstanceUpdates.set(contractInstanceUpdate.address.toString(), updates);
    }
    return Promise.resolve(true);
  }

  /**
   * Append new blocks to the store's list.
   * @param blocks - The L2 blocks to be added to the store and the last processed L1 block.
   * @returns True if the operation is successful.
   */
  public async addBlocks(blocks: PublishedL2Block[]): Promise<boolean> {
    if (blocks.length === 0) {
      return Promise.resolve(true);
    }

    this.lastL1BlockNewBlocks = blocks[blocks.length - 1].l1.blockNumber;
    this.l2Blocks.push(...blocks);
    const flatTxEffects = blocks.flatMap(b => b.block.body.txEffects.map(txEffect => ({ block: b, txEffect })));
    const wrappedTxEffects = await Promise.all(
      flatTxEffects.map(flatTxEffect => wrapInBlock(flatTxEffect.txEffect, flatTxEffect.block.block)),
    );
    this.txEffects.push(...wrappedTxEffects);

    return Promise.resolve(true);
  }

  /**
   * Unwinds blocks from the database
   * @param from -  The tip of the chain, passed for verification purposes,
   *                ensuring that we don't end up deleting something we did not intend
   * @param blocksToUnwind - The number of blocks we are to unwind
   * @returns True if the operation is successful
   */
  public async unwindBlocks(from: number, blocksToUnwind: number): Promise<boolean> {
    const last = await this.getSynchedL2BlockNumber();
    if (from != last) {
      throw new Error(`Can only unwind blocks from the tip (requested ${from} but current tip is ${last})`);
    }

    const stopAt = from - blocksToUnwind;
    while ((await this.getSynchedL2BlockNumber()) > stopAt) {
      const block = this.l2Blocks.pop();
      if (block == undefined) {
        break;
      }
      block.block.body.txEffects.forEach(() => this.txEffects.pop());
    }

    return Promise.resolve(true);
  }

  #storeTaggedLogs(block: L2Block): void {
    const dataStartIndexForBlock =
      block.header.state.partial.noteHashTree.nextAvailableLeafIndex -
      block.body.txEffects.length * MAX_NOTE_HASHES_PER_TX;
    block.body.txEffects.forEach((txEffect, txIndex) => {
      const txHash = txEffect.txHash;
      const dataStartIndexForTx = dataStartIndexForBlock + txIndex * MAX_NOTE_HASHES_PER_TX;

      txEffect.privateLogs.forEach(log => {
        const tag = log.fields[0];
        this.#log.verbose(`Storing private log with tag ${tag.toString()} from block ${block.number}`);

        const currentLogs = this.taggedLogs.get(tag.toString()) || [];
        this.taggedLogs.set(tag.toString(), [
          ...currentLogs,
          new TxScopedL2Log(txHash, dataStartIndexForTx, block.number, log),
        ]);
        const currentTagsInBlock = this.logTagsPerBlock.get(block.number) || [];
        this.logTagsPerBlock.set(block.number, [...currentTagsInBlock, tag]);
      });

      txEffect.publicLogs.forEach(log => {
        const tag = log.log[0];
        this.#log.verbose(`Storing public log with tag ${tag.toString()} from block ${block.number}`);

        const currentLogs = this.taggedLogs.get(tag.toString()) || [];
        this.taggedLogs.set(tag.toString(), [
          ...currentLogs,
          new TxScopedL2Log(txHash, dataStartIndexForTx, block.number, log),
        ]);
        const currentTagsInBlock = this.logTagsPerBlock.get(block.number) || [];
        this.logTagsPerBlock.set(block.number, [...currentTagsInBlock, tag]);
      });
    });
  }

  /**
   * Append new logs to the store's list.
   * @param block - The block for which to add the logs.
   * @returns True if the operation is successful.
   */
  addLogs(blocks: L2Block[]): Promise<boolean> {
    blocks.forEach(block => {
      this.#storeTaggedLogs(block);
      this.privateLogsPerBlock.set(block.number, block.body.txEffects.map(txEffect => txEffect.privateLogs).flat());
      this.publicLogsPerBlock.set(block.number, block.body.txEffects.map(txEffect => txEffect.publicLogs).flat());
      this.contractClassLogsPerBlock.set(
        block.number,
        block.body.txEffects.map(txEffect => txEffect.contractClassLogs).flat(),
      );
    });
    return Promise.resolve(true);
  }

  deleteLogs(blocks: L2Block[]): Promise<boolean> {
    const tagsToDelete = blocks.flatMap(block => this.logTagsPerBlock.get(block.number));
    tagsToDelete
      .filter(tag => tag != undefined)
      .forEach(tag => {
        this.taggedLogs.delete(tag!.toString());
      });

    blocks.forEach(block => {
      this.privateLogsPerBlock.delete(block.number);
      this.publicLogsPerBlock.delete(block.number);
      this.logTagsPerBlock.delete(block.number);
      this.contractClassLogsPerBlock.delete(block.number);
    });

    return Promise.resolve(true);
  }

  async addNullifiers(blocks: L2Block[]): Promise<boolean> {
    await Promise.all(
      blocks.map(async block => {
        const dataStartIndexForBlock =
          block.header.state.partial.nullifierTree.nextAvailableLeafIndex -
          block.body.txEffects.length * MAX_NULLIFIERS_PER_TX;
        const blockHash = await block.hash();
        block.body.txEffects.forEach((txEffects, txIndex) => {
          const dataStartIndexForTx = dataStartIndexForBlock + txIndex * MAX_NULLIFIERS_PER_TX;
          txEffects.nullifiers.forEach((nullifier, nullifierIndex) => {
            this.blockScopedNullifiers.set(nullifier.toString(), {
              index: BigInt(dataStartIndexForTx + nullifierIndex),
              blockNumber: block.number,
              blockHash: blockHash.toString(),
            });
          });
        });
      }),
    );
    return Promise.resolve(true);
  }

  deleteNullifiers(blocks: L2Block[]): Promise<boolean> {
    blocks.forEach(block => {
      block.body.txEffects.forEach(txEffect => {
        txEffect.nullifiers.forEach(nullifier => {
          this.blockScopedNullifiers.delete(nullifier.toString());
        });
      });
    });
    return Promise.resolve(true);
  }

  findNullifiersIndexesWithBlock(blockNumber: number, nullifiers: Fr[]): Promise<(InBlock<bigint> | undefined)[]> {
    const blockScopedNullifiers = nullifiers.map(nullifier => {
      const nullifierData = this.blockScopedNullifiers.get(nullifier.toString());
      if (nullifierData !== undefined && nullifierData.blockNumber <= blockNumber) {
        return {
          data: nullifierData.index,
          l2BlockHash: nullifierData.blockHash,
          l2BlockNumber: nullifierData.blockNumber,
        } as InBlock<bigint>;
      }
      return undefined;
    });
    return Promise.resolve(blockScopedNullifiers);
  }

  getTotalL1ToL2MessageCount(): Promise<bigint> {
    return Promise.resolve(this.l1ToL2Messages.getTotalL1ToL2MessageCount());
  }

  /**
   * Append L1 to L2 messages to the store.
   * @param messages - The L1 to L2 messages to be added to the store and the last processed L1 block.
   * @returns True if the operation is successful.
   */
  public addL1ToL2Messages(messages: DataRetrieval<InboxLeaf>): Promise<boolean> {
    if (
      typeof this.lastL1BlockNewMessages === 'bigint' &&
      messages.lastProcessedL1BlockNumber <= this.lastL1BlockNewMessages
    ) {
      return Promise.resolve(false);
    }

    this.lastL1BlockNewMessages = messages.lastProcessedL1BlockNumber;
    for (const message of messages.retrievedData) {
      this.l1ToL2Messages.addMessage(message);
    }
    return Promise.resolve(true);
  }

  /**
   * Gets the L1 to L2 message index in the L1 to L2 message tree.
   * @param l1ToL2Message - The L1 to L2 message.
   * @returns The index of the L1 to L2 message in the L1 to L2 message tree (undefined if not found).
   */
  getL1ToL2MessageIndex(l1ToL2Message: Fr): Promise<bigint | undefined> {
    return Promise.resolve(this.l1ToL2Messages.getMessageIndex(l1ToL2Message));
  }

  /**
   * Gets up to `limit` amount of L2 blocks starting from `from`.
   * @param from - Number of the first block to return (inclusive).
   * @param limit - The number of blocks to return.
   * @returns The requested L2 blocks.
   * @remarks When "from" is smaller than genesis block number, blocks from the beginning are returned.
   */
  public getBlocks(from: number, limit: number): Promise<PublishedL2Block[]> {
    if (limit < 1) {
      return Promise.reject(new Error(`Invalid limit: ${limit}`));
    }

    if (from < INITIAL_L2_BLOCK_NUM) {
      return Promise.reject(new Error(`Invalid start: ${from}`));
    }

    const fromIndex = from - INITIAL_L2_BLOCK_NUM;
    if (fromIndex >= this.l2Blocks.length) {
      return Promise.resolve([]);
    }

    const toIndex = fromIndex + limit;
    return Promise.resolve(this.l2Blocks.slice(fromIndex, toIndex));
  }

  public async getBlockHeaders(from: number, limit: number): Promise<BlockHeader[]> {
    const blocks = await this.getBlocks(from, limit);
    return blocks.map(block => block.block.header);
  }

  /**
   * Gets a tx effect.
   * @param txHash - The txHash of the tx effect.
   * @returns The requested tx effect.
   */
  public getTxEffect(txHash: TxHash): Promise<InBlock<TxEffect> | undefined> {
    const txEffect = this.txEffects.find(tx => tx.data.txHash.equals(txHash));
    return Promise.resolve(txEffect);
  }

  /**
   * Gets a receipt of a settled tx.
   * @param txHash - The hash of a tx we try to get the receipt for.
   * @returns The requested tx receipt (or undefined if not found).
   */
  public async getSettledTxReceipt(txHash: TxHash): Promise<TxReceipt | undefined> {
    for (const block of this.l2Blocks) {
      for (const txEffect of block.block.body.txEffects) {
        if (txEffect.txHash.equals(txHash)) {
          return new TxReceipt(
            txHash,
            TxReceipt.statusFromRevertCode(txEffect.revertCode),
            '',
            txEffect.transactionFee.toBigInt(),
            L2BlockHash.fromField(await block.block.hash()),
            block.block.number,
          );
        }
      }
    }
    return undefined;
  }

  /**
   * Gets L1 to L2 message (to be) included in a given block.
   * @param blockNumber - L2 block number to get messages for.
   * @returns The L1 to L2 messages/leaves of the messages subtree (throws if not found).
   */
  getL1ToL2Messages(blockNumber: bigint): Promise<Fr[]> {
    return Promise.resolve(this.l1ToL2Messages.getMessages(blockNumber));
  }

  /**
   * Retrieves all private logs from up to `limit` blocks, starting from the block number `from`.
   * @param from - The block number from which to begin retrieving logs.
   * @param limit - The maximum number of blocks to retrieve logs from.
   * @returns An array of private logs from the specified range of blocks.
   */
  getPrivateLogs(from: number, limit: number): Promise<PrivateLog[]> {
    if (from < INITIAL_L2_BLOCK_NUM || limit < 1) {
      return Promise.resolve([]);
    }

    if (from > this.l2Blocks.length) {
      return Promise.resolve([]);
    }

    const startIndex = from;
    const endIndex = startIndex + limit;
    const upper = Math.min(endIndex, this.l2Blocks.length + INITIAL_L2_BLOCK_NUM);

    const logsInBlocks = [];
    for (let i = startIndex; i < upper; i++) {
      const logs = this.privateLogsPerBlock.get(i);
      if (logs) {
        logsInBlocks.push(logs);
      }
    }

    return Promise.resolve(logsInBlocks.flat());
  }

  /**
   * Gets all logs that match any of the received tags (i.e. logs with their first field equal to a tag).
   * @param tags - The tags to filter the logs by.
   * @returns For each received tag, an array of matching logs is returned. An empty array implies no logs match
   * that tag.
   */
  getLogsByTags(tags: Fr[]): Promise<TxScopedL2Log[][]> {
    const logs = tags.map(tag => this.taggedLogs.get(tag.toString()) || []);
    return Promise.resolve(logs);
  }

  /**
   * Gets public logs based on the provided filter.
   * @param filter - The filter to apply to the logs.
   * @returns The requested logs.
   * @remarks Works by doing an intersection of all params in the filter.
   */
  getPublicLogs(filter: LogFilter): Promise<GetPublicLogsResponse> {
    let txHash: TxHash | undefined;
    let fromBlock = 0;
    let toBlock = this.l2Blocks.length + INITIAL_L2_BLOCK_NUM;
    let txIndexInBlock = 0;
    let logIndexInTx = 0;

    if (filter.afterLog) {
      // Continuation parameter is set --> tx hash is ignored
      if (filter.fromBlock == undefined || filter.fromBlock <= filter.afterLog.blockNumber) {
        fromBlock = filter.afterLog.blockNumber;
        txIndexInBlock = filter.afterLog.txIndex;
        logIndexInTx = filter.afterLog.logIndex + 1; // We want to start from the next log
      } else {
        fromBlock = filter.fromBlock;
      }
    } else {
      txHash = filter.txHash;

      if (filter.fromBlock !== undefined) {
        fromBlock = filter.fromBlock;
      }
    }

    if (filter.toBlock !== undefined) {
      toBlock = filter.toBlock;
    }

    // Ensure the indices are within block array bounds
    fromBlock = Math.max(fromBlock, INITIAL_L2_BLOCK_NUM);
    toBlock = Math.min(toBlock, this.l2Blocks.length + INITIAL_L2_BLOCK_NUM);

    if (fromBlock > this.l2Blocks.length || toBlock < fromBlock || toBlock <= 0) {
      return Promise.resolve({
        logs: [],
        maxLogsHit: false,
      });
    }

    const contractAddress = filter.contractAddress;

    const logs: ExtendedPublicLog[] = [];

    for (; fromBlock < toBlock; fromBlock++) {
      const block = this.l2Blocks[fromBlock - INITIAL_L2_BLOCK_NUM];
      const blockLogs = this.publicLogsPerBlock.get(fromBlock);

      if (blockLogs) {
        for (let logIndex = 0; logIndex < blockLogs.length; logIndex++) {
          const log = blockLogs[logIndex];
          const thisTxEffect = block.block.body.txEffects.filter(effect => effect.publicLogs.includes(log))[0];
          const thisTxIndexInBlock = block.block.body.txEffects.indexOf(thisTxEffect);
          const thisLogIndexInTx = thisTxEffect.publicLogs.indexOf(log);
          if (
            (!txHash || thisTxEffect.txHash.equals(txHash)) &&
            (!contractAddress || log.contractAddress.equals(contractAddress)) &&
            thisTxIndexInBlock >= txIndexInBlock &&
            thisLogIndexInTx >= logIndexInTx
          ) {
            logs.push(new ExtendedPublicLog(new LogId(block.block.number, thisTxIndexInBlock, thisLogIndexInTx), log));
            if (logs.length === this.maxLogs) {
              return Promise.resolve({
                logs,
                maxLogsHit: true,
              });
            }
          }
        }
      }
    }

    return Promise.resolve({
      logs,
      maxLogsHit: false,
    });
  }

  /**
   * Gets contract class logs based on the provided filter.
   * NB: clone of the above fn, but for contract class logs
   * @param filter - The filter to apply to the logs.
   * @returns The requested logs.
   * @remarks Works by doing an intersection of all params in the filter.
   */
  getContractClassLogs(filter: LogFilter): Promise<GetContractClassLogsResponse> {
    let txHash: TxHash | undefined;
    let fromBlock = 0;
    let toBlock = this.l2Blocks.length + INITIAL_L2_BLOCK_NUM;
    let txIndexInBlock = 0;
    let logIndexInTx = 0;

    if (filter.afterLog) {
      // Continuation parameter is set --> tx hash is ignored
      if (filter.fromBlock == undefined || filter.fromBlock <= filter.afterLog.blockNumber) {
        fromBlock = filter.afterLog.blockNumber;
        txIndexInBlock = filter.afterLog.txIndex;
        logIndexInTx = filter.afterLog.logIndex + 1; // We want to start from the next log
      } else {
        fromBlock = filter.fromBlock;
      }
    } else {
      txHash = filter.txHash;

      if (filter.fromBlock !== undefined) {
        fromBlock = filter.fromBlock;
      }
    }

    if (filter.toBlock !== undefined) {
      toBlock = filter.toBlock;
    }

    // Ensure the indices are within block array bounds
    fromBlock = Math.max(fromBlock, INITIAL_L2_BLOCK_NUM);
    toBlock = Math.min(toBlock, this.l2Blocks.length + INITIAL_L2_BLOCK_NUM);

    if (fromBlock > this.l2Blocks.length || toBlock < fromBlock || toBlock <= 0) {
      return Promise.resolve({
        logs: [],
        maxLogsHit: false,
      });
    }

    const contractAddress = filter.contractAddress;

    const logs: ExtendedContractClassLog[] = [];

    for (; fromBlock < toBlock; fromBlock++) {
      const block = this.l2Blocks[fromBlock - INITIAL_L2_BLOCK_NUM];
      const blockLogs = this.contractClassLogsPerBlock.get(fromBlock);

      if (blockLogs) {
        for (let logIndex = 0; logIndex < blockLogs.length; logIndex++) {
          const log = blockLogs[logIndex];
          const thisTxEffect = block.block.body.txEffects.filter(effect => effect.contractClassLogs.includes(log))[0];
          const thisTxIndexInBlock = block.block.body.txEffects.indexOf(thisTxEffect);
          const thisLogIndexInTx = thisTxEffect.contractClassLogs.indexOf(log);
          if (
            (!txHash || thisTxEffect.txHash.equals(txHash)) &&
            (!contractAddress || log.contractAddress.equals(contractAddress)) &&
            thisTxIndexInBlock >= txIndexInBlock &&
            thisLogIndexInTx >= logIndexInTx
          ) {
            logs.push(
              new ExtendedContractClassLog(new LogId(block.block.number, thisTxIndexInBlock, thisLogIndexInTx), log),
            );
            if (logs.length === this.maxLogs) {
              return Promise.resolve({
                logs,
                maxLogsHit: true,
              });
            }
          }
        }
      }
    }

    return Promise.resolve({
      logs,
      maxLogsHit: false,
    });
  }

  getLastBlockNumber(): number {
    if (this.l2Blocks.length === 0) {
      return INITIAL_L2_BLOCK_NUM - 1;
    }
    return this.l2Blocks[this.l2Blocks.length - 1].block.number;
  }

  /**
   * Gets the number of the latest L2 block processed.
   * @returns The number of the latest L2 block processed.
   */
  public getSynchedL2BlockNumber(): Promise<number> {
    return Promise.resolve(this.getLastBlockNumber());
  }

  public getProvenL2BlockNumber(): Promise<number> {
    return Promise.resolve(this.lastProvenL2BlockNumber);
  }

  public setProvenL2BlockNumber(l2BlockNumber: number): Promise<void> {
    this.lastProvenL2BlockNumber = l2BlockNumber;
    return Promise.resolve();
  }

  setBlockSynchedL1BlockNumber(l1BlockNumber: bigint) {
    this.lastL1BlockNewBlocks = l1BlockNumber;
    return Promise.resolve();
  }

  setMessageSynchedL1BlockNumber(l1BlockNumber: bigint) {
    this.lastL1BlockNewMessages = l1BlockNumber;
    return Promise.resolve();
  }

  public getSynchPoint(): Promise<ArchiverL1SynchPoint> {
    return Promise.resolve({
      blocksSynchedTo: this.lastL1BlockNewBlocks,
      messagesSynchedTo: this.lastL1BlockNewMessages,
    });
  }

  public getContractFunctionName(_address: AztecAddress, selector: FunctionSelector): Promise<string | undefined> {
    return Promise.resolve(this.functionNames.get(selector.toString()));
  }

  public async registerContractFunctionSignatures(_address: AztecAddress, signatures: string[]): Promise<void> {
    for (const sig of signatures) {
      try {
        const selector = await FunctionSelector.fromSignature(sig);
        this.functionNames.set(selector.toString(), sig.slice(0, sig.indexOf('(')));
      } catch {
        this.#log.warn(`Failed to parse signature: ${sig}. Ignoring`);
      }
    }
  }

  public estimateSize(): Promise<{ mappingSize: number; actualSize: number; numItems: number }> {
    return Promise.resolve({ mappingSize: 0, actualSize: 0, numItems: 0 });
  }
}
