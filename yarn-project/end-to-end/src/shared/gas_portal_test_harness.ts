import {
  type AztecAddress,
  type AztecNode,
  EthAddress,
  Fr,
  L1FeeJuicePortalManager,
  type L1TokenManager,
  type L2AmountClaim,
  type Logger,
  type PXE,
  type Wallet,
  retryUntil,
} from '@aztec/aztec.js';
import type { ViemPublicClient, ViemWalletClient } from '@aztec/ethereum';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import type { AztecNodeAdmin } from '@aztec/stdlib/interfaces/client';

export interface IGasBridgingTestHarness {
  getL1FeeJuiceBalance(address: EthAddress): Promise<bigint>;
  prepareTokensOnL1(bridgeAmount: bigint, owner: AztecAddress): Promise<L2AmountClaim>;
  bridgeFromL1ToL2(bridgeAmount: bigint, owner: AztecAddress): Promise<void>;
  feeJuice: FeeJuiceContract;
  l1FeeJuiceAddress: EthAddress;
}

export interface FeeJuicePortalTestingHarnessFactoryConfig {
  aztecNode: AztecNode;
  aztecNodeAdmin?: AztecNodeAdmin;
  pxeService: PXE;
  publicClient: ViemPublicClient;
  walletClient: ViemWalletClient;
  wallet: Wallet;
  logger: Logger;
  mockL1?: boolean;
}

export class FeeJuicePortalTestingHarnessFactory {
  private constructor(private config: FeeJuicePortalTestingHarnessFactoryConfig) {}

  private async createReal() {
    const { aztecNode, aztecNodeAdmin, pxeService, publicClient, walletClient, wallet, logger } = this.config;

    const ethAccount = EthAddress.fromString((await walletClient.getAddresses())[0]);
    const l1ContractAddresses = (await pxeService.getNodeInfo()).l1ContractAddresses;

    const feeJuiceAddress = l1ContractAddresses.feeJuiceAddress;
    const feeJuicePortalAddress = l1ContractAddresses.feeJuicePortalAddress;

    if (feeJuiceAddress.isZero() || feeJuicePortalAddress.isZero()) {
      throw new Error('Fee Juice portal not deployed on L1');
    }

    const gasL2 = await FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, wallet);

    return new GasBridgingTestHarness(
      aztecNode,
      aztecNodeAdmin,
      pxeService,
      logger,
      gasL2,
      ethAccount,
      feeJuicePortalAddress,
      feeJuiceAddress,
      publicClient,
      walletClient,
    );
  }

  static create(config: FeeJuicePortalTestingHarnessFactoryConfig): Promise<GasBridgingTestHarness> {
    const factory = new FeeJuicePortalTestingHarnessFactory(config);
    return factory.createReal();
  }
}

/**
 * A Class for testing cross chain interactions, contains common interactions
 * shared between cross chain tests.
 */
export class GasBridgingTestHarness implements IGasBridgingTestHarness {
  public readonly l1TokenManager: L1TokenManager;
  public readonly feeJuicePortalManager: L1FeeJuicePortalManager;

  constructor(
    /** Aztec node */
    public aztecNode: AztecNode,
    /** Aztec node admin interface */
    public aztecNodeAdmin: AztecNodeAdmin | undefined,
    /** Private eXecution Environment (PXE). */
    public pxeService: PXE,
    /** Logger. */
    public logger: Logger,

    /** L2 Token/Bridge contract. */
    public feeJuice: FeeJuiceContract,

    /** Eth account to interact with. */
    public ethAccount: EthAddress,

    /** Portal address. */
    public feeJuicePortalAddress: EthAddress,
    /** Underlying token for portal tests. */
    public l1FeeJuiceAddress: EthAddress,
    /** Viem Public client instance. */
    public publicClient: ViemPublicClient,
    /** Viem Wallet Client instance. */
    public walletClient: ViemWalletClient,
  ) {
    this.feeJuicePortalManager = new L1FeeJuicePortalManager(
      this.feeJuicePortalAddress,
      this.l1FeeJuiceAddress,
      this.publicClient,
      this.walletClient,
      this.logger,
    );

    this.l1TokenManager = this.feeJuicePortalManager.getTokenManager();
  }

  async mintTokensOnL1(amount: bigint, to: EthAddress = this.ethAccount) {
    const balanceBefore = await this.l1TokenManager.getL1TokenBalance(to.toString());
    await this.l1TokenManager.mint(amount, to.toString());
    expect(await this.l1TokenManager.getL1TokenBalance(to.toString())).toEqual(balanceBefore + amount);
  }

  async getL1FeeJuiceBalance(address: EthAddress) {
    return await this.l1TokenManager.getL1TokenBalance(address.toString());
  }

  sendTokensToPortalPublic(bridgeAmount: bigint, l2Address: AztecAddress, mint = false) {
    return this.feeJuicePortalManager.bridgeTokensPublic(l2Address, bridgeAmount, mint);
  }

  async consumeMessageOnAztecAndClaimPrivately(owner: AztecAddress, claim: L2AmountClaim) {
    this.logger.info('Consuming messages on L2 Privately');
    const { claimAmount, claimSecret, messageLeafIndex } = claim;
    await this.feeJuice.methods.claim(owner, claimAmount, claimSecret, messageLeafIndex).send().wait();
  }

  async getL2PublicBalanceOf(owner: AztecAddress) {
    return await this.feeJuice.methods.balance_of_public(owner).simulate();
  }

  async expectPublicBalanceOnL2(owner: AztecAddress, expectedBalance: bigint) {
    const balance = await this.getL2PublicBalanceOf(owner);
    expect(balance).toBe(expectedBalance);
  }

  async prepareTokensOnL1(bridgeAmount: bigint, owner: AztecAddress) {
    const claim = await this.sendTokensToPortalPublic(bridgeAmount, owner, true);

    const isSynced = async () => await this.aztecNode.isL1ToL2MessageSynced(Fr.fromHexString(claim.messageHash));
    await retryUntil(isSynced, `message ${claim.messageHash} sync`, 24, 1);

    // Progress by 2 L2 blocks so that the l1ToL2Message added above will be available to use on L2.
    await this.advanceL2Block();
    await this.advanceL2Block();

    return claim;
  }

  async bridgeFromL1ToL2(bridgeAmount: bigint, owner: AztecAddress) {
    // Prepare the tokens on the L1 side
    const claim = await this.prepareTokensOnL1(bridgeAmount, owner);

    // Consume L1 -> L2 message and claim tokens privately on L2
    await this.consumeMessageOnAztecAndClaimPrivately(owner, claim);
    await this.expectPublicBalanceOnL2(owner, bridgeAmount);
  }

  private async advanceL2Block() {
    const initialBlockNumber = await this.aztecNode.getBlockNumber();
    await this.aztecNodeAdmin?.flushTxs();
    await retryUntil(async () => (await this.aztecNode.getBlockNumber()) >= initialBlockNumber + 1);
  }
}
// docs:end:cross_chain_test_harness
