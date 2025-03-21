import type { Fr } from '@aztec/foundation/fields';
import {
  type AvmExecutionHints,
  type ContractStorageRead,
  type ContractStorageUpdateRequest,
  PublicCallStackItemCompressed,
  type PublicDataUpdateRequest,
  PublicInnerCallRequest,
  RevertCode,
} from '@aztec/stdlib/avm';
import type { SimulationError } from '@aztec/stdlib/errors';
import { Gas } from '@aztec/stdlib/gas';
import { computeVarArgsHash } from '@aztec/stdlib/hash';
import type { NoteHash, Nullifier, ReadRequest, TreeLeafReadRequest } from '@aztec/stdlib/kernel';
import type { PublicLog } from '@aztec/stdlib/logs';
import type { L2ToL1Message, ScopedL2ToL1Message } from '@aztec/stdlib/messaging';
import type { PublicExecutionRequest } from '@aztec/stdlib/tx';

export interface PublicSideEffects {
  /** The contract storage update requests performed. */
  publicDataWrites: PublicDataUpdateRequest[];
  /** The new note hashes to be inserted into the note hashes tree. */
  noteHashes: NoteHash[];
  /** The new nullifiers to be inserted into the nullifier tree. */
  nullifiers: Nullifier[];
  /** The new l2 to l1 messages generated to be inserted into the messages tree. */
  l2ToL1Messages: ScopedL2ToL1Message[];
  /** Public logs emitted during execution. */
  publicLogs: PublicLog[];
}

export interface EnqueuedPublicCallExecutionResult {
  /** How much gas was left after this public execution. */
  endGasLeft: Gas;
  /** The side effect counter after execution */
  endSideEffectCounter: Fr;

  /** The return values of the function. */
  returnValues: Fr[];
  /** Whether the execution reverted. */
  reverted: boolean;
  /** The revert reason if the execution reverted. */
  revertReason?: SimulationError;
}

export interface EnqueuedPublicCallExecutionResultWithSideEffects {
  /** How much gas was left after this public execution. */
  endGasLeft: Gas;
  /** The side effect counter after execution */
  endSideEffectCounter: Fr;

  /** The return values of the function. */
  returnValues: Fr[];
  /** Whether the execution reverted. */
  reverted: boolean;
  /** The revert reason if the execution reverted. */
  revertReason?: SimulationError;

  /** The public side effects of the function. */
  sideEffects: PublicSideEffects;
}

/**
 * The public function execution result.
 */
export interface PublicFunctionCallResult {
  /** The execution request that triggered this result. */
  executionRequest: PublicExecutionRequest;

  /** The side effect counter at the start of the function call. */
  startSideEffectCounter: Fr;
  /** The side effect counter after executing this function call */
  endSideEffectCounter: Fr;
  /** How much gas was available for this public execution. */
  startGasLeft: Gas;
  /** How much gas was left after this public execution. */
  endGasLeft: Gas;
  /** Transaction fee set for this tx. */
  transactionFee: Fr;

  /** Bytecode used for this execution. */
  bytecode?: Buffer;
  /** Calldata used for this execution. */
  calldata: Fr[];
  /** The return values of the function. */
  returnValues: Fr[];
  /** Whether the execution reverted. */
  reverted: boolean;
  /** The revert reason if the execution reverted. */
  revertReason?: SimulationError;

  /** The contract storage reads performed by the function. */
  contractStorageReads: ContractStorageRead[];
  /** The contract storage update requests performed by the function. */
  contractStorageUpdateRequests: ContractStorageUpdateRequest[];
  /** The new note hashes to be inserted into the note hashes tree. */
  noteHashes: NoteHash[];
  /** The new l2 to l1 messages generated in this call. */
  l2ToL1Messages: L2ToL1Message[];
  /** The new nullifiers to be inserted into the nullifier tree. */
  nullifiers: Nullifier[];
  /** The note hash read requests emitted in this call. */
  noteHashReadRequests: TreeLeafReadRequest[];
  /** The nullifier read requests emitted in this call. */
  nullifierReadRequests: ReadRequest[];
  /** The nullifier non existent read requests emitted in this call. */
  nullifierNonExistentReadRequests: ReadRequest[];
  /** L1 to L2 message read requests emitted in this call. */
  l1ToL2MsgReadRequests: TreeLeafReadRequest[];
  /**
   * The public logs emitted in this call.
   * Note: PublicLog has no counter - unsure if this is needed bc this struct is unused
   */
  publicLogs: PublicLog[];
  /** The requests to call public functions made by this call. */
  publicCallRequests: PublicInnerCallRequest[];
  /** The results of nested calls. */
  nestedExecutions: this[];

  /** Hints for proving AVM execution. */
  avmCircuitHints: AvmExecutionHints;

  /** The name of the function that was executed. Only used for logging. */
  functionName: string;
}

export async function resultToPublicCallRequest(result: PublicFunctionCallResult) {
  const request = result.executionRequest;
  const item = new PublicCallStackItemCompressed(
    request.callContext.contractAddress,
    request.callContext,
    await computeVarArgsHash(request.args),
    await computeVarArgsHash(result.returnValues),
    // TODO(@just-mitch): need better mapping from simulator to revert code.
    result.reverted ? RevertCode.APP_LOGIC_REVERTED : RevertCode.OK,
    Gas.from(result.startGasLeft),
    Gas.from(result.endGasLeft),
  );
  return new PublicInnerCallRequest(item, result.startSideEffectCounter.toNumber());
}
