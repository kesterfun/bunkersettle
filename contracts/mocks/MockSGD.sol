// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RoleGuard} from "../base/RoleGuard.sol";
import {ROLE_ADMIN} from "../interfaces/BunkerTypes.sol";

/// @title MockSGD
/// @notice TEST-ONLY stablecoin stand-in (18 decimals). Do not use in production.
contract MockSGD is ERC20, RoleGuard {
    constructor(address registry_) ERC20("Mock Singapore Dollar", "mSGD") RoleGuard(registry_) {}

    /// @notice Mint tokens; restricted to registry ADMIN.
    /// @param to Recipient.
    /// @param amount Amount in wei units.
    function mint(address to, uint256 amount) external {
        _requireRole(ROLE_ADMIN, msg.sender);
        _mint(to, amount);
    }
}
