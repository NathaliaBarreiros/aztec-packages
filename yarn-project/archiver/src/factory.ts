import type { BlobSinkClientInterface } from '@aztec/blob-sink/client';
import { createLogger } from '@aztec/foundation/log';
import type { DataStoreConfig } from '@aztec/kv-store/config';
import { createStore } from '@aztec/kv-store/lmdb-v2';
import { TokenContractArtifact } from '@aztec/noir-contracts.js/Token';
import { TokenBridgeContractArtifact } from '@aztec/noir-contracts.js/TokenBridge';
import { getVKTreeRoot } from '@aztec/noir-protocol-circuits-types/vk-tree';
import { protocolContractNames, protocolContractTreeRoot } from '@aztec/protocol-contracts';
import { BundledProtocolContractsProvider } from '@aztec/protocol-contracts/providers/bundle';
import { FunctionType, decodeFunctionSignature } from '@aztec/stdlib/abi';
import type { L2BlockSourceEventEmitter } from '@aztec/stdlib/block';
import {
  type ContractClassPublic,
  computePublicBytecodeCommitment,
  getContractClassFromArtifact,
} from '@aztec/stdlib/contract';
import type { ArchiverApi, Service } from '@aztec/stdlib/interfaces/server';
import { getComponentsVersionsFromConfig } from '@aztec/stdlib/versioning';
import { type TelemetryClient, getTelemetryClient } from '@aztec/telemetry-client';

import { Archiver } from './archiver/archiver.js';
import type { ArchiverConfig } from './archiver/config.js';
import { KVArchiverDataStore } from './archiver/index.js';
import { createArchiverClient } from './rpc/index.js';

/**
 * Creates a local archiver.
 * @param config - The archiver configuration.
 * @param blobSinkClient - The blob sink client.
 * @param opts - The options.
 * @param telemetry - The telemetry client.
 * @returns The local archiver.
 */
export async function createArchiver(
  config: ArchiverConfig & DataStoreConfig,
  blobSinkClient: BlobSinkClientInterface,
  opts: { blockUntilSync: boolean } = { blockUntilSync: true },
  telemetry: TelemetryClient = getTelemetryClient(),
): Promise<ArchiverApi & Service & L2BlockSourceEventEmitter> {
  const store = await createStore(
    'archiver',
    KVArchiverDataStore.SCHEMA_VERSION,
    config,
    createLogger('archiver:lmdb'),
  );
  const archiverStore = new KVArchiverDataStore(store, config.maxLogs);
  await registerProtocolContracts(archiverStore);
  await registerCommonContracts(archiverStore);
  return Archiver.createAndSync(config, archiverStore, { telemetry, blobSinkClient }, opts.blockUntilSync);
}

/**
 * Creates a remote archiver client.
 * @param config - The archiver configuration.
 * @returns The remote archiver client.
 */
export function createRemoteArchiver(config: ArchiverConfig): ArchiverApi {
  if (!config.archiverUrl) {
    throw new Error('Archiver URL is required');
  }

  return createArchiverClient(
    config.archiverUrl,
    getComponentsVersionsFromConfig(config, protocolContractTreeRoot, getVKTreeRoot()),
  );
}

async function registerProtocolContracts(store: KVArchiverDataStore) {
  const blockNumber = 0;
  for (const name of protocolContractNames) {
    const provider = new BundledProtocolContractsProvider();
    const contract = await provider.getProtocolContractArtifact(name);
    const contractClassPublic: ContractClassPublic = {
      ...contract.contractClass,
      privateFunctions: [],
      unconstrainedFunctions: [],
    };

    const publicFunctionSignatures = contract.artifact.functions
      .filter(fn => fn.functionType === FunctionType.PUBLIC)
      .map(fn => decodeFunctionSignature(fn.name, fn.parameters));

    await store.registerContractFunctionSignatures(contract.address, publicFunctionSignatures);
    const bytecodeCommitment = await computePublicBytecodeCommitment(contractClassPublic.packedBytecode);
    await store.addContractClasses([contractClassPublic], [bytecodeCommitment], blockNumber);
    await store.addContractInstances([contract.instance], blockNumber);
  }
}

// TODO(#10007): Remove this method. We are explicitly registering these contracts
// here to ensure they are available to all nodes and all prover nodes, since the PXE
// was tweaked to automatically push contract classes to the node it is registered,
// but other nodes in the network may require the contract classes to be registered as well.
// TODO(#10007): Remove the dependency on noir-contracts.js from this package once we remove this.
async function registerCommonContracts(store: KVArchiverDataStore) {
  const blockNumber = 0;
  const artifacts = [TokenBridgeContractArtifact, TokenContractArtifact];
  const classes = await Promise.all(
    artifacts.map(async artifact => ({
      ...(await getContractClassFromArtifact(artifact)),
      privateFunctions: [],
      unconstrainedFunctions: [],
    })),
  );
  const bytecodeCommitments = await Promise.all(classes.map(x => computePublicBytecodeCommitment(x.packedBytecode)));
  await store.addContractClasses(classes, bytecodeCommitments, blockNumber);
}
