// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {RoleGuard} from "./RoleGuard.sol";
import {SignatureExpired} from "../interfaces/BunkerTypes.sol";

/// @title SignedRoleGuard
/// @notice RoleGuard plus EIP-712 verification, so an oracle can sign its submission off-chain and
///         any account (a relayer) can send it. The signer, not the relayer, must hold the role.
abstract contract SignedRoleGuard is RoleGuard, EIP712 {
    constructor(address registry_, string memory name_) RoleGuard(registry_) EIP712(name_, "1") {}

    /// @dev Checks the deadline, recovers the signer from the typed-data hash and requires the signer
    ///      to hold `role`. A tampered payload recovers a different address and fails the role check.
    function _verifySigned(bytes32 role, bytes32 structHash, uint256 deadline, bytes calldata signature)
        internal
        view
        returns (address signer)
    {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        _requireRole(role, signer);
    }
}
