use js_sys::JsString;
use wasm_bindgen::prelude::*;

use crate::js_witness_map::{field_element_to_js_string, js_value_to_field_element};
use acvm::{FieldElement, acir::AcirField};

/// Performs a bitwise AND operation between `lhs` and `rhs`
#[wasm_bindgen]
pub fn and(lhs: JsString, rhs: JsString) -> JsString {
    let lhs = js_value_to_field_element(lhs.into()).unwrap();
    let rhs = js_value_to_field_element(rhs.into()).unwrap();
    let result = acvm::blackbox_solver::bit_and(lhs, rhs, FieldElement::max_num_bits());
    field_element_to_js_string(&result)
}

/// Performs a bitwise XOR operation between `lhs` and `rhs`
#[wasm_bindgen]
pub fn xor(lhs: JsString, rhs: JsString) -> JsString {
    let lhs = js_value_to_field_element(lhs.into()).unwrap();
    let rhs = js_value_to_field_element(rhs.into()).unwrap();
    let result = acvm::blackbox_solver::bit_xor(lhs, rhs, FieldElement::max_num_bits());
    field_element_to_js_string(&result)
}

/// Sha256 compression function
#[wasm_bindgen]
pub fn sha256_compression(inputs: &[u32], state: &[u32]) -> Vec<u32> {
    let mut state: [u32; 8] = state.try_into().unwrap();
    let inputs: [u32; 16] = inputs.try_into().unwrap();
    acvm::blackbox_solver::sha256_compression(&mut state, &inputs);
    state.to_vec()
}

/// Calculates the Blake2s256 hash of the input bytes
#[wasm_bindgen]
pub fn blake2s256(inputs: &[u8]) -> Vec<u8> {
    acvm::blackbox_solver::blake2s(inputs).unwrap().into()
}

/// Verifies a ECDSA signature over the secp256k1 curve.
#[wasm_bindgen]
pub fn ecdsa_secp256k1_verify(
    hashed_msg: &[u8],
    public_key_x_bytes: &[u8],
    public_key_y_bytes: &[u8],
    signature: &[u8],
) -> bool {
    let public_key_x_bytes: &[u8; 32] = public_key_x_bytes.try_into().unwrap();
    let public_key_y_bytes: &[u8; 32] = public_key_y_bytes.try_into().unwrap();
    let signature: &[u8; 64] = signature.try_into().unwrap();

    acvm::blackbox_solver::ecdsa_secp256k1_verify(
        hashed_msg,
        public_key_x_bytes,
        public_key_y_bytes,
        signature,
    )
    .unwrap()
}

/// Verifies a ECDSA signature over the secp256r1 curve.
#[wasm_bindgen]
pub fn ecdsa_secp256r1_verify(
    hashed_msg: &[u8],
    public_key_x_bytes: &[u8],
    public_key_y_bytes: &[u8],
    signature: &[u8],
) -> bool {
    let public_key_x_bytes: &[u8; 32] = public_key_x_bytes.try_into().unwrap();
    let public_key_y_bytes: &[u8; 32] = public_key_y_bytes.try_into().unwrap();
    let signature: &[u8; 64] = signature.try_into().unwrap();

    acvm::blackbox_solver::ecdsa_secp256r1_verify(
        hashed_msg,
        public_key_x_bytes,
        public_key_y_bytes,
        signature,
    )
    .unwrap()
}
