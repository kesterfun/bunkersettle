// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IParticipantRegistry} from "../interfaces/IParticipantRegistry.sol";
import {AccountSuspended, NotAuthorized, InvalidParameter} from "../interfaces/BunkerTypes.sol";

/// @title RoleGuard
/// @notice Shared registry-backed role check. Reverts AccountSuspended when the account holds the
///         role but is suspended, otherwise NotAuthorized.
abstract contract RoleGuard {
    IParticipantRegistry public immutable registry;

    constructor(address registry_) {
        if (registry_ == address(0)) revert InvalidParameter("registry");
        registry = IParticipantRegistry(registry_);
    }

    function _requireRole(bytes32 role, address account) internal view {
        if (!registry.hasActiveRole(role, account)) {
            if (registry.hasRole(role, account)) revert AccountSuspended(account);
            revert NotAuthorized(role, account);
        }
    }
}
