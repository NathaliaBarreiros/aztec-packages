import { type ConfigMappingsType, getConfigFromMappings, numberConfigHelper } from '@aztec/foundation/config';

import { type L1ContractAddresses, l1ContractAddressesMapping } from './l1_contract_addresses.js';

/** Configuration of the L1GlobalReader. */
export interface L1ReaderConfig {
  /** The RPC Url of the ethereum host. */
  l1RpcUrls: string[];
  /** The chain ID of the ethereum host. */
  l1ChainId: number;
  /** The deployed l1 contract addresses */
  l1Contracts: L1ContractAddresses;
  /** The polling interval viem uses in ms */
  viemPollingIntervalMS: number;
}

export const l1ReaderConfigMappings: ConfigMappingsType<L1ReaderConfig> = {
  l1RpcUrls: {
    env: 'ETHEREUM_HOSTS',
    description: 'The RPC Url of the ethereum host.',
    parseEnv: (val: string) => val.split(',').map(url => url.trim()),
  },
  l1ChainId: {
    env: 'L1_CHAIN_ID',
    parseEnv: (val: string) => +val,
    defaultValue: 31337,
    description: 'The chain ID of the ethereum host.',
  },
  l1Contracts: {
    description: 'The deployed L1 contract addresses',
    nested: l1ContractAddressesMapping,
  },
  viemPollingIntervalMS: {
    env: 'L1_READER_VIEM_POLLING_INTERVAL_MS',
    description: 'The polling interval viem uses in ms',
    ...numberConfigHelper(1_000),
  },
};

export function getL1ReaderConfigFromEnv(): L1ReaderConfig {
  return getConfigFromMappings<L1ReaderConfig>(l1ReaderConfigMappings);
}
