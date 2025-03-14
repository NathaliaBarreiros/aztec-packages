import { Fr, Point } from '@aztec/foundation/fields';
import { FunctionSelector, NoteSelector } from '@aztec/stdlib/abi';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { ContractClassLog, LogWithTxData } from '@aztec/stdlib/logs';
import { MerkleTreeId } from '@aztec/stdlib/trees';

import type { ACVMField } from '../acvm_types.js';
import {
  frToBoolean,
  frToNumber,
  fromACVMField,
  fromBoundedVec,
  fromUintArray,
  fromUintBoundedVec,
} from '../deserialize.js';
import { bufferToBoundedVec, toACVMField, toACVMFieldSingleOrArray } from '../serialize.js';
import type { TypedOracle } from './typed_oracle.js';

/**
 * A data source that has all the apis required by Aztec.nr.
 */
export class Oracle {
  constructor(private typedOracle: TypedOracle) {}

  getRandomField(): ACVMField {
    const val = this.typedOracle.getRandomField();
    return toACVMField(val);
  }

  // Since the argument is a slice, noir automatically adds a length field to oracle call.
  async storeInExecutionCache(_length: ACVMField[], values: ACVMField[]): Promise<ACVMField> {
    const hash = await this.typedOracle.storeInExecutionCache(values.map(fromACVMField));
    return toACVMField(hash);
  }

  async loadFromExecutionCache([returnsHash]: ACVMField[]): Promise<ACVMField[]> {
    const values = await this.typedOracle.loadFromExecutionCache(fromACVMField(returnsHash));
    return values.map(toACVMField);
  }

  async getBlockNumber(): Promise<ACVMField> {
    return toACVMField(await this.typedOracle.getBlockNumber());
  }

  async getContractAddress(): Promise<ACVMField> {
    return toACVMField(await this.typedOracle.getContractAddress());
  }

  async getVersion(): Promise<ACVMField> {
    return toACVMField(await this.typedOracle.getVersion());
  }

  async getChainId(): Promise<ACVMField> {
    return toACVMField(await this.typedOracle.getChainId());
  }

  async getKeyValidationRequest([pkMHash]: ACVMField[]): Promise<ACVMField[]> {
    const { pkM, skApp } = await this.typedOracle.getKeyValidationRequest(fromACVMField(pkMHash));

    return [toACVMField(pkM.x), toACVMField(pkM.y), toACVMField(pkM.isInfinite), toACVMField(skApp)];
  }

  async getContractInstance([address]: ACVMField[]) {
    const instance = await this.typedOracle.getContractInstance(AztecAddress.fromField(fromACVMField(address)));

    return [
      instance.salt,
      instance.deployer,
      instance.currentContractClassId,
      instance.initializationHash,
      ...instance.publicKeys.toFields(),
    ].map(toACVMField);
  }

  async getMembershipWitness(
    [blockNumber]: ACVMField[],
    [treeId]: ACVMField[],
    [leafValue]: ACVMField[],
  ): Promise<ACVMField[]> {
    const parsedBlockNumber = frToNumber(fromACVMField(blockNumber));
    const parsedTreeId = frToNumber(fromACVMField(treeId));
    const parsedLeafValue = fromACVMField(leafValue);

    const witness = await this.typedOracle.getMembershipWitness(parsedBlockNumber, parsedTreeId, parsedLeafValue);
    if (!witness) {
      throw new Error(
        `Leaf ${leafValue} not found in the tree ${MerkleTreeId[parsedTreeId]} at block ${parsedBlockNumber}.`,
      );
    }
    return witness.map(toACVMField);
  }

  async getNullifierMembershipWitness(
    [blockNumber]: ACVMField[],
    [nullifier]: ACVMField[], // nullifier, we try to find the witness for (to prove inclusion)
  ): Promise<ACVMField[]> {
    const parsedBlockNumber = frToNumber(fromACVMField(blockNumber));
    const parsedNullifier = fromACVMField(nullifier);

    const witness = await this.typedOracle.getNullifierMembershipWitness(parsedBlockNumber, parsedNullifier);
    if (!witness) {
      throw new Error(`Nullifier witness not found for nullifier ${parsedNullifier} at block ${parsedBlockNumber}.`);
    }
    return witness.toFields().map(toACVMField);
  }

  async getLowNullifierMembershipWitness(
    [blockNumber]: ACVMField[],
    [nullifier]: ACVMField[], // nullifier, we try to find the low nullifier witness for (to prove non-inclusion)
  ): Promise<ACVMField[]> {
    const parsedBlockNumber = frToNumber(fromACVMField(blockNumber));
    const parsedNullifier = fromACVMField(nullifier);

    const witness = await this.typedOracle.getLowNullifierMembershipWitness(parsedBlockNumber, parsedNullifier);
    if (!witness) {
      throw new Error(
        `Low nullifier witness not found for nullifier ${parsedNullifier} at block ${parsedBlockNumber}.`,
      );
    }
    return witness.toFields().map(toACVMField);
  }

  async getPublicDataTreeWitness([blockNumber]: ACVMField[], [leafSlot]: ACVMField[]): Promise<ACVMField[]> {
    const parsedBlockNumber = frToNumber(fromACVMField(blockNumber));
    const parsedLeafSlot = fromACVMField(leafSlot);

    const witness = await this.typedOracle.getPublicDataTreeWitness(parsedBlockNumber, parsedLeafSlot);
    if (!witness) {
      throw new Error(`Public data witness not found for slot ${parsedLeafSlot} at block ${parsedBlockNumber}.`);
    }
    return witness.toFields().map(toACVMField);
  }

  async getBlockHeader([blockNumber]: ACVMField[]): Promise<ACVMField[]> {
    const parsedBlockNumber = frToNumber(fromACVMField(blockNumber));

    const header = await this.typedOracle.getBlockHeader(parsedBlockNumber);
    if (!header) {
      throw new Error(`Block header not found for block ${parsedBlockNumber}.`);
    }
    return header.toFields().map(toACVMField);
  }

  async getAuthWitness([messageHash]: ACVMField[]): Promise<ACVMField[]> {
    const messageHashField = fromACVMField(messageHash);
    const witness = await this.typedOracle.getAuthWitness(messageHashField);
    if (!witness) {
      throw new Error(`Unknown auth witness for message hash ${messageHashField}`);
    }
    return witness.map(toACVMField);
  }

  async getPublicKeysAndPartialAddress([address]: ACVMField[]): Promise<ACVMField[]> {
    const parsedAddress = AztecAddress.fromField(fromACVMField(address));
    const { publicKeys, partialAddress } = await this.typedOracle.getCompleteAddress(parsedAddress);

    return [...publicKeys.toFields(), partialAddress].map(toACVMField);
  }

  async getNotes(
    [storageSlot]: ACVMField[],
    [numSelects]: ACVMField[],
    selectByIndexes: ACVMField[],
    selectByOffsets: ACVMField[],
    selectByLengths: ACVMField[],
    selectValues: ACVMField[],
    selectComparators: ACVMField[],
    sortByIndexes: ACVMField[],
    sortByOffsets: ACVMField[],
    sortByLengths: ACVMField[],
    sortOrder: ACVMField[],
    [limit]: ACVMField[],
    [offset]: ACVMField[],
    [status]: ACVMField[],
    [returnSize]: ACVMField[],
  ): Promise<ACVMField[]> {
    const noteDatas = await this.typedOracle.getNotes(
      fromACVMField(storageSlot),
      +numSelects,
      selectByIndexes.map(s => +s),
      selectByOffsets.map(s => +s),
      selectByLengths.map(s => +s),
      selectValues.map(fromACVMField),
      selectComparators.map(s => +s),
      sortByIndexes.map(s => +s),
      sortByOffsets.map(s => +s),
      sortByLengths.map(s => +s),
      sortOrder.map(s => +s),
      +limit,
      +offset,
      +status,
    );

    const noteLength = noteDatas?.[0]?.note.items.length ?? 0;
    if (!noteDatas.every(({ note }) => noteLength === note.items.length)) {
      throw new Error('Notes should all be the same length.');
    }

    const contractAddress = noteDatas[0]?.contractAddress ?? Fr.ZERO;

    // Values indicates whether the note is settled or transient.
    const noteTypes = {
      isSettled: new Fr(0),
      isTransient: new Fr(1),
    };
    const flattenData = noteDatas.flatMap(({ nonce, note, index }) => [
      nonce,
      index === undefined ? noteTypes.isTransient : noteTypes.isSettled,
      ...note.items,
    ]);

    const returnFieldSize = +returnSize;
    const returnData = [noteDatas.length, contractAddress, ...flattenData].map(v => toACVMField(v));
    if (returnData.length > returnFieldSize) {
      throw new Error(`Return data size too big. Maximum ${returnFieldSize} fields. Got ${flattenData.length}.`);
    }

    const paddedZeros = Array(returnFieldSize - returnData.length).fill(toACVMField(0));
    return returnData.concat(paddedZeros);
  }

  notifyCreatedNote(
    [storageSlot]: ACVMField[],
    [noteTypeId]: ACVMField[],
    note: ACVMField[],
    [noteHash]: ACVMField[],
    [counter]: ACVMField[],
  ): ACVMField {
    this.typedOracle.notifyCreatedNote(
      fromACVMField(storageSlot),
      NoteSelector.fromField(fromACVMField(noteTypeId)),
      note.map(fromACVMField),
      fromACVMField(noteHash),
      +counter,
    );
    return toACVMField(0);
  }

  async notifyNullifiedNote(
    [innerNullifier]: ACVMField[],
    [noteHash]: ACVMField[],
    [counter]: ACVMField[],
  ): Promise<ACVMField> {
    await this.typedOracle.notifyNullifiedNote(fromACVMField(innerNullifier), fromACVMField(noteHash), +counter);
    return toACVMField(0);
  }

  async notifyCreatedNullifier([innerNullifier]: ACVMField[]): Promise<ACVMField> {
    await this.typedOracle.notifyCreatedNullifier(fromACVMField(innerNullifier));
    return toACVMField(0);
  }

  async checkNullifierExists([innerNullifier]: ACVMField[]): Promise<ACVMField> {
    const exists = await this.typedOracle.checkNullifierExists(fromACVMField(innerNullifier));
    return toACVMField(exists);
  }

  async getL1ToL2MembershipWitness(
    [contractAddress]: ACVMField[],
    [messageHash]: ACVMField[],
    [secret]: ACVMField[],
  ): Promise<ACVMField[]> {
    const message = await this.typedOracle.getL1ToL2MembershipWitness(
      AztecAddress.fromString(contractAddress),
      fromACVMField(messageHash),
      fromACVMField(secret),
    );
    return message.toFields().map(toACVMField);
  }

  async storageRead(
    [contractAddress]: ACVMField[],
    [startStorageSlot]: ACVMField[],
    [blockNumber]: ACVMField[],
    [numberOfElements]: ACVMField[],
  ): Promise<ACVMField[]> {
    const values = await this.typedOracle.storageRead(
      new AztecAddress(fromACVMField(contractAddress)),
      fromACVMField(startStorageSlot),
      +blockNumber,
      +numberOfElements,
    );
    return values.map(toACVMField);
  }

  async storageWrite([startStorageSlot]: ACVMField[], values: ACVMField[]): Promise<ACVMField[]> {
    const newValues = await this.typedOracle.storageWrite(fromACVMField(startStorageSlot), values.map(fromACVMField));
    return newValues.map(toACVMField);
  }

  notifyCreatedContractClassLog([contractAddress]: ACVMField[], message: ACVMField[], [counter]: ACVMField[]): void {
    const logPayload = message.map(fromACVMField);
    const log = new ContractClassLog(new AztecAddress(fromACVMField(contractAddress)), logPayload);

    this.typedOracle.notifyCreatedContractClassLog(log, +counter);
  }

  debugLog(message: ACVMField[], _ignoredFieldsSize: ACVMField[], fields: ACVMField[]): void {
    const messageStr = message.map(acvmField => String.fromCharCode(fromACVMField(acvmField).toNumber())).join('');
    const fieldsFr = fields.map(fromACVMField);
    this.typedOracle.debugLog(messageStr, fieldsFr);
  }

  async callPrivateFunction(
    [contractAddress]: ACVMField[],
    [functionSelector]: ACVMField[],
    [argsHash]: ACVMField[],
    [sideEffectCounter]: ACVMField[],
    [isStaticCall]: ACVMField[],
  ): Promise<ACVMField[]> {
    const { endSideEffectCounter, returnsHash } = await this.typedOracle.callPrivateFunction(
      AztecAddress.fromField(fromACVMField(contractAddress)),
      FunctionSelector.fromField(fromACVMField(functionSelector)),
      fromACVMField(argsHash),
      frToNumber(fromACVMField(sideEffectCounter)),
      frToBoolean(fromACVMField(isStaticCall)),
    );
    return [endSideEffectCounter, returnsHash].map(toACVMField);
  }

  async enqueuePublicFunctionCall(
    [contractAddress]: ACVMField[],
    [functionSelector]: ACVMField[],
    [argsHash]: ACVMField[],
    [sideEffectCounter]: ACVMField[],
    [isStaticCall]: ACVMField[],
  ): Promise<ACVMField> {
    const newArgsHash = await this.typedOracle.enqueuePublicFunctionCall(
      AztecAddress.fromString(contractAddress),
      FunctionSelector.fromField(fromACVMField(functionSelector)),
      fromACVMField(argsHash),
      frToNumber(fromACVMField(sideEffectCounter)),
      frToBoolean(fromACVMField(isStaticCall)),
    );
    return toACVMField(newArgsHash);
  }

  async setPublicTeardownFunctionCall(
    [contractAddress]: ACVMField[],
    [functionSelector]: ACVMField[],
    [argsHash]: ACVMField[],
    [sideEffectCounter]: ACVMField[],
    [isStaticCall]: ACVMField[],
  ): Promise<ACVMField> {
    const newArgsHash = await this.typedOracle.setPublicTeardownFunctionCall(
      AztecAddress.fromString(contractAddress),
      FunctionSelector.fromField(fromACVMField(functionSelector)),
      fromACVMField(argsHash),
      frToNumber(fromACVMField(sideEffectCounter)),
      frToBoolean(fromACVMField(isStaticCall)),
    );
    return toACVMField(newArgsHash);
  }

  notifySetMinRevertibleSideEffectCounter([minRevertibleSideEffectCounter]: ACVMField[]) {
    this.typedOracle.notifySetMinRevertibleSideEffectCounter(frToNumber(fromACVMField(minRevertibleSideEffectCounter)));
  }

  async getIndexedTaggingSecretAsSender([sender]: ACVMField[], [recipient]: ACVMField[]): Promise<ACVMField[]> {
    const taggingSecret = await this.typedOracle.getIndexedTaggingSecretAsSender(
      AztecAddress.fromString(sender),
      AztecAddress.fromString(recipient),
    );
    return taggingSecret.toFields().map(toACVMField);
  }

  async incrementAppTaggingSecretIndexAsSender([sender]: ACVMField[], [recipient]: ACVMField[]) {
    await this.typedOracle.incrementAppTaggingSecretIndexAsSender(
      AztecAddress.fromString(sender),
      AztecAddress.fromString(recipient),
    );
  }

  async syncNotes() {
    await this.typedOracle.syncNotes();
  }

  async deliverNote(
    [contractAddress]: ACVMField[],
    [storageSlot]: ACVMField[],
    [nonce]: ACVMField[],
    content: ACVMField[],
    [contentLength]: ACVMField[],
    [noteHash]: ACVMField[],
    [nullifier]: ACVMField[],
    [txHash]: ACVMField[],
    [recipient]: ACVMField[],
  ): Promise<ACVMField> {
    // TODO(#10728): try-catch this block and return false if we get an exception so that the contract can decide what
    // to do if a note fails delivery (e.g. not increment the tagging index, or add it to some pending work list).
    // Delivery might fail due to temporary issues, such as poor node connectivity.
    await this.typedOracle.deliverNote(
      AztecAddress.fromString(contractAddress),
      fromACVMField(storageSlot),
      fromACVMField(nonce),
      fromBoundedVec(content, contentLength),
      fromACVMField(noteHash),
      fromACVMField(nullifier),
      fromACVMField(txHash),
      AztecAddress.fromString(recipient),
    );

    return toACVMField(true);
  }

  async getLogByTag([tag]: ACVMField[]): Promise<(ACVMField | ACVMField[])[]> {
    const log = await this.typedOracle.getLogByTag(fromACVMField(tag));

    if (log == null) {
      return [toACVMField(0), ...LogWithTxData.noirSerializationOfEmpty().map(toACVMFieldSingleOrArray)];
    } else {
      return [toACVMField(1), ...log.toNoirSerialization().map(toACVMFieldSingleOrArray)];
    }
  }

  async storeCapsule([contractAddress]: ACVMField[], [slot]: ACVMField[], capsule: ACVMField[]) {
    await this.typedOracle.storeCapsule(
      AztecAddress.fromField(fromACVMField(contractAddress)),
      fromACVMField(slot),
      capsule.map(fromACVMField),
    );
  }

  async loadCapsule(
    [contractAddress]: ACVMField[],
    [slot]: ACVMField[],
    [tSize]: ACVMField[],
  ): Promise<(ACVMField | ACVMField[])[]> {
    const values = await this.typedOracle.loadCapsule(
      AztecAddress.fromField(fromACVMField(contractAddress)),
      fromACVMField(slot),
    );

    // We are going to return a Noir Option struct to represent the possibility of null values. Options are a struct
    // with two fields: `some` (a boolean) and `value` (a field array in this case).
    if (values === null) {
      // No data was found so we set `some` to 0 and pad `value` with zeros get the correct return size.
      return [toACVMField(0), Array(frToNumber(fromACVMField(tSize))).fill(toACVMField(0))];
    } else {
      // Data was found so we set `some` to 1 and return it along with `value`.
      return [toACVMField(1), values.map(toACVMField)];
    }
  }

  async deleteCapsule([contractAddress]: ACVMField[], [slot]: ACVMField[]) {
    await this.typedOracle.deleteCapsule(AztecAddress.fromField(fromACVMField(contractAddress)), fromACVMField(slot));
  }

  async copyCapsule(
    [contractAddress]: ACVMField[],
    [srcSlot]: ACVMField[],
    [dstSlot]: ACVMField[],
    [numEntries]: ACVMField[],
  ) {
    await this.typedOracle.copyCapsule(
      AztecAddress.fromField(fromACVMField(contractAddress)),
      fromACVMField(srcSlot),
      fromACVMField(dstSlot),
      frToNumber(fromACVMField(numEntries)),
    );
  }

  async aes128Decrypt(
    ciphertextBVecStorage: ACVMField[],
    [ciphertextLength]: ACVMField[],
    iv: ACVMField[],
    symKey: ACVMField[],
  ): Promise<(ACVMField | ACVMField[])[]> {
    const ciphertext = fromUintBoundedVec(ciphertextBVecStorage, ciphertextLength, 8);
    const ivBuffer = fromUintArray(iv, 8);
    const symKeyBuffer = fromUintArray(symKey, 8);

    const plaintext = await this.typedOracle.aes128Decrypt(ciphertext, ivBuffer, symKeyBuffer);
    return bufferToBoundedVec(plaintext, ciphertextBVecStorage.length);
  }

  async getSharedSecret(
    [address]: ACVMField[],
    [ephPKField0]: ACVMField[],
    [ephPKField1]: ACVMField[],
    [ephPKField2]: ACVMField[],
  ): Promise<ACVMField[]> {
    const secret = await this.typedOracle.getSharedSecret(
      AztecAddress.fromField(fromACVMField(address)),
      Point.fromFields([ephPKField0, ephPKField1, ephPKField2].map(fromACVMField)),
    );
    return secret.toFields().map(toACVMField);
  }
}
