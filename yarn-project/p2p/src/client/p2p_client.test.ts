import { MockL2BlockSource } from '@aztec/archiver/test';
import { Signature } from '@aztec/foundation/eth-signature';
import { Fr } from '@aztec/foundation/fields';
import { retryUntil } from '@aztec/foundation/retry';
import type { AztecAsyncKVStore } from '@aztec/kv-store';
import { openTmpStore } from '@aztec/kv-store/lmdb-v2';
import { L2Block, randomPublishedL2Block } from '@aztec/stdlib/block';
import { P2PClientType } from '@aztec/stdlib/p2p';
import { mockTx } from '@aztec/stdlib/testing';

import { expect, jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';

import { InMemoryAttestationPool, type P2PService } from '../index.js';
import type { AttestationPool } from '../mem_pools/attestation_pool/attestation_pool.js';
import type { MemPools } from '../mem_pools/interface.js';
import type { TxPool } from '../mem_pools/tx_pool/index.js';
import { P2PClient } from './p2p_client.js';

describe('In-Memory P2P Client', () => {
  let txPool: MockProxy<TxPool>;
  let attestationPool: AttestationPool;
  let mempools: MemPools;
  let blockSource: MockL2BlockSource;
  let p2pService: MockProxy<P2PService>;
  let kvStore: AztecAsyncKVStore;
  let client: P2PClient;

  beforeEach(async () => {
    txPool = mock<TxPool>();
    txPool.getAllTxs.mockResolvedValue([]);
    txPool.getPendingTxHashes.mockResolvedValue([]);
    txPool.getMinedTxHashes.mockResolvedValue([]);
    txPool.getAllTxHashes.mockResolvedValue([]);

    p2pService = mock<P2PService>();

    attestationPool = new InMemoryAttestationPool();

    blockSource = new MockL2BlockSource();
    await blockSource.createBlocks(100);

    mempools = {
      txPool,
      attestationPool,
    };

    kvStore = await openTmpStore('test');
    client = new P2PClient(P2PClientType.Full, kvStore, blockSource, mempools, p2pService);
  });

  const advanceToProvenBlock = async (getProvenBlockNumber: number) => {
    blockSource.setProvenBlockNumber(getProvenBlockNumber);
    await retryUntil(async () => (await client.getSyncedProvenBlockNum()) >= getProvenBlockNumber, 'synced', 10, 0.1);
  };

  afterEach(async () => {
    if (client.isReady()) {
      await client.stop();
    }
    await kvStore.close();
  });

  it('can start & stop', async () => {
    expect(client.isReady()).toEqual(false);

    await client.start();
    expect(client.isReady()).toEqual(true);

    await client.stop();
    expect(client.isReady()).toEqual(false);
  });

  it('adds txs to pool', async () => {
    await client.start();
    const tx1 = await mockTx();
    const tx2 = await mockTx();
    await client.sendTx(tx1);
    await client.sendTx(tx2);

    expect(txPool.addTxs).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it('rejects txs after being stopped', async () => {
    await client.start();
    const tx1 = await mockTx();
    const tx2 = await mockTx();
    await client.sendTx(tx1);
    await client.sendTx(tx2);

    expect(txPool.addTxs).toHaveBeenCalledTimes(2);
    await client.stop();
    const tx3 = await mockTx();
    await expect(client.sendTx(tx3)).rejects.toThrow();
    expect(txPool.addTxs).toHaveBeenCalledTimes(2);
  });

  it('restores the previous block number it was at', async () => {
    await client.start();
    const synchedBlock = await client.getSyncedLatestBlockNum();
    await client.stop();

    const client2 = new P2PClient(P2PClientType.Full, kvStore, blockSource, mempools, p2pService);
    await expect(client2.getSyncedLatestBlockNum()).resolves.toEqual(synchedBlock);
  });

  it('deletes txs once block is proven', async () => {
    blockSource.setProvenBlockNumber(0);
    await client.start();
    expect(txPool.deleteTxs).not.toHaveBeenCalled();

    await advanceToProvenBlock(5);
    expect(txPool.deleteTxs).toHaveBeenCalledTimes(5);
    await client.stop();
  });

  it('deletes txs after waiting the set number of blocks', async () => {
    client = new P2PClient(P2PClientType.Full, kvStore, blockSource, mempools, p2pService, {
      keepProvenTxsInPoolFor: 10,
    });
    blockSource.setProvenBlockNumber(0);
    await client.start();
    expect(txPool.deleteTxs).not.toHaveBeenCalled();

    await advanceToProvenBlock(5);
    expect(txPool.deleteTxs).not.toHaveBeenCalled();

    await advanceToProvenBlock(12);
    expect(txPool.deleteTxs).toHaveBeenCalledTimes(2);

    await advanceToProvenBlock(20);
    expect(txPool.deleteTxs).toHaveBeenCalledTimes(10);
    await client.stop();
  });

  describe('Chain prunes', () => {
    it('moves the tips on a chain reorg', async () => {
      blockSource.setProvenBlockNumber(0);
      await client.start();

      await advanceToProvenBlock(90);

      await expect(client.getL2Tips()).resolves.toEqual({
        latest: { number: 100, hash: expect.any(String) },
        proven: { number: 90, hash: expect.any(String) },
        finalized: { number: 90, hash: expect.any(String) },
      });

      blockSource.removeBlocks(10);

      await client.sync();

      await expect(client.getL2Tips()).resolves.toEqual({
        latest: { number: 90, hash: expect.any(String) },
        proven: { number: 90, hash: expect.any(String) },
        finalized: { number: 90, hash: expect.any(String) },
      });

      blockSource.addBlocks([await L2Block.random(91), await L2Block.random(92)]);

      await client.sync();

      await expect(client.getL2Tips()).resolves.toEqual({
        latest: { number: 92, hash: expect.any(String) },
        proven: { number: 90, hash: expect.any(String) },
        finalized: { number: 90, hash: expect.any(String) },
      });
    });

    it('deletes txs created from a pruned block', async () => {
      client = new P2PClient(P2PClientType.Full, kvStore, blockSource, mempools, p2pService, {
        keepProvenTxsInPoolFor: 10,
      });
      blockSource.setProvenBlockNumber(0);
      await client.start();

      // add two txs to the pool. One build against block 90, one against block 95
      // then prune the chain back to block 90
      // only one tx should be deleted
      const goodTx = await mockTx();
      goodTx.data.constants.historicalHeader.globalVariables.blockNumber = new Fr(90);

      const badTx = await mockTx();
      badTx.data.constants.historicalHeader.globalVariables.blockNumber = new Fr(95);

      txPool.getAllTxs.mockResolvedValue([goodTx, badTx]);

      blockSource.removeBlocks(10);
      await client.sync();
      expect(txPool.deleteTxs).toHaveBeenCalledWith([await badTx.getTxHash()]);
      await client.stop();
    });

    it('moves mined and valid txs back to the pending set', async () => {
      client = new P2PClient(P2PClientType.Full, kvStore, blockSource, mempools, p2pService, {
        keepProvenTxsInPoolFor: 10,
      });
      blockSource.setProvenBlockNumber(0);
      await client.start();

      // add three txs to the pool built against different blocks
      // then prune the chain back to block 90
      // only one tx should be deleted
      const goodButOldTx = await mockTx();
      goodButOldTx.data.constants.historicalHeader.globalVariables.blockNumber = new Fr(89);

      const goodTx = await mockTx();
      goodTx.data.constants.historicalHeader.globalVariables.blockNumber = new Fr(90);

      const badTx = await mockTx();
      badTx.data.constants.historicalHeader.globalVariables.blockNumber = new Fr(95);

      txPool.getAllTxs.mockResolvedValue([goodButOldTx, goodTx, badTx]);
      txPool.getMinedTxHashes.mockResolvedValue([
        [await goodButOldTx.getTxHash(), 90],
        [await goodTx.getTxHash(), 91],
      ]);

      blockSource.removeBlocks(10);
      await client.sync();
      expect(txPool.deleteTxs).toHaveBeenCalledWith([await badTx.getTxHash()]);
      expect(txPool.markMinedAsPending).toHaveBeenCalledWith([await goodTx.getTxHash()]);
      await client.stop();
    });
  });

  describe('Attestation pool pruning', () => {
    it('deletes attestations older than the number of slots we want to keep in the pool', async () => {
      const advanceToProvenBlockNumber = 20;
      const keepAttestationsInPoolFor = 12;

      const deleteAttestationsOlderThanSpy = jest.spyOn(attestationPool, 'deleteAttestationsOlderThan');

      blockSource.setProvenBlockNumber(0);
      (client as any).keepAttestationsInPoolFor = keepAttestationsInPoolFor;
      await client.start();
      expect(deleteAttestationsOlderThanSpy).not.toHaveBeenCalled();

      await advanceToProvenBlock(advanceToProvenBlockNumber);

      expect(deleteAttestationsOlderThanSpy).toHaveBeenCalledTimes(1);
      expect(deleteAttestationsOlderThanSpy).toHaveBeenCalledWith(
        BigInt(advanceToProvenBlockNumber - keepAttestationsInPoolFor),
      );
    });
  });

  describe('Block stream events', () => {
    it('adds attestations to the pool', async () => {
      await client.start();
      const block = await randomPublishedL2Block(1);
      const addAttestationsSpy = jest.spyOn(attestationPool, 'addAttestations');
      await client.handleBlockStreamEvent({ type: 'blocks-added', blocks: [block] });
      expect(addAttestationsSpy).toHaveBeenCalledWith(
        block.signatures.map(signature => expect.objectContaining({ signature })),
      );
    });

    it('handles empty signatures in block stream events', async () => {
      await client.start();
      const block = await randomPublishedL2Block(1);
      block.signatures[0] = Signature.empty();
      const addAttestationsSpy = jest.spyOn(attestationPool, 'addAttestations');
      await client.handleBlockStreamEvent({ type: 'blocks-added', blocks: [block] });
      expect(addAttestationsSpy).toHaveBeenCalledWith(
        block.signatures.filter(sig => !sig.isEmpty).map(signature => expect.objectContaining({ signature })),
      );
    });
  });
});
