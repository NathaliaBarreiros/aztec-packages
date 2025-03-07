use dep::protocol_types::address::aztec_address::AztecAddress;
use dep::protocol_types::point::Point;

#[oracle(getSharedSecret)]
pub unconstrained fn get_shared_secret_oracle(address: AztecAddress, ephPk: Point) -> Point {}
