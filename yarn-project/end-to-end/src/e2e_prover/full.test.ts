import { type AztecAddress, EthAddress } from '@aztec/aztec.js';
import { parseBooleanEnv } from '@aztec/foundation/config';
import { getTestData, isGenerateTestDataEnabled } from '@aztec/foundation/testing';
import { updateProtocolCircuitSampleInputs } from '@aztec/foundation/testing/files';
import { FeeJuicePortalAbi, RewardDistributorAbi, RollupAbi, TestERC20Abi } from '@aztec/l1-artifacts';

import TOML from '@iarna/toml';
import '@jest/globals';
import { type Chain, type GetContractReturnType, type HttpTransport, type PublicClient, getContract } from 'viem';

import { FullProverTest } from './e2e_prover_test.js';

// Set a very long 20 minute timeout.
const TIMEOUT = 1_200_000;

// This makes AVM proving throw if there's a failure.
process.env.AVM_PROVING_STRICT = '1';

describe('full_prover', () => {
  const REAL_PROOFS = !parseBooleanEnv(process.env.FAKE_PROOFS);
  const COINBASE_ADDRESS = EthAddress.random();
  const t = new FullProverTest('full_prover', 1, COINBASE_ADDRESS, REAL_PROOFS);

  let { provenAssets, accounts, tokenSim, logger, cheatCodes } = t;
  let sender: AztecAddress;
  let recipient: AztecAddress;

  let rollup: GetContractReturnType<typeof RollupAbi, PublicClient<HttpTransport, Chain>>;
  let rewardDistributor: GetContractReturnType<typeof RewardDistributorAbi, PublicClient<HttpTransport, Chain>>;
  let feeJuiceToken: GetContractReturnType<typeof TestERC20Abi, PublicClient<HttpTransport, Chain>>;
  let feeJuicePortal: GetContractReturnType<typeof FeeJuicePortalAbi, PublicClient<HttpTransport, Chain>>;

  beforeAll(async () => {
    t.logger.warn(`Running suite with ${REAL_PROOFS ? 'real' : 'fake'} proofs`);

    await t.applyBaseSnapshots();
    await t.applyMintSnapshot();
    await t.setup();
    await t.deployVerifier();

    ({ provenAssets, accounts, tokenSim, logger, cheatCodes } = t);
    [sender, recipient] = accounts.map(a => a.address);

    rollup = getContract({
      abi: RollupAbi,
      address: t.l1Contracts.l1ContractAddresses.rollupAddress.toString(),
      client: t.l1Contracts.publicClient,
    });

    rewardDistributor = getContract({
      abi: RewardDistributorAbi,
      address: t.l1Contracts.l1ContractAddresses.rewardDistributorAddress.toString(),
      client: t.l1Contracts.publicClient,
    });

    feeJuicePortal = getContract({
      abi: FeeJuicePortalAbi,
      address: t.l1Contracts.l1ContractAddresses.feeJuicePortalAddress.toString(),
      client: t.l1Contracts.publicClient,
    });

    feeJuiceToken = getContract({
      abi: TestERC20Abi,
      address: t.l1Contracts.l1ContractAddresses.feeJuiceAddress.toString(),
      client: t.l1Contracts.publicClient,
    });
  }, 120_000);

  afterAll(async () => {
    await t.teardown();
  });

  afterEach(async () => {
    await t.tokenSim.check();
  });

  it(
    'makes both public and private transfers',
    async () => {
      logger.info(`Starting test for public and private transfer`);

      const balance = await feeJuiceToken.read.balanceOf([feeJuicePortal.address]);
      logger.info(`Balance of fee juice token: ${balance}`);

      expect(balance).toBeGreaterThan(0n);

      const canonicalAddress = await feeJuicePortal.read.canonicalRollup();
      logger.info(`Canonical address: ${canonicalAddress}`);
      expect(canonicalAddress.toLowerCase()).toBe(
        t.l1Contracts.l1ContractAddresses.rollupAddress.toString().toLowerCase(),
      );

      // Create the two transactions
      const privateBalance = await provenAssets[0].methods.balance_of_private(sender).simulate();
      const privateSendAmount = privateBalance / 10n;
      expect(privateSendAmount).toBeGreaterThan(0n);
      const privateInteraction = provenAssets[0].methods.transfer(recipient, privateSendAmount);

      const publicBalance = await provenAssets[1].methods.balance_of_public(sender).simulate();
      const publicSendAmount = publicBalance / 10n;
      expect(publicSendAmount).toBeGreaterThan(0n);
      const publicInteraction = provenAssets[1].methods.transfer_in_public(sender, recipient, publicSendAmount, 0);

      // Prove them
      logger.info(`Proving txs`);
      const provingOpts = { skipPublicSimulation: true };
      const [publicProvenTx, privateProvenTx] = await Promise.all([
        publicInteraction.prove(provingOpts),
        privateInteraction.prove(provingOpts),
      ]);

      // Verify them
      logger.info(`Verifying txs`);
      await expect(t.circuitProofVerifier?.verifyProof(publicProvenTx)).resolves.not.toThrow();
      await expect(t.circuitProofVerifier?.verifyProof(privateProvenTx)).resolves.not.toThrow();

      // Sends the txs to node and awaits them to be mined separately, so they land on different blocks,
      // and we have more than one block in the epoch we end up proving
      logger.info(`Sending private tx`);
      const txPrivate = privateProvenTx.send();
      await txPrivate.wait({ timeout: 300, interval: 10, proven: false });

      logger.info(`Sending public tx`);
      const txPublic = publicProvenTx.send();
      await txPublic.wait({ timeout: 300, interval: 10, proven: false });

      logger.info(`Both txs have been mined`);
      const txs = [txPrivate, txPublic];

      // Flag the transfers on the token simulator
      tokenSim.transferPrivate(sender, recipient, privateSendAmount);
      tokenSim.transferPublic(sender, recipient, publicSendAmount);

      // Warp to the next epoch
      const epoch = await cheatCodes.rollup.getEpoch();
      logger.info(`Advancing from epoch ${epoch} to next epoch`);
      await cheatCodes.rollup.advanceToNextEpoch();

      const rewardsBeforeCoinbase = await rollup.read.getSequencerRewards([COINBASE_ADDRESS.toString()]);
      const rewardsBeforeProver = await rollup.read.getSpecificProverRewardsForEpoch([
        epoch,
        t.proverAddress.toString(),
      ]);
      const oldProvenBlockNumber = await rollup.read.getProvenBlockNumber();

      // And wait for the first pair of txs to be proven
      logger.info(`Awaiting proof for the previous epoch`);
      await Promise.all(txs.map(tx => tx.wait({ timeout: 300, interval: 10, proven: true, provenTimeout: 3000 })));

      const newProvenBlockNumber = await rollup.read.getProvenBlockNumber();
      expect(newProvenBlockNumber).toBeGreaterThan(oldProvenBlockNumber);
      expect(await rollup.read.getPendingBlockNumber()).toBe(newProvenBlockNumber);

      logger.info(`checking rewards for coinbase: ${COINBASE_ADDRESS.toString()}`);
      const rewardsAfterCoinbase = await rollup.read.getSequencerRewards([COINBASE_ADDRESS.toString()]);
      expect(rewardsAfterCoinbase).toBeGreaterThan(rewardsBeforeCoinbase);

      const rewardsAfterProver = await rollup.read.getSpecificProverRewardsForEpoch([
        epoch,
        t.proverAddress.toString(),
      ]);
      expect(rewardsAfterProver).toBeGreaterThan(rewardsBeforeProver);

      const blockReward = (await rewardDistributor.read.BLOCK_REWARD()) as bigint;
      const fees = (
        await Promise.all([
          t.aztecNode.getBlock(Number(newProvenBlockNumber - 1n)),
          t.aztecNode.getBlock(Number(newProvenBlockNumber)),
        ])
      ).map(b => b!.header.totalFees.toBigInt());

      const totalRewards = fees.map(fee => fee + blockReward).reduce((acc, reward) => acc + reward, 0n);
      const sequencerGain = rewardsAfterCoinbase - rewardsBeforeCoinbase;
      const proverGain = rewardsAfterProver - rewardsBeforeProver;

      // May be less than totalRewards due to burn.
      expect(sequencerGain + proverGain).toBeLessThanOrEqual(totalRewards);
    },
    TIMEOUT,
  );

  it('generates sample Prover.toml files if generate test data is on', async () => {
    if (!isGenerateTestDataEnabled() || REAL_PROOFS) {
      return;
    }

    // Create the two transactions
    const privateBalance = await provenAssets[0].methods.balance_of_private(sender).simulate();
    const privateSendAmount = privateBalance / 20n;
    expect(privateSendAmount).toBeGreaterThan(0n);
    const firstPrivateInteraction = provenAssets[0].methods.transfer(recipient, privateSendAmount);

    const publicBalance = await provenAssets[1].methods.balance_of_public(sender).simulate();
    const publicSendAmount = publicBalance / 10n;
    expect(publicSendAmount).toBeGreaterThan(0n);
    const publicInteraction = provenAssets[1].methods.transfer_in_public(sender, recipient, publicSendAmount, 0);

    // Prove them
    logger.info(`Proving txs`);
    const provingOpts = { skipPublicSimulation: true };
    const [publicProvenTx, firstPrivateProvenTx] = await Promise.all([
      publicInteraction.prove(provingOpts),
      firstPrivateInteraction.prove(provingOpts),
    ]);

    // Sends the txs to node and awaits them to be mined separately, so they land on different blocks,
    // and we have more than one block in the epoch we end up proving
    logger.info(`Sending private txs`);
    // First block, one private tx
    const firstTxPrivate = firstPrivateProvenTx.send();
    await firstTxPrivate.wait({ timeout: 300, interval: 10, proven: false });

    // Create and send a set of 3 txs for the second block,
    // so we end up with three blocks and have merge and block-merge circuits
    const secondBlockInteractions = [
      provenAssets[0].methods.transfer(recipient, privateSendAmount),
      provenAssets[0].methods.set_admin(sender),
      provenAssets[1].methods.transfer_in_public(sender, recipient, publicSendAmount, 0),
    ];
    const secondBlockProvenTxs = await Promise.all(secondBlockInteractions.map(p => p.prove(provingOpts)));
    const secondBlockTxs = await Promise.all(secondBlockProvenTxs.map(p => p.send()));
    await Promise.all(secondBlockTxs.map(t => t.wait({ timeout: 300, interval: 10, proven: false })));

    logger.info(`Sending public tx`);
    // Third block, one public tx
    const txPublic = publicProvenTx.send();
    await txPublic.wait({ timeout: 300, interval: 10, proven: false });

    logger.info(`All txs have been mined`);
    const txs = [firstTxPrivate, ...secondBlockTxs, txPublic];

    // Flag the transfers on the token simulator
    tokenSim.transferPrivate(sender, recipient, privateSendAmount);
    tokenSim.transferPrivate(sender, recipient, privateSendAmount);
    tokenSim.transferPublic(sender, recipient, publicSendAmount);
    tokenSim.transferPublic(sender, recipient, publicSendAmount);

    // Warp to the next epoch
    const epoch = await cheatCodes.rollup.getEpoch();
    logger.info(`Advancing from epoch ${epoch} to next epoch`);
    await cheatCodes.rollup.advanceToNextEpoch();

    // And wait for the first pair of txs to be proven
    logger.info(`Awaiting proof for the previous epoch`);
    await Promise.all(txs.map(tx => tx.wait({ timeout: 300, interval: 10, proven: true, provenTimeout: 1500 })));

    [
      'private-kernel-init',
      'private-kernel-inner',
      'private-kernel-tail',
      'private-kernel-tail-to-public',
      'private-kernel-reset',
      'rollup-base-private',
      'rollup-base-public',
      'rollup-merge',
      'rollup-block-root',
      'rollup-block-merge',
      'rollup-root',
    ].forEach(circuitName => {
      const data = getTestData(circuitName);
      if (data) {
        updateProtocolCircuitSampleInputs(circuitName, TOML.stringify(data[0] as any));
      }
    });
  });

  it('rejects txs with invalid proofs', async () => {
    if (!REAL_PROOFS) {
      t.logger.warn(`Skipping test with fake proofs`);
      return;
    }

    const privateInteraction = t.fakeProofsAsset.methods.transfer(recipient, 1n);
    const publicInteraction = t.fakeProofsAsset.methods.transfer_in_public(sender, recipient, 1n, 0);

    const sentPrivateTx = privateInteraction.send({ skipPublicSimulation: true });
    const sentPublicTx = publicInteraction.send({ skipPublicSimulation: true });

    const results = await Promise.allSettled([
      sentPrivateTx.wait({ timeout: 10, interval: 0.1 }),
      sentPublicTx.wait({ timeout: 10, interval: 0.1 }),
    ]);

    expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(/Tx dropped by P2P node/);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/Tx dropped by P2P node/);
  });
});
