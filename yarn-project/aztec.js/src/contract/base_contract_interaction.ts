import type { Fr } from '@aztec/foundation/fields';
import { createLogger } from '@aztec/foundation/log';
import type { AuthWitness } from '@aztec/stdlib/auth-witness';
import { GasSettings } from '@aztec/stdlib/gas';
import type { Capsule, HashedValues, TxExecutionRequest, TxProvingResult } from '@aztec/stdlib/tx';

import type { Wallet } from '../account/wallet.js';
import type { ExecutionRequestInit } from '../entrypoint/entrypoint.js';
import type { FeeOptions, UserFeeOptions } from '../entrypoint/payload.js';
import { FeeJuicePaymentMethod } from '../fee/fee_juice_payment_method.js';
import { getGasLimits } from './get_gas_limits.js';
import { ProvenTx } from './proven_tx.js';
import { SentTx } from './sent_tx.js';

/**
 * Represents options for calling a (constrained) function in a contract.
 * Allows the user to specify the sender address and nonce for a transaction.
 */
export type SendMethodOptions = {
  /** Wether to skip the simulation of the public part of the transaction. */
  skipPublicSimulation?: boolean;
  /** The fee options for the transaction. */
  fee?: UserFeeOptions;
  /** Custom nonce to inject into the app payload of the transaction. Useful when trying to cancel an ongoing transaction by creating a new one with a higher fee */
  nonce?: Fr;
  /** Whether the transaction can be cancelled. If true, an extra nullifier will be emitted: H(nonce, GENERATOR_INDEX__TX_NULLIFIER) */
  cancellable?: boolean;
};

/**
 * Base class for an interaction with a contract, be it a deployment, a function call, or a batch.
 * Implements the sequence create/simulate/send.
 */
export abstract class BaseContractInteraction {
  protected log = createLogger('aztecjs:contract_interaction');

  protected authWitnesses: AuthWitness[] = [];
  protected hashedArguments: HashedValues[] = [];
  protected capsules: Capsule[] = [];

  constructor(protected wallet: Wallet) {}

  /**
   * Create a transaction execution request ready to be simulated.
   * @param options - An optional object containing additional configuration for the transaction.
   * @returns A transaction execution request.
   */
  public abstract create(options?: SendMethodOptions): Promise<TxExecutionRequest>;

  /**
   * Returns an execution request that represents this operation.
   * Can be used as a building block for constructing batch requests.
   * @param options - An optional object containing additional configuration for the transaction.
   * @returns An execution request wrapped in promise.
   */
  public abstract request(options?: SendMethodOptions): Promise<Omit<ExecutionRequestInit, 'fee'>>;

  /**
   * Creates a transaction execution request, simulates and proves it. Differs from .prove in
   * that its result does not include the wallet nor the composed tx object, but only the proving result.
   * This object can then be used to either create a ProvenTx ready to be sent, or directly send the transaction.
   * @param options - optional arguments to be used in the creation of the transaction
   * @returns The proving result.
   */
  protected async proveInternal(options: SendMethodOptions = {}): Promise<TxProvingResult> {
    const txRequest = await this.create(options);
    const txSimulationResult = await this.wallet.simulateTx(txRequest, !options.skipPublicSimulation, undefined, true);
    return await this.wallet.proveTx(txRequest, txSimulationResult.privateExecutionResult);
  }

  // docs:start:prove
  /**
   * Proves a transaction execution request and returns a tx object ready to be sent.
   * @param options - optional arguments to be used in the creation of the transaction
   * @returns The resulting transaction
   */
  public async prove(options: SendMethodOptions = {}): Promise<ProvenTx> {
    // docs:end:prove
    const txProvingResult = await this.proveInternal(options);
    return new ProvenTx(this.wallet, txProvingResult.toTx());
  }

  // docs:start:send
  /**
   * Sends a transaction to the contract function with the specified options.
   * This function throws an error if called on an unconstrained function.
   * It creates and signs the transaction if necessary, and returns a SentTx instance,
   * which can be used to track the transaction status, receipt, and events.
   * @param options - An optional object containing 'from' property representing
   * the AztecAddress of the sender. If not provided, the default address is used.
   * @returns A SentTx instance for tracking the transaction status and information.
   */
  public send(options: SendMethodOptions = {}): SentTx {
    // docs:end:send
    const promise = (async () => {
      const txProvingResult = await this.proveInternal(options);
      return this.wallet.sendTx(txProvingResult.toTx());
    })();
    return new SentTx(this.wallet, promise);
  }

  // docs:start:estimateGas
  /**
   * Estimates gas for a given tx request and returns gas limits for it.
   * @param opts - Options.
   * @param pad - Percentage to pad the suggested gas limits by, if empty, defaults to 10%.
   * @returns Gas limits.
   */
  public async estimateGas(
    opts?: Omit<SendMethodOptions, 'estimateGas' | 'skipPublicSimulation'>,
  ): Promise<Pick<GasSettings, 'gasLimits' | 'teardownGasLimits'>> {
    // docs:end:estimateGas
    const txRequest = await this.create({ ...opts, fee: { ...opts?.fee, estimateGas: false } });
    const simulationResult = await this.wallet.simulateTx(
      txRequest,
      true /*simulatePublic*/,
      undefined /* msgSender */,
      undefined /* skipTxValidation */,
      true /* skipFeeEnforcement */,
    );
    const { totalGas: gasLimits, teardownGas: teardownGasLimits } = getGasLimits(
      simulationResult,
      opts?.fee?.estimatedGasPadding,
    );
    return { gasLimits, teardownGasLimits };
  }

  /**
   * Returns default fee options based on the user opts without running a simulation for gas estimation.
   * @param fee - User-provided fee options.
   */
  protected async getDefaultFeeOptions(fee: UserFeeOptions | undefined): Promise<FeeOptions> {
    const maxFeesPerGas =
      fee?.gasSettings?.maxFeesPerGas ?? (await this.wallet.getCurrentBaseFees()).mul(1 + (fee?.baseFeePadding ?? 0.5));
    const paymentMethod = fee?.paymentMethod ?? new FeeJuicePaymentMethod(this.wallet.getAddress());
    const gasSettings: GasSettings = GasSettings.default({ ...fee?.gasSettings, maxFeesPerGas });
    this.log.debug(`Using L2 gas settings`, gasSettings);
    return { gasSettings, paymentMethod };
  }

  // docs:start:getFeeOptions
  /**
   * Return fee options based on the user opts, estimating tx gas if needed.
   * @param request - Request to execute for this interaction.
   * @param pad - Percentage to pad the suggested gas limits by, as decimal (e.g., 0.10 for 10%).
   * @returns Fee options for the actual transaction.
   */
  protected async getFeeOptions(
    request: Omit<ExecutionRequestInit, 'fee'> & { /** User-provided fee options */ fee?: UserFeeOptions },
  ): Promise<FeeOptions> {
    // docs:end:getFeeOptions
    const defaultFeeOptions = await this.getDefaultFeeOptions(request.fee);
    const paymentMethod = defaultFeeOptions.paymentMethod;
    const maxFeesPerGas = defaultFeeOptions.gasSettings.maxFeesPerGas;
    const maxPriorityFeesPerGas = defaultFeeOptions.gasSettings.maxPriorityFeesPerGas;

    let gasSettings = defaultFeeOptions.gasSettings;
    if (request.fee?.estimateGas) {
      const feeForEstimation: FeeOptions = { paymentMethod, gasSettings };
      const txRequest = await this.wallet.createTxExecutionRequest({ ...request, fee: feeForEstimation });
      const simulationResult = await this.wallet.simulateTx(
        txRequest,
        true /*simulatePublic*/,
        undefined /* msgSender */,
        undefined /* skipTxValidation */,
        true /* skipFeeEnforcement */,
      );
      const { totalGas: gasLimits, teardownGas: teardownGasLimits } = getGasLimits(
        simulationResult,
        request.fee?.estimatedGasPadding,
      );
      gasSettings = GasSettings.from({ maxFeesPerGas, maxPriorityFeesPerGas, gasLimits, teardownGasLimits });
      this.log.verbose(
        `Estimated gas limits for tx: DA=${gasLimits.daGas} L2=${gasLimits.l2Gas} teardownDA=${teardownGasLimits.daGas} teardownL2=${teardownGasLimits.l2Gas}`,
      );
    }

    return { gasSettings, paymentMethod };
  }

  /**
   * Add authWitness used in this contract interaction.
   * @param authWitness - authWitness used in the contract interaction.
   */
  public addAuthWitness(authWitness: AuthWitness) {
    this.authWitnesses.push(authWitness);
  }

  /**
   * Add authWitness used in this contract interaction.
   * @param authWitnesses - authWitnesses used in the contract interaction.
   */
  public addAuthWitnesses(authWitnesses: AuthWitness[]) {
    this.authWitnesses.push(...authWitnesses);
  }

  /**
   * Return all authWitnesses added for this interaction.
   */
  public getAuthWitnesses() {
    return this.authWitnesses;
  }

  /**
   * Add hashedArgument used in this contract interaction.
   * @param hashedArgument - hashedArgument used in the contract interaction.
   */
  public addHashedArgument(hashedArgument: HashedValues) {
    this.hashedArguments.push(hashedArgument);
  }

  /**
   * Add hashedArguments used in this contract interaction.
   * @param hashedArguments - hashedArguments used in the contract interaction.
   */
  public addHashedArguments(hashedArguments: HashedValues[]) {
    this.hashedArguments.push(...hashedArguments);
  }

  /**
   * Return all hashedArguments added for this interaction.
   */
  public getHashedArguments() {
    return this.hashedArguments;
  }

  /**
   * Add data passed to the oracle calls during this contract interaction.
   * @param capsule - Data passed to oracle calls.
   */
  public addCapsule(capsule: Capsule) {
    this.capsules.push(capsule);
  }

  /**
   * Add data passed to the oracle calls during this contract interaction.
   * @param capsules - Data passed to oracle calls.
   */
  public addCapsules(capsules: Capsule[]) {
    this.capsules.push(...capsules);
  }

  /**
   * Return all capsules added for this contract interaction.
   */
  public getCapsules() {
    return this.capsules;
  }
}
