import { Blob, BlobDeserializationError, type BlobJson } from '@aztec/blob-lib';
import { type Logger, createLogger } from '@aztec/foundation/log';
import { makeBackoff, retry } from '@aztec/foundation/retry';
import { bufferToHex } from '@aztec/foundation/string';

import { type RpcBlock, createPublicClient, fallback, http } from 'viem';

import { outboundTransform } from '../encoding/index.js';
import { type BlobSinkConfig, getBlobSinkConfigFromEnv } from './config.js';
import type { BlobSinkClientInterface } from './interface.js';

export class HttpBlobSinkClient implements BlobSinkClientInterface {
  private readonly log: Logger;
  private readonly config: BlobSinkConfig;
  private readonly fetch: typeof fetch;

  constructor(config?: BlobSinkConfig) {
    this.config = config ?? getBlobSinkConfigFromEnv();
    this.log = createLogger('aztec:blob-sink-client');
    this.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
      return await retry(
        () => fetch(...args),
        `Fetching ${args[0]}`,
        makeBackoff([1, 1, 3]),
        this.log,
        /*failSilently=*/ true,
      );
    };
  }

  public async sendBlobsToBlobSink(blockHash: string, blobs: Blob[]): Promise<boolean> {
    // TODO(md): for now we are assuming the indexes of the blobs will be 0, 1, 2
    // When in reality they will not, but for testing purposes this is fine
    // Right now we fetch everything, then filter out the blobs that we don't want
    if (!this.config.blobSinkUrl) {
      this.log.verbose('No blob sink url configured');
      return false;
    }

    this.log.verbose(`Sending ${blobs.length} blobs to blob sink`);
    try {
      const res = await this.fetch(`${this.config.blobSinkUrl}/blob_sidecar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // eslint-disable-next-line camelcase
          block_id: blockHash,
          // Snappy compress the blob buffer
          blobs: blobs.map((b, i) => ({ blob: outboundTransform(b.toBuffer()), index: i })),
        }),
      });

      if (res.ok) {
        return true;
      }

      this.log.error('Failed to send blobs to blob sink', { status: res.status });
      return false;
    } catch (err) {
      this.log.warn(`Blob sink url configured, but unable to send blobs`, {
        blobSinkUrl: this.config.blobSinkUrl,
        blockHash,
      });
      return false;
    }
  }

  /**
   * Get the blob sidecar
   *
   * If requesting from the blob sink, we send the blobkHash
   * If requesting from the beacon node, we send the slot number
   *
   * 1. First atttempts to get blobs from a configured blob sink
   * 2. If no blob sink is configured, attempts to get blobs from a configured consensus host
   *
   * 3. If none configured, fails
   *
   * @param blockHash - The block hash
   * @param indices - The indices of the blobs to get
   * @returns The blobs
   */
  public async getBlobSidecar(blockHash: `0x${string}`, blobHashes: Buffer[], indices?: number[]): Promise<Blob[]> {
    let blobs: Blob[] = [];

    const { blobSinkUrl, l1ConsensusHostUrl } = this.config;
    const ctx = { blockHash, blobHashes: blobHashes.map(bufferToHex), indices };

    if (blobSinkUrl) {
      blobs = await this.getBlobSidecarFrom(blobSinkUrl, blockHash, blobHashes, indices);
      this.log.debug(`Got ${blobs.length} blobs from blob sink`, { blobSinkUrl, ...ctx });
      if (blobs.length > 0) {
        return blobs;
      }
    }

    if (blobs.length == 0 && l1ConsensusHostUrl) {
      // The beacon api can query by slot number, so we get that first
      const slotNumber = await this.getSlotNumber(blockHash);
      this.log.debug(`Got slot number ${slotNumber} from consensus host for querying blobs`, {
        blockHash,
        l1ConsensusHostUrl,
      });
      if (slotNumber) {
        const blobs = await this.getBlobSidecarFrom(l1ConsensusHostUrl, slotNumber, blobHashes, indices);
        this.log.debug(`Got ${blobs.length} blobs from consensus host`, { l1ConsensusHostUrl, slotNumber, ...ctx });
        if (blobs.length > 0) {
          return blobs;
        }
      }
    }

    this.log.verbose('No blob sources available');
    return [];
  }

  public async getBlobSidecarFrom(
    hostUrl: string,
    blockHashOrSlot: string | number,
    blobHashes: Buffer[],
    indices?: number[],
    maxRetries = 10,
  ): Promise<Blob[]> {
    try {
      let baseUrl = `${hostUrl}/eth/v1/beacon/blob_sidecars/${blockHashOrSlot}`;
      if (indices && indices.length > 0) {
        baseUrl += `?indices=${indices.join(',')}`;
      }

      const { url, ...options } = getBeaconNodeFetchOptions(baseUrl, this.config);

      this.log.debug(`Fetching blob sidecar for ${blockHashOrSlot}`, { url, ...options });
      const res = await this.fetch(url, options);

      if (res.ok) {
        const body = await res.json();
        const blobs = await getRelevantBlobs(body.data, blobHashes, this.log);
        return blobs;
      } else if (res.status === 404) {
        // L1 slot may have been missed, try next few
        if (typeof blockHashOrSlot === 'number' && maxRetries > 0) {
          const nextSlot = Number(blockHashOrSlot) + 1;
          this.log.debug(`L1 slot ${blockHashOrSlot} not found, trying next slot ${nextSlot}`);
          return this.getBlobSidecarFrom(hostUrl, nextSlot, blobHashes, indices, maxRetries - 1);
        }
      }

      this.log.debug(`Unable to get blob sidecar for ${blockHashOrSlot}`, {
        status: res.status,
        statusText: res.statusText,
      });
      return [];
    } catch (err: any) {
      this.log.warn(`Unable to get blob sidecar from ${hostUrl}`, err.message);
      return [];
    }
  }

  /**
   * Get the slot number from the consensus host
   * As of eip-4788, the parentBeaconBlockRoot is included in the execution layer.
   * This allows us to query the consensus layer for the slot number of the parent block, which we will then use
   * to request blobs from the consensus layer.
   *
   * If this returns undefined, it means that we are not connected to a real consensus host, and we should
   * query blobs with the blockHash.
   *
   * If this returns a number, then we should query blobs with the slot number
   *
   * @param blockHash - The block hash
   * @returns The slot number
   */
  private async getSlotNumber(blockHash: `0x${string}`): Promise<number | undefined> {
    if (!this.config.l1ConsensusHostUrl) {
      this.log.debug('No consensus host url configured');
      return undefined;
    }

    if (!this.config.l1RpcUrls) {
      this.log.debug('No execution host url configured');
      return undefined;
    }

    // Ping execution node to get the parentBeaconBlockRoot for this block
    let parentBeaconBlockRoot: string | undefined;
    const client = createPublicClient({
      transport: fallback(this.config.l1RpcUrls.map(url => http(url))),
    });
    try {
      const res: RpcBlock = await client.request({
        method: 'eth_getBlockByHash',
        params: [blockHash, /*tx flag*/ false],
      });

      if (res.parentBeaconBlockRoot) {
        parentBeaconBlockRoot = res.parentBeaconBlockRoot;
      }
    } catch (err) {
      this.log.error(`Error getting parent beacon block root`, err);
    }

    if (!parentBeaconBlockRoot) {
      this.log.error(`No parent beacon block root found for block ${blockHash}`);
      return undefined;
    }

    // Query beacon chain to get the slot number for that block root
    try {
      const { url, ...options } = getBeaconNodeFetchOptions(
        `${this.config.l1ConsensusHostUrl}/eth/v1/beacon/headers/${parentBeaconBlockRoot}`,
        this.config,
      );
      const res = await this.fetch(url, options);

      if (res.ok) {
        const body = await res.json();

        // Add one to get the slot number of the original block hash
        return Number(body.data.header.message.slot) + 1;
      }
    } catch (err) {
      this.log.error(`Error getting slot number`, err);
    }

    return undefined;
  }
}

async function getRelevantBlobs(data: any, blobHashes: Buffer[], logger: Logger): Promise<Blob[]> {
  const preFilteredBlobsPromise = data
    // Filter out blobs that did not come from our rollup
    .filter((b: BlobJson) => {
      const commitment = Buffer.from(b.kzg_commitment.slice(2), 'hex');
      const blobHash = Blob.getEthVersionedBlobHash(commitment);
      return blobHashes.some(hash => hash.equals(blobHash));
    })
    // Attempt to deserialise the blob
    // If we cannot decode it, then it is malicious and we should not use it
    .map(async (b: BlobJson): Promise<Blob | undefined> => {
      try {
        return await Blob.fromJson(b);
      } catch (err) {
        if (err instanceof BlobDeserializationError) {
          logger.warn(`Failed to deserialise blob`, { commitment: b.kzg_commitment });
          return undefined;
        }
        throw err;
      }
    });

  // Second map is async, so we need to await it
  const preFilteredBlobs = await Promise.all(preFilteredBlobsPromise);

  // Filter out blobs that did not deserialise
  const filteredBlobs = preFilteredBlobs.filter((b: Blob | undefined) => {
    return b !== undefined;
  });

  return filteredBlobs;
}

function getBeaconNodeFetchOptions(url: string, config: BlobSinkConfig) {
  let formattedUrl = url;
  if (config.l1ConsensusHostApiKey && !config.l1ConsensusHostApiKeyHeader) {
    formattedUrl += `${formattedUrl.includes('?') ? '&' : '?'}key=${config.l1ConsensusHostApiKey}`;
  }
  return {
    url: formattedUrl,
    ...(config.l1ConsensusHostApiKey &&
      config.l1ConsensusHostApiKeyHeader && {
        headers: {
          [config.l1ConsensusHostApiKeyHeader]: config.l1ConsensusHostApiKey,
        },
      }),
  };
}
