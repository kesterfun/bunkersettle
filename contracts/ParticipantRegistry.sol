// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {
    ROLE_ADMIN,
    ROLE_BANK,
    ROLE_BUYER,
    ROLE_SUPPLIER,
    ROLE_METER_ORACLE,
    ROLE_EBDN_ORACLE,
    ROLE_LAB,
    ROLE_ARBITER,
    NotAuthorized,
    AccountSuspended
} from "./interfaces/BunkerTypes.sol";

/// @title ParticipantRegistry
/// @notice Role registry for the BunkerSettle consortium. Suspended accounts fail every role check.
contract ParticipantRegistry is AccessControl {
    bytes32 public constant ADMIN = ROLE_ADMIN;
    bytes32 public constant BANK = ROLE_BANK;
    bytes32 public constant BUYER = ROLE_BUYER;
    bytes32 public constant SUPPLIER = ROLE_SUPPLIER;
    bytes32 public constant METER_ORACLE = ROLE_METER_ORACLE;
    bytes32 public constant EBDN_ORACLE = ROLE_EBDN_ORACLE;
    bytes32 public constant LAB = ROLE_LAB;
    bytes32 public constant ARBITER = ROLE_ARBITER;

    mapping(address => bool) public isSuspended;
    mapping(address => string) private _names;

    event ParticipantRegistered(address indexed account, bytes32 indexed role, string name);
    event ParticipantRevoked(address indexed account, bytes32 indexed role);
    event ParticipantSuspended(address indexed account);
    event ParticipantReinstated(address indexed account);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ROLE_ADMIN, msg.sender);
        _names[msg.sender] = "Admin";
    }

    modifier onlyAdmin() {
        if (!hasActiveRole(ROLE_ADMIN, msg.sender)) {
            if (hasRole(ROLE_ADMIN, msg.sender)) revert AccountSuspended(msg.sender);
            revert NotAuthorized(ROLE_ADMIN, msg.sender);
        }
        _;
    }

    /// @notice Grant a role to an account and record its display name.
    /// @param account Participant address.
    /// @param role Role identifier.
    /// @param name Display name shown in the UI.
    function register(address account, bytes32 role, string calldata name) external onlyAdmin {
        _grantRole(role, account);
        _names[account] = name;
        emit ParticipantRegistered(account, role, name);
    }

    /// @notice Remove a role from an account.
    /// @param account Participant address.
    /// @param role Role identifier.
    function revoke(address account, bytes32 role) external onlyAdmin {
        _revokeRole(role, account);
        emit ParticipantRevoked(account, role);
    }

    /// @notice Suspend an account; it fails every role check until reinstated.
    /// @param account Participant address.
    function suspend(address account) external onlyAdmin {
        isSuspended[account] = true;
        emit ParticipantSuspended(account);
    }

    /// @notice Lift a suspension.
    /// @param account Participant address.
    function reinstate(address account) external onlyAdmin {
        isSuspended[account] = false;
        emit ParticipantReinstated(account);
    }

    /// @notice True when the account holds the role and is not suspended.
    /// @param role Role identifier.
    /// @param account Participant address.
    function hasActiveRole(bytes32 role, address account) public view returns (bool) {
        return hasRole(role, account) && !isSuspended[account];
    }

    /// @notice Display name of a participant.
    /// @param account Participant address.
    function nameOf(address account) external view returns (string memory) {
        return _names[account];
    }
}
