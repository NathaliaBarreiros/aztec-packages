import type { Fr } from '@aztec/foundation/fields';
import type { FunctionCall } from '@aztec/stdlib/abi';
import type { AuthWitness } from '@aztec/stdlib/auth-witness';
import type { Capsule, HashedValues, TxExecutionRequest } from '@aztec/stdlib/tx';

import { EntrypointPayload, type FeeOptions, computeCombinedPayloadHash } from './payload.js';

export { EntrypointPayload, type FeeOptions, computeCombinedPayloadHash };

export { DefaultEntrypoint } from './default_entrypoint.js';
export { DefaultMultiCallEntrypoint } from './default_multi_call_entrypoint.js';

/** Encodes the calls to be done in a transaction. */
export type ExecutionRequestInit = {
  /** The function calls to be executed. */
  calls: FunctionCall[];
  /** Any transient auth witnesses needed for this execution */
  authWitnesses?: AuthWitness[];
  /** Any transient hashed arguments for this execution */
  hashedArguments?: HashedValues[];
  /** Data passed through an oracle for this execution. */
  capsules?: Capsule[];
  /** How the fee is going to be payed */
  fee: FeeOptions;
  /** An optional nonce. Used to repeat a previous tx with a higher fee so that the first one is cancelled */
  nonce?: Fr;
  /** Whether the transaction can be cancelled. If true, an extra nullifier will be emitted: H(nonce, GENERATOR_INDEX__TX_NULLIFIER) */
  cancellable?: boolean;
};

/**
 * Merges an array of ExecutionRequestInits.
 */
export function mergeExecutionRequestInits(
  requests: Pick<ExecutionRequestInit, 'calls' | 'authWitnesses' | 'hashedArguments' | 'capsules'>[],
  { nonce, cancellable }: Pick<ExecutionRequestInit, 'nonce' | 'cancellable'> = {},
): Omit<ExecutionRequestInit, 'fee'> {
  const calls = requests.map(r => r.calls).flat();
  const authWitnesses = requests.map(r => r.authWitnesses ?? []).flat();
  const hashedArguments = requests.map(r => r.hashedArguments ?? []).flat();
  const capsules = requests.map(r => r.capsules ?? []).flat();
  return {
    calls,
    authWitnesses,
    hashedArguments,
    capsules,
    nonce,
    cancellable,
  };
}

/** Creates transaction execution requests out of a set of function calls. */
export interface EntrypointInterface {
  /**
   * Generates an execution request out of set of function calls.
   * @param execution - The execution intents to be run.
   * @returns The authenticated transaction execution request.
   */
  createTxExecutionRequest(execution: ExecutionRequestInit): Promise<TxExecutionRequest>;
}
