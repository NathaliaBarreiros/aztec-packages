import { VK_TREE_HEIGHT } from '@aztec/constants';
import { Fr } from '@aztec/foundation/fields';
import { schemas } from '@aztec/foundation/schemas';
import { BufferReader, type Tuple, serializeToBuffer } from '@aztec/foundation/serialize';
import { bufferToHex, hexToBuffer } from '@aztec/foundation/string';
import type { FieldsOf } from '@aztec/foundation/types';

import { RecursiveProof } from '../proofs/recursive_proof.js';
import { VerificationKeyAsFields } from '../vks/verification_key.js';
import { ParityPublicInputs } from './parity_public_inputs.js';

export class RootParityInput<PROOF_LENGTH extends number> {
  constructor(
    /** The proof of the execution of the parity circuit. */
    public readonly proof: RecursiveProof<PROOF_LENGTH>,
    /** The circuit's verification key */
    public readonly verificationKey: VerificationKeyAsFields,
    /** The vk path in the vk tree*/
    public readonly vkPath: Tuple<Fr, typeof VK_TREE_HEIGHT>,
    /** The public inputs of the parity circuit. */
    public readonly publicInputs: ParityPublicInputs,
  ) {}

  toBuffer() {
    return serializeToBuffer(...RootParityInput.getFields(this));
  }

  toString() {
    return bufferToHex(this.toBuffer());
  }

  static from<PROOF_LENGTH extends number>(
    fields: FieldsOf<RootParityInput<PROOF_LENGTH>>,
  ): RootParityInput<PROOF_LENGTH> {
    return new RootParityInput(...RootParityInput.getFields(fields));
  }

  static getFields<PROOF_LENGTH extends number>(fields: FieldsOf<RootParityInput<PROOF_LENGTH>>) {
    return [fields.proof, fields.verificationKey, fields.vkPath, fields.publicInputs] as const;
  }

  static fromBuffer<PROOF_LENGTH extends number>(
    buffer: Buffer | BufferReader,
    expectedSize?: PROOF_LENGTH,
  ): RootParityInput<PROOF_LENGTH> {
    const reader = BufferReader.asReader(buffer);
    return new RootParityInput(
      RecursiveProof.fromBuffer<PROOF_LENGTH>(reader, expectedSize),
      reader.readObject(VerificationKeyAsFields),
      reader.readArray(VK_TREE_HEIGHT, Fr),
      reader.readObject(ParityPublicInputs),
    );
  }

  static fromString<PROOF_LENGTH extends number>(
    str: string,
    expectedSize?: PROOF_LENGTH,
  ): RootParityInput<PROOF_LENGTH> {
    return RootParityInput.fromBuffer(hexToBuffer(str), expectedSize);
  }

  /** Returns a hex representation for JSON serialization. */
  toJSON() {
    return this.toBuffer();
  }

  /** Creates an instance from a hex string with expected size. */
  static schemaFor<N extends number>(expectedSize?: N) {
    return schemas.Buffer.transform(buf => RootParityInput.fromBuffer(buf, expectedSize));
  }
}
