use std::static_assert;

use crate::{
    capsules::CapsuleArray,
    oracle::note_discovery::{deliver_note, sync_notes},
    utils::array,
};

use dep::protocol_types::{
    address::AztecAddress,
    constants::{MAX_NOTE_HASHES_PER_TX, PRIVATE_LOG_SIZE_IN_FIELDS},
    debug_log::{debug_log, debug_log_format},
};

use crate::discovery::{
    ComputeNoteHashAndNullifier,
    MAX_NOTE_PACKED_LEN,
    nonce_discovery::{attempt_note_nonce_discovery, DiscoveredNoteInfo},
    NOTE_PRIVATE_LOG_RESERVED_FIELDS,
    partial_notes::{
        DELIVERED_PENDING_PARTIAL_NOTE_ARRAY_LENGTH_CAPSULES_SLOT, DeliveredPendingPartialNote,
    },
};
use crate::encrypted_logs::encrypt::aes128::derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_sha256;
use crate::encrypted_logs::log_assembly_strategies::default_aes128::note::HEADER_CIPHERTEXT_SIZE_IN_BYTES;
use crate::oracle::aes128_decrypt::aes128_decrypt_oracle;
use crate::oracle::shared_secret::get_shared_secret;
use crate::utils::point::point_from_x_coord_and_sign;

pub global PARTIAL_NOTE_COMPLETION_LOG_TAG_LEN: u32 = 1;
/// Partial notes have a maximum packed length of their private fields bound by extra content in their private log (i.e.
/// the note completion log tag).
pub global MAX_PARTIAL_NOTE_PRIVATE_PACKED_LEN: u32 =
    MAX_NOTE_PACKED_LEN - PARTIAL_NOTE_COMPLETION_LOG_TAG_LEN;

// TODO: Should this be somehow derived from MAX_PARTIAL_NOTE_PRIVATE_PACKED_LEN?
pub global PRIVATE_LOG_PLAINTEXT_SIZE_IN_FIELDS: u32 = 15;

/// Searches for private logs that signal new private notes that are then delivered to PXE, or new partial notes that
/// are stored in the PXE capsules so that `fetch_and_process_public_partial_note_completion_logs` can later search for
/// public logs that will complete them.
pub unconstrained fn fetch_and_process_private_tagged_logs<Env>(
    _contract_address: AztecAddress,
    _compute_note_hash_and_nullifier: ComputeNoteHashAndNullifier<Env>,
) {
    // We will eventually fetch tagged logs, decrypt and process them here, but for now we simply call the `syncNotes`
    // oracle. This has PXE perform tag synchronization, log download, decryption, and finally calls to the the
    // `process_log` contract function with the decrypted payload, which will in turn call `do_process_log` with a
    // decrypted log, letting us continue the work outside of PXE.
    sync_notes();
}

/// Processes a log's ciphertext by decrypting it, searching for private notes or partial notes. Private notes result in
/// nonce discovery being performed prior to delivery, which requires knowledge of the transaction hash in which the notes
/// would've been created (typically the same transaction in which the log was emitted), along with the list of unique
/// note hashes in said transaction and the `compute_note_hash_and_nullifier` function.
pub unconstrained fn do_process_log<Env>(
    contract_address: AztecAddress,
    log: BoundedVec<Field, PRIVATE_LOG_SIZE_IN_FIELDS>,
    tx_hash: Field,
    unique_note_hashes_in_tx: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    first_nullifier_in_tx: Field,
    recipient: AztecAddress,
    compute_note_hash_and_nullifier: ComputeNoteHashAndNullifier<Env>,
) {
    let log_plaintext = decrypt_log(log, recipient);

    // The first thing to do after decrypting the log is to determine what type of private log we're processing. We
    // currently just have two log types: 0 for private notes and 1 for partial notes. This will likely be expanded and
    // improved upon in the future to also handle events, etc.

    let (storage_slot, note_type_id, log_type_id, log_payload) =
        destructure_log_plaintext(log_plaintext);

    if log_type_id == 0 {
        debug_log("Processing private note log");

        process_private_note_log(
            contract_address,
            tx_hash,
            unique_note_hashes_in_tx,
            first_nullifier_in_tx,
            recipient,
            compute_note_hash_and_nullifier,
            storage_slot,
            note_type_id,
            log_payload,
        );
    } else if log_type_id == 1 {
        debug_log("Processing partial note private log");

        process_partial_note_private_log(
            contract_address,
            storage_slot,
            note_type_id,
            log_payload,
            recipient,
        );
    } else {
        panic(f"Unknown log type id {log_type_id}");
    }
}

unconstrained fn decrypt_log(
    log: BoundedVec<Field, PRIVATE_LOG_SIZE_IN_FIELDS>,
    recipient: AztecAddress,
) -> BoundedVec<Field, PRIVATE_LOG_PLAINTEXT_SIZE_IN_FIELDS> {
    // let tag = log.get(0);
    let eph_pk_x = log.get(1);

    let log_ciphertext_fields =
        array::subbvec::<Field, PRIVATE_LOG_SIZE_IN_FIELDS, PRIVATE_LOG_SIZE_IN_FIELDS - 2>(log, 2);

    // Convert the ciphertext represented as fields to a byte representation (its original format)
    let log_ciphertext = fields_to_be_bytes_31::<(PRIVATE_LOG_SIZE_IN_FIELDS - 2), (PRIVATE_LOG_SIZE_IN_FIELDS - 2) * 31>(
        log_ciphertext_fields,
    );

    // First byte of the ciphertext represents the ephemeral public key sign
    let eph_pk_sign_bool = log_ciphertext.get(0) as bool;
    // With the sign and the x-coordinate of the ephemeral public key, we can reconstruct the point
    let eph_pk = point_from_x_coord_and_sign(eph_pk_x, eph_pk_sign_bool);

    // Derive shared secret and symmetric key
    let ciphertext_shared_secret = get_shared_secret(recipient, eph_pk);
    let (sym_key, iv) = derive_aes_symmetric_key_and_iv_from_ecdh_shared_secret_using_sha256(
        ciphertext_shared_secret,
    );

    // Extract and decrypt header
    let header_start = 1; // Skip eph_pk_sign byte
    let header_ciphertext: [u8; HEADER_CIPHERTEXT_SIZE_IN_BYTES] =
        array::subbvec(log_ciphertext, header_start).storage();
    let header_plaintext = aes128_decrypt_oracle(header_ciphertext, iv, sym_key);

    // Extract ciphertext length from header (2 bytes, big-endian)
    let ciphertext_length =
        ((header_plaintext.get(32) as u32) << 8) | (header_plaintext.get(33) as u32);

    // Extract and decrypt main ciphertext
    let ciphertext_start = header_start + HEADER_CIPHERTEXT_SIZE_IN_BYTES;
    let ciphertext: BoundedVec<u8, (PRIVATE_LOG_SIZE_IN_FIELDS - 2) * 31 - HEADER_CIPHERTEXT_SIZE_IN_BYTES - 1> =
        array::subbvec(log_ciphertext, ciphertext_start);

    // The result of subbvec call above includes padding bytes. We remove them in a for-loop.
    let mut ciphertext = ciphertext;
    for _ in 0..(ciphertext.len() - ciphertext_length) {
        let _ = ciphertext.pop();
    }

    // Decrypt main ciphertext
    let plaintext_bytes = aes128_decrypt_oracle(ciphertext.storage(), iv, sym_key);

    // Convert plaintext bytes back to fields
    be_bytes_31_to_fields(plaintext_bytes)
}

unconstrained fn destructure_log_plaintext(
    log_plaintext: BoundedVec<Field, PRIVATE_LOG_PLAINTEXT_SIZE_IN_FIELDS>,
) -> (Field, Field, Field, BoundedVec<Field, MAX_NOTE_PACKED_LEN>) {
    assert(log_plaintext.len() >= NOTE_PRIVATE_LOG_RESERVED_FIELDS);

    // If NOTE_PRIVATE_LOG_RESERVED_FIELDS is changed, causing the assertion below to fail, then the declarations for
    // `storage_slot` and `note_type_id` must be updated as well.
    static_assert(
        NOTE_PRIVATE_LOG_RESERVED_FIELDS == 2,
        "unexpected value for NOTE_PRIVATE_LOG_RESERVED_FIELDS",
    );
    let storage_slot = log_plaintext.get(0);

    // We currently identify log types by packing the log type ID and note type ID into a single field, called the
    // combined type ID. We can do this because the note type ID is only 7 bits long, and so use an 8th bit to
    // distinguish private note logs and partial note logs.
    // This abuses the fact that the encoding of both of these logs is extremely similar, and will need improving and
    // more formalization once we introduce other dissimilar log types, such as events. Ideally we'd be able to
    // leverage enums and tagged unions to achieve this goal.
    let combined_type_id = log_plaintext.get(1);
    let note_type_id = ((combined_type_id as u64) % 128) as Field;
    let log_type_id = ((combined_type_id as u64) / 128) as Field;

    let log_payload = array::subbvec(log_plaintext, NOTE_PRIVATE_LOG_RESERVED_FIELDS);

    (storage_slot, note_type_id, log_type_id, log_payload)
}

unconstrained fn process_private_note_log<Env>(
    contract_address: AztecAddress,
    tx_hash: Field,
    unique_note_hashes_in_tx: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX>,
    first_nullifier_in_tx: Field,
    recipient: AztecAddress,
    compute_note_hash_and_nullifier: ComputeNoteHashAndNullifier<Env>,
    storage_slot: Field,
    note_type_id: Field,
    packed_note_content: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
) {
    let discovered_notes = attempt_note_nonce_discovery(
        unique_note_hashes_in_tx,
        first_nullifier_in_tx,
        compute_note_hash_and_nullifier,
        contract_address,
        storage_slot,
        note_type_id,
        packed_note_content,
    );

    debug_log_format(
        "Discovered {0} notes from a private log",
        [discovered_notes.len() as Field],
    );

    array::for_each_in_bounded_vec(
        discovered_notes,
        |discovered_note: DiscoveredNoteInfo, _| {
            // TODO:(#10728): handle notes that fail delivery. This could be due to e.g. a temporary node connectivity
            // issue, and we should perhaps not have marked the tag index as taken.
            assert(
                deliver_note(
                    contract_address,
                    storage_slot,
                    discovered_note.nonce,
                    packed_note_content,
                    discovered_note.note_hash,
                    discovered_note.inner_nullifier,
                    tx_hash,
                    recipient,
                ),
                "Failed to deliver note",
            );
        },
    );
}

unconstrained fn process_partial_note_private_log(
    contract_address: AztecAddress,
    storage_slot: Field,
    note_type_id: Field,
    log_payload: BoundedVec<Field, MAX_NOTE_PACKED_LEN>,
    recipient: AztecAddress,
) {
    // We store the information of the partial note we found so that we can later search for the public log that will
    // complete it. The tag is the first value in the payload, with the packed note content taking up the rest of it.
    static_assert(
        PARTIAL_NOTE_COMPLETION_LOG_TAG_LEN == 1,
        "unexpected value for PARTIAL_NOTE_COMPLETION_LOG_TAG_LEN",
    );

    let pending = DeliveredPendingPartialNote {
        note_completion_log_tag: log_payload.get(0),
        storage_slot,
        note_type_id,
        packed_private_note_content: array::subbvec(log_payload, 1),
        recipient,
    };

    CapsuleArray::at(
        contract_address,
        DELIVERED_PENDING_PARTIAL_NOTE_ARRAY_LENGTH_CAPSULES_SLOT,
    )
        .push(pending);
}

// TODO: NUKE THE REST OF THE FILE - COPIED HERE TO UNBLOCK MYSELF
pub fn be_bytes_31_to_fields<let N: u32>(
    bytes: BoundedVec<u8, N>,
) -> BoundedVec<Field, (N + 30) / 31> {
    let mut fields = BoundedVec::new();

    // There are "bytes.len() / 31" whole fields that can be populated.
    for i in 0..bytes.len() / 31 {
        let mut field = 0;
        for j in 0..31 {
            // Shift the existing value left by 8 bits and add the new byte
            field = field * 256 + bytes.get(i * 31 + j) as Field;
        }
        fields.push(field);
    }

    // Note: if 31 divides bytes.len(), then this loop does not execute.
    // ceil(bytes.len()/31) - floor(bytes.len()/31) = 1, unless 31 divides bytes.len(), in which case it's 0.
    for _ in 0..((bytes.len() + 30) / 31) - (bytes.len() / 31) {
        let mut final_field = 0;
        let final_field_idx = fields.len();
        let final_offset = final_field_idx * 31;
        // bytes.len() - ((bytes.len() / 31) * 31) = bytes.len() - floor(bytes.len()/31) * 31 = the number of bytes
        // to go in the final field.
        for j in 0..bytes.len() - ((bytes.len() / 31) * 31) {
            // Shift the existing value left by 8 bits and add the new byte
            final_field = final_field * 256 + bytes.get(final_offset + j) as Field;
        }

        fields.push(final_field);
    }

    fields
}

pub fn fields_to_be_bytes_31<let N: u32, let M: u32>(
    fields: BoundedVec<Field, N>,
) -> BoundedVec<u8, M> {
    let mut bytes = BoundedVec::new();

    // Given the input is N fields, and each field (except the last) is mapped to 31 bytes,
    // we check that M > (N - 1) * 31 to cover those first (N - 1) fields.
    std::static_assert(M > (N - 1) * 31, "Not enough output bytes specified");
    // We make this assertion to keep the logic simpler:
    std::static_assert(N * 31 >= M, "Too many output bytes specified.");

    // Since we are dealing with a BoundedVec and not an array, the input might not contain N fields but less. Since
    // the last field can contain less info than 31 bytes if the input is fully populated (due to the flexible M
    // parameter), we need to handle that case separately.
    let input_full = fields.len() == N;

    let num_full_fields = if input_full {
        // Input is full so we need to handle the last field separately.
        fields.len() - 1
    } else {
        // Input is not full so all the fields are expected to contain 31 bytes of information.
        fields.len()
    };

    for i in 0..num_full_fields {
        let field = fields.get(i);

        // We expect that the field contains at most 31 bytes of information.
        field.assert_max_bit_size::<248>();

        // Now we can safely convert the field to 31 bytes.
        let field_as_bytes: [u8; 31] = field.to_be_bytes();

        for j in 0..31 {
            bytes.push(field_as_bytes[j]);
        }
    }

    if (input_full) {
        let final_field = fields.get(fields.len() - 1);

        final_field.assert_max_bit_size::<8 * (M - ((N - 1) * 31))>();

        let final_field_as_bytes: [u8; M - ((N - 1) * 31)] = final_field.to_be_bytes();

        for j in 0..M - ((N - 1) * 31) {
            bytes.push(final_field_as_bytes[j]);
        }
    }

    bytes
}
