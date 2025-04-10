/**
 * The `account` module provides utilities for managing accounts. The {@link AccountManager} class
 * allows to deploy and register a fresh account, or to obtain a `Wallet` instance out of an account
 * already deployed. Use the `@aztec/accounts` package to load default account implementations that rely
 * on ECDSA or Schnorr signatures.
 *
 * @packageDocumentation
 */
import type { Fr } from '@aztec/foundation/fields';

export { type AccountContract, getAccountContractAddress } from './account_contract.js';
export { type AccountInterface } from './interface.js';

/** A contract deployment salt. */
export type Salt = Fr | number | bigint;
