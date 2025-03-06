use dep::protocol_types::address::aztec_address::AztecAddress;
use dep::protocol_types::scalar::Scalar;

#[oracle(getAddressSecret)]
pub unconstrained fn get_address_secret_oracle(address: AztecAddress) -> Scalar {}
