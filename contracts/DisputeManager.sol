// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RoleGuard} from "./base/RoleGuard.sol";
import {IBunkerOrder} from "./interfaces/IBunkerOrder.sol";
import {IPaymentEscrow} from "./interfaces/IPaymentEscrow.sol";
import {IDisputeManager} from "./interfaces/IDisputeManager.sol";
import {
    Order,
    Status,
    DisputeReason,
    DocType,
    ROLE_BUYER,
    ROLE_SUPPLIER,
    ROLE_BANK,
    ROLE_ARBITER,
    InvalidState,
    InvalidParameter,
    NotAuthorized,
    NotOrderParty
} from "./interfaces/BunkerTypes.sol";

/// @title DisputeManager
/// @notice Opens disputes (automatically via BunkerOrder or manually by buyer/supplier), collects evidence
///         and lets an ARBITER split the held funds.
contract DisputeManager is IDisputeManager, RoleGuard, ReentrancyGuard {
    struct Dispute {
        uint256 orderId;
        DisputeReason reason;
        address openedBy;
        uint256 openedAt;
        uint256 evidenceCount;
        bool resolved;
        uint16 supplierShareBps;
    }

    IBunkerOrder public immutable order;
    IPaymentEscrow public immutable escrow;

    mapping(uint256 => Dispute) private _disputes;
    uint256 private _count;

    event DisputeOpened(uint256 indexed disputeId, uint256 indexed orderId, DisputeReason reason, address openedBy);
    event EvidenceSubmitted(
        uint256 indexed disputeId, uint256 indexed orderId, DocType docType, bytes32 docHash, string note, address by
    );
    event DisputeResolved(
        uint256 indexed disputeId,
        uint256 indexed orderId,
        uint16 supplierShareBps,
        uint256 supplierAmount,
        uint256 bankAmount
    );

    constructor(address registry_, address order_, address escrow_) RoleGuard(registry_) {
        if (order_ == address(0)) revert InvalidParameter("order");
        if (escrow_ == address(0)) revert InvalidParameter("escrow");
        order = IBunkerOrder(order_);
        escrow = IPaymentEscrow(escrow_);
    }

    /// @notice Open a dispute. BunkerOrder calls this automatically; the order's buyer or supplier may call it
    ///         manually (reason MANUAL) while the order is `Funded` or `QuantityApproved`.
    /// @param orderId Order id.
    /// @param reason Dispute reason.
    /// @return disputeId New dispute id.
    function openDispute(uint256 orderId, DisputeReason reason) external override returns (uint256 disputeId) {
        bool auto_ = msg.sender == address(order);
        if (!auto_) {
            if (reason != DisputeReason.MANUAL) revert InvalidParameter("reason");
            Order memory o = order.getOrder(orderId);
            _requireParty(o, msg.sender, false);
            if (o.status != Status.Funded && o.status != Status.QuantityApproved) {
                revert InvalidState(orderId, Status.Funded, o.status);
            }
        }
        disputeId = ++_count;
        Dispute storage d = _disputes[disputeId];
        d.orderId = orderId;
        d.reason = reason;
        d.openedBy = msg.sender;
        d.openedAt = block.timestamp;
        emit DisputeOpened(disputeId, orderId, reason, msg.sender);
        // The automatic path is already inside BunkerOrder, which updates its own status.
        if (!auto_) order.onDisputeOpened(orderId, disputeId);
    }

    /// @notice Attach an SS 709 evidence document hash to an open dispute. Order's buyer, supplier or bank only.
    /// @param disputeId Dispute id.
    /// @param docType SS 709 document type (e.g. NOPV, NOPB, SOF).
    /// @param docHash Hash of the off-chain document.
    /// @param note Free-text note.
    function submitEvidence(uint256 disputeId, DocType docType, bytes32 docHash, string calldata note) external {
        Dispute storage d = _getDispute(disputeId);
        Order memory o = order.getOrder(d.orderId);
        _requireParty(o, msg.sender, true);
        if (d.resolved || o.status != Status.Disputed) revert InvalidState(o.id, Status.Disputed, o.status);
        d.evidenceCount++;
        emit EvidenceSubmitted(disputeId, o.id, docType, docHash, note, msg.sender);
    }

    /// @notice Resolve a dispute by splitting the held funds. ARBITER only.
    /// @param disputeId Dispute id.
    /// @param supplierShareBps Supplier share of the held amount in basis points; the bank gets the rest.
    function resolve(uint256 disputeId, uint16 supplierShareBps) external nonReentrant {
        _requireRole(ROLE_ARBITER, msg.sender);
        Dispute storage d = _getDispute(disputeId);
        if (supplierShareBps > 10_000) revert InvalidParameter("supplierShareBps");
        Order memory o = order.getOrder(d.orderId);
        if (d.resolved || o.status != Status.Disputed) revert InvalidState(o.id, Status.Disputed, o.status);

        uint256 held = order.heldAmount(o.id);
        uint256 supplierAmt = held * supplierShareBps / 10_000;
        uint256 bankAmt = held - supplierAmt;
        d.resolved = true;
        d.supplierShareBps = supplierShareBps;
        escrow.split(o.id, order.payeeOf(o.id), supplierAmt, o.bank, bankAmt);
        order.onDisputeResolved(o.id, supplierAmt, bankAmt);
        emit DisputeResolved(disputeId, o.id, supplierShareBps, supplierAmt, bankAmt);
    }

    /// @notice Dispute record.
    /// @param disputeId Dispute id.
    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _getDispute(disputeId);
    }

    /// @notice Number of disputes opened (ids run 1..disputeCount).
    function disputeCount() external view returns (uint256) {
        return _count;
    }

    function _getDispute(uint256 disputeId) private view returns (Dispute storage) {
        if (disputeId == 0 || disputeId > _count) revert InvalidParameter("disputeId");
        return _disputes[disputeId];
    }

    /// @dev Role first, then party. Unregistered outsiders get NotAuthorized, registered non-parties NotOrderParty.
    function _requireParty(Order memory o, address account, bool withBank) private view {
        if (account == o.buyer) {
            _requireRole(ROLE_BUYER, account);
        } else if (account == o.supplier) {
            _requireRole(ROLE_SUPPLIER, account);
        } else if (withBank && account == o.bank) {
            _requireRole(ROLE_BANK, account);
        } else {
            if (
                registry.hasRole(ROLE_BUYER, account) || registry.hasRole(ROLE_SUPPLIER, account)
                    || (withBank && registry.hasRole(ROLE_BANK, account))
            ) revert NotOrderParty(o.id, account);
            revert NotAuthorized(ROLE_BUYER, account);
        }
    }
}
