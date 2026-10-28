// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RoleGuard} from "./base/RoleGuard.sol";
import {IBunkerOrder} from "./interfaces/IBunkerOrder.sol";
import {IPaymentEscrow} from "./interfaces/IPaymentEscrow.sol";
import {IDisputeManager} from "./interfaces/IDisputeManager.sol";
import {IDeliveryRecord} from "./interfaces/IDeliveryRecord.sol";
import "./interfaces/BunkerTypes.sol";

/// @title BunkerOrder
/// @notice Owns the bunker order state machine and is the only contract allowed to move escrowed funds
///         (besides DisputeManager.split).
contract BunkerOrder is IBunkerOrder, RoleGuard, Pausable, ReentrancyGuard {
    IPaymentEscrow public immutable escrow;
    address public deliveryRecord;
    address public qualityRecord;
    address public disputeManager;
    bool public modulesSet;

    mapping(uint256 => Order) private _orders;
    uint256 private _count;

    event ModulesSet(address deliveryRecord, address qualityRecord, address disputeManager);
    event OrderCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed supplier,
        address bank,
        uint256 qtyKg,
        uint256 pricePerTonne,
        bytes32 dscHash,
        DocType docType
    );
    event OrderAccepted(uint256 indexed id, address indexed supplier);
    event OrderFunded(uint256 indexed id, address indexed bank, uint256 amount);
    event OrderCancelled(uint256 indexed id, address indexed by, uint256 refunded);
    event QuantityApproved(uint256 indexed id, uint256 deliveredKg, uint256 payableAmount, uint256 releasedNow);
    event OrderSettled(
        uint256 indexed id,
        uint256 paidToSupplier,
        uint256 refundedToBank,
        bytes32 invoiceHash,
        DocType docType
    );
    event OrderDisputed(uint256 indexed id, uint256 indexed disputeId);
    event OrderResolved(uint256 indexed id, uint256 supplierAmount, uint256 bankAmount);

    constructor(address registry_, address escrow_) RoleGuard(registry_) {
        if (escrow_ == address(0)) revert InvalidParameter("escrow");
        escrow = IPaymentEscrow(escrow_);
    }

    modifier onlyDelivery() {
        if (msg.sender != deliveryRecord) revert OnlyModule(msg.sender);
        _;
    }

    modifier onlyQuality() {
        if (msg.sender != qualityRecord) revert OnlyModule(msg.sender);
        _;
    }

    modifier onlyDispute() {
        if (msg.sender != disputeManager) revert OnlyModule(msg.sender);
        _;
    }

    // ---------------------------------------------------------------- admin

    /// @notice Wire the module contracts. ADMIN only, once.
    /// @param delivery_ DeliveryRecord address.
    /// @param quality_ QualityRecord address.
    /// @param dispute_ DisputeManager address.
    function setModules(address delivery_, address quality_, address dispute_) external {
        _requireRole(ROLE_ADMIN, msg.sender);
        if (modulesSet) revert AlreadyWired();
        if (delivery_ == address(0) || quality_ == address(0) || dispute_ == address(0)) {
            revert InvalidParameter("module");
        }
        modulesSet = true;
        deliveryRecord = delivery_;
        qualityRecord = quality_;
        disputeManager = dispute_;
        emit ModulesSet(delivery_, quality_, dispute_);
    }

    /// @notice Pause order creation and funding. ADMIN only.
    function pause() external {
        _requireRole(ROLE_ADMIN, msg.sender);
        _pause();
    }

    /// @notice Resume order creation and funding. ADMIN only.
    function unpause() external {
        _requireRole(ROLE_ADMIN, msg.sender);
        _unpause();
    }

    // ------------------------------------------------------------ order flow

    /// @notice Create a new bunker order. BUYER only.
    /// @param supplier Designated supplier (must hold SUPPLIER).
    /// @param bank Designated financing bank (must hold BANK).
    /// @param fuelGrade Fuel grade, e.g. "VLSFO".
    /// @param qtyKg Ordered quantity in kilograms.
    /// @param pricePerTonne Price in MockSGD (18 decimals) per tonne.
    /// @param toleranceBps Quantity tolerance in basis points (max 500).
    /// @param retentionBps Retention in basis points (max 5000).
    /// @param deliveryDeadline Unix time by which delivery must happen; must be in the future.
    /// @param retentionWindow Seconds after quantity approval before retention may be released without a lab result.
    /// @param dscHash Hash of the SS 709 Sales confirmation - Delivered (DSC) holding the order terms.
    /// @return id New order id.
    function createOrder(
        address supplier,
        address bank,
        string calldata fuelGrade,
        uint256 qtyKg,
        uint256 pricePerTonne,
        uint16 toleranceBps,
        uint16 retentionBps,
        uint256 deliveryDeadline,
        uint256 retentionWindow,
        bytes32 dscHash
    ) external whenNotPaused returns (uint256 id) {
        _requireRole(ROLE_BUYER, msg.sender);
        if (!registry.hasActiveRole(ROLE_SUPPLIER, supplier)) revert InvalidParameter("supplier");
        if (!registry.hasActiveRole(ROLE_BANK, bank)) revert InvalidParameter("bank");
        if (bytes(fuelGrade).length == 0) revert InvalidParameter("fuelGrade");
        if (qtyKg == 0) revert InvalidParameter("qtyKg");
        if (pricePerTonne == 0) revert InvalidParameter("pricePerTonne");
        if (toleranceBps > 500) revert InvalidParameter("toleranceBps");
        if (retentionBps > 5000) revert InvalidParameter("retentionBps");
        if (deliveryDeadline <= block.timestamp) revert InvalidParameter("deliveryDeadline");

        id = ++_count;
        Order storage o = _orders[id];
        o.id = id;
        o.buyer = msg.sender;
        o.supplier = supplier;
        o.bank = bank;
        o.fuelGrade = fuelGrade;
        o.qtyKg = qtyKg;
        o.pricePerTonne = pricePerTonne;
        o.toleranceBps = toleranceBps;
        o.retentionBps = retentionBps;
        o.deliveryDeadline = deliveryDeadline;
        o.retentionWindow = retentionWindow;
        o.dscHash = dscHash;
        o.status = Status.Created;
        _emitCreated(o);
    }

    /// @notice Supplier accepts the order terms. `Created` -> `Accepted`.
    /// @param id Order id.
    function acceptOrder(uint256 id) external {
        _requireRole(ROLE_SUPPLIER, msg.sender);
        Order storage o = _get(id);
        if (o.supplier != msg.sender) revert NotOrderParty(id, msg.sender);
        _requireStatus(o, Status.Created);
        if (block.timestamp > o.deliveryDeadline) revert DeadlinePassed(id);
        o.status = Status.Accepted;
        emit OrderAccepted(id, msg.sender);
    }

    /// @notice Designated bank funds the order into escrow, covering max tolerated over-delivery.
    ///         `Accepted` -> `Funded`. Bank must have approved the escrow for the token amount.
    /// @param id Order id.
    function fundOrder(uint256 id) external whenNotPaused nonReentrant {
        _requireRole(ROLE_BANK, msg.sender);
        Order storage o = _get(id);
        if (o.bank != msg.sender) revert NotOrderParty(id, msg.sender);
        _requireStatus(o, Status.Accepted);
        if (block.timestamp > o.deliveryDeadline) revert DeadlinePassed(id);
        uint256 amount = (o.qtyKg * o.pricePerTonne / 1000) * (10_000 + o.toleranceBps) / 10_000;
        o.fundedAmount = amount;
        o.status = Status.Funded;
        escrow.deposit(id, msg.sender, amount);
        emit OrderFunded(id, msg.sender, amount);
    }

    /// @notice Buyer cancels before funding. `Created`/`Accepted` -> `Cancelled`.
    /// @param id Order id.
    function cancelOrder(uint256 id) external {
        _requireRole(ROLE_BUYER, msg.sender);
        Order storage o = _get(id);
        if (o.buyer != msg.sender) revert NotOrderParty(id, msg.sender);
        if (o.status != Status.Created && o.status != Status.Accepted) {
            revert InvalidState(id, Status.Created, o.status);
        }
        o.status = Status.Cancelled;
        emit OrderCancelled(id, msg.sender, 0);
    }

    /// @notice Anyone cancels a funded order whose deadline passed with no delivery evidence; bank is refunded.
    /// @param id Order id.
    function cancelExpired(uint256 id) external nonReentrant {
        Order storage o = _get(id);
        _requireStatus(o, Status.Funded);
        if (block.timestamp <= o.deliveryDeadline) revert DeadlineNotReached(id);
        if (IDeliveryRecord(deliveryRecord).hasEvidence(id)) revert AlreadySubmitted(id, "delivery");
        uint256 refunded = o.fundedAmount - o.releasedAmount - o.refundedAmount;
        o.refundedAmount += refunded;
        o.status = Status.Cancelled;
        escrow.refund(id, o.bank, refunded);
        emit OrderCancelled(id, msg.sender, refunded);
    }

    /// @notice Anyone settles a quantity-approved order once the retention window ended without a lab result.
    /// @param id Order id.
    function releaseAfterTimeout(uint256 id) external nonReentrant {
        Order storage o = _get(id);
        _requireStatus(o, Status.QuantityApproved);
        uint256 releasableAt = o.approvedAt + o.retentionWindow;
        if (block.timestamp < releasableAt) revert RetentionWindowOpen(id, releasableAt);
        _settle(o);
    }

    // ---------------------------------------------------------------- hooks

    /// @notice Hook from DeliveryRecord when meter and e-BDN agree. Pays the first tranche or opens a dispute.
    /// @param id Order id.
    /// @param deliveredKg Quantity of record (meter reading).
    function onDeliveryVerified(uint256 id, uint256 deliveredKg) external override onlyDelivery nonReentrant {
        Order storage o = _get(id);
        _requireStatus(o, Status.Funded);
        o.deliveredKg = deliveredKg;

        uint256 diff = deliveredKg > o.qtyKg ? deliveredKg - o.qtyKg : o.qtyKg - deliveredKg;
        if (diff > o.qtyKg * o.toleranceBps / 10_000) {
            _openDispute(o, DisputeReason.OUT_OF_TOLERANCE);
            return;
        }

        uint256 payable_ = deliveredKg * o.pricePerTonne / 1000;
        if (payable_ > o.fundedAmount) payable_ = o.fundedAmount;
        uint256 firstTranche = payable_ * (10_000 - o.retentionBps) / 10_000;
        o.payableAmount = payable_;
        o.releasedAmount = firstTranche;
        o.approvedAt = block.timestamp;
        o.status = Status.QuantityApproved;
        if (firstTranche > 0) escrow.release(id, o.supplier, firstTranche);
        emit QuantityApproved(id, deliveredKg, payable_, firstTranche);
    }

    /// @notice Hook from DeliveryRecord when meter and e-BDN disagree. Opens a dispute.
    /// @param id Order id.
    function onQuantityMismatch(uint256 id) external override onlyDelivery nonReentrant {
        Order storage o = _get(id);
        _requireStatus(o, Status.Funded);
        _openDispute(o, DisputeReason.QUANTITY_MISMATCH);
    }

    /// @notice Hook from QualityRecord with the lab verdict. Pass settles the order; fail opens a dispute.
    /// @param id Order id.
    /// @param passed Whether the fuel passed quality testing.
    function onLabResult(uint256 id, bool passed) external override onlyQuality nonReentrant {
        Order storage o = _get(id);
        _requireStatus(o, Status.QuantityApproved);
        if (passed) {
            _settle(o);
        } else {
            _openDispute(o, DisputeReason.QUALITY_FAIL);
        }
    }

    /// @notice Hook from DisputeManager after a manual dispute is opened. Moves the order to `Disputed`.
    /// @param id Order id.
    /// @param disputeId Id of the newly opened dispute.
    function onDisputeOpened(uint256 id, uint256 disputeId) external override onlyDispute {
        Order storage o = _get(id);
        if (o.status != Status.Funded && o.status != Status.QuantityApproved) {
            revert InvalidState(id, Status.Funded, o.status);
        }
        o.status = Status.Disputed;
        o.disputeId = disputeId;
        emit OrderDisputed(id, disputeId);
    }

    /// @notice Hook from DisputeManager after funds were split. `Disputed` -> `Resolved`.
    /// @param id Order id.
    /// @param supplierAmount Amount paid to the supplier by the split.
    /// @param bankAmount Amount returned to the bank by the split.
    function onDisputeResolved(uint256 id, uint256 supplierAmount, uint256 bankAmount)
        external
        override
        onlyDispute
    {
        Order storage o = _get(id);
        _requireStatus(o, Status.Disputed);
        o.releasedAmount += supplierAmount;
        o.refundedAmount += bankAmount;
        o.status = Status.Resolved;
        emit OrderResolved(id, supplierAmount, bankAmount);
    }

    // ---------------------------------------------------------------- views

    /// @notice Full order record.
    /// @param id Order id.
    function getOrder(uint256 id) external view override returns (Order memory) {
        return _get(id);
    }

    /// @notice Number of orders created (ids run 1..orderCount).
    function orderCount() external view returns (uint256) {
        return _count;
    }

    /// @notice Escrowed amount not yet released or refunded: funded - released - refunded.
    /// @param id Order id.
    function heldAmount(uint256 id) external view override returns (uint256) {
        Order storage o = _get(id);
        return o.fundedAmount - o.releasedAmount - o.refundedAmount;
    }

    // ------------------------------------------------------------- internals

    function _get(uint256 id) private view returns (Order storage) {
        if (id == 0 || id > _count) revert InvalidParameter("orderId");
        return _orders[id];
    }

    function _requireStatus(Order storage o, Status expected) private view {
        if (o.status != expected) revert InvalidState(o.id, expected, o.status);
    }

    function _openDispute(Order storage o, DisputeReason reason) private {
        uint256 disputeId = IDisputeManager(disputeManager).openDispute(o.id, reason);
        o.disputeId = disputeId;
        o.status = Status.Disputed;
        emit OrderDisputed(o.id, disputeId);
    }

    /// @dev Pays the retention to the supplier and refunds the unspent funding to the bank.
    function _settle(Order storage o) private {
        uint256 id = o.id;
        uint256 retention = o.payableAmount - o.releasedAmount;
        uint256 excess = o.fundedAmount - o.payableAmount;
        o.releasedAmount += retention;
        o.refundedAmount += excess;
        o.status = Status.Settled;
        if (retention > 0) escrow.release(id, o.supplier, retention);
        if (excess > 0) escrow.refund(id, o.bank, excess);
        bytes32 invoiceHash = keccak256(abi.encode(id, o.dscHash, o.deliveredKg, o.payableAmount, block.timestamp));
        emit OrderSettled(id, o.payableAmount, excess, invoiceHash, DocType.DSI);
    }

    function _emitCreated(Order storage o) private {
        emit OrderCreated(o.id, o.buyer, o.supplier, o.bank, o.qtyKg, o.pricePerTonne, o.dscHash, DocType.DSC);
    }
}
