// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BunkerTypes
/// @notice Shared enums, structs, roles and custom errors for the BunkerSettle contracts.

/// @dev Order lifecycle states (SPEC section 4).
enum Status {
    Created,
    Accepted,
    Funded,
    QuantityApproved,
    Settled,
    Disputed,
    Resolved,
    Cancelled
}

/// @dev Why a dispute was opened.
enum DisputeReason {
    OUT_OF_TOLERANCE,
    QUANTITY_MISMATCH,
    QUALITY_FAIL,
    MANUAL
}

/// @dev SS 709:2024 digital bunkering document types used as the evidence model.
enum DocType {
    DSC,
    BRF,
    BMT,
    BDN,
    QTR,
    COQ,
    NOPV,
    NOPB,
    SOF,
    DSI
}

/// @dev Bunker order record held by BunkerOrder.
struct Order {
    uint256 id;
    address buyer;
    address supplier;
    address bank;
    string fuelGrade;
    uint256 qtyKg;
    uint256 pricePerTonne;
    uint16 toleranceBps;
    uint16 retentionBps;
    uint256 deliveryDeadline;
    uint256 retentionWindow;
    uint256 fundedAmount;
    uint256 deliveredKg;
    uint256 payableAmount;
    uint256 releasedAmount;
    uint256 approvedAt;
    Status status;
    uint256 disputeId;
    bytes32 dscHash;
    uint256 refundedAmount;
}

bytes32 constant ROLE_ADMIN = keccak256("ADMIN");
bytes32 constant ROLE_BANK = keccak256("BANK");
bytes32 constant ROLE_BUYER = keccak256("BUYER");
bytes32 constant ROLE_SUPPLIER = keccak256("SUPPLIER");
bytes32 constant ROLE_METER_ORACLE = keccak256("METER_ORACLE");
bytes32 constant ROLE_EBDN_ORACLE = keccak256("EBDN_ORACLE");
bytes32 constant ROLE_LAB = keccak256("LAB");
bytes32 constant ROLE_ARBITER = keccak256("ARBITER");

error NotAuthorized(bytes32 role, address account);
error AccountSuspended(address account);
error InvalidState(uint256 id, Status expected, Status actual);
error InvalidParameter(string name);
error DeadlinePassed(uint256 id);
error DeadlineNotReached(uint256 id);
error AlreadySubmitted(uint256 id, string what);
error NotOrderParty(uint256 id, address account);
error RetentionWindowOpen(uint256 id, uint256 releasableAt);
error InsufficientEscrow(uint256 id, uint256 requested, uint256 available);
error OnlyModule(address caller);
error AlreadyWired();
