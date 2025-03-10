import type { Bufferable } from '@aztec/foundation/serialize';
import type { SiblingPath } from '@aztec/foundation/trees';

/**
 * Defines the interface for a source of sibling paths.
 */
export interface SiblingPathSource {
  /**
   * Returns the sibling path for a requested leaf index.
   * @param index - The index of the leaf for which a sibling path is required.
   * @param includeUncommitted - Set to true to include uncommitted updates in the sibling path.
   */
  getSiblingPath<N extends number>(index: bigint, includeUncommitted: boolean): Promise<SiblingPath<N>>;
}

/**
 * Defines the interface for a Merkle tree.
 */
export interface MerkleTree<T extends Bufferable = Buffer> extends SiblingPathSource {
  /**
   * Returns the current root of the tree.
   * @param includeUncommitted - Set to true to include uncommitted updates in the calculated root.
   */
  getRoot(includeUncommitted: boolean): Buffer;

  /**
   * Returns the number of leaves in the tree.
   * @param includeUncommitted - Set to true to include uncommitted updates in the returned value.
   */
  getNumLeaves(includeUncommitted: boolean): bigint;

  /**
   * Commit pending updates to the tree.
   */
  commit(): Promise<void>;

  /**
   * Returns the depth of the tree.
   */
  getDepth(): number;

  /**
   * Rollback pending update to the tree.
   */
  rollback(): Promise<void>;

  /**
   * Returns the value of a leaf at the specified index.
   * @param index - The index of the leaf value to be returned.
   * @param includeUncommitted - Set to true to include uncommitted updates in the data set.
   */
  getLeafValue(index: bigint, includeUncommitted: boolean): T | undefined;

  /**
   * Returns the index of a leaf given its value, or undefined if no leaf with that value is found.
   * @param leaf - The leaf value to look for.
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   * @returns The index of the first leaf found with a given value (undefined if not found).
   */
  findLeafIndex(leaf: T, includeUncommitted: boolean): bigint | undefined;

  /**
   * Returns the first index containing a leaf value after `startIndex`.
   * @param leaf - The leaf value to look for.
   * @param startIndex - The index to start searching from (used when skipping nullified messages)
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   * @returns The index of the first leaf found with a given value (undefined if not found).
   */
  findLeafIndexAfter(leaf: T, startIndex: bigint, includeUncommitted: boolean): bigint | undefined;
}
