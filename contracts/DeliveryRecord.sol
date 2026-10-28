// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleGuard} from "./base/RoleGuard.sol";
import {IBunkerOrder} from "./interfaces/IBunkerOrder.sol";
import {IDeliveryRecord} from "./interfaces/IDeliveryRecord.sol";
import {
    Order,
    Status,
    DocType,
    ROLE_METER_ORACLE,
    ROLE_EBDN_ORACLE,
    InvalidState,
    InvalidParameter,
    AlreadySubmitted
} from "./interfaces/BunkerTypes.sol";

/// @title DeliveryRecord
/// @notice Stores meter (BMT) and e-BDN (BDN) evidence and compares them.
contract DeliveryRecord is IDeliveryRecord, RoleGuard {
    struct Delivery {
        uint256 meterKg;
        uint256 ebdnKg;
        bytes32 ticketHash;
        bytes32 ebdnHash;
        bool meterSubmitted;
        bool ebdnSubmitted;
    }

    IBunkerOrder public immutable order;

    mapping(uint256 => Delivery) private _deliveries;

    event MeterReadingSubmitted(
        uint256 indexed id, uint256 qtyKg, bytes32 ticketHash, DocType docType, address indexed oracle
    );
    event EBDNSubmitted(uint256 indexed id, uint256 qtyKg, bytes32 ebdnHash, DocType docType, address indexed oracle);
    event DeliveryVerified(uint256 indexed id, uint256 deliveredKg);
    event QuantityMismatch(uint256 indexed id, uint256 meterKg, uint256 ebdnKg);

    constructor(address registry_, address order_) RoleGuard(registry_) {
        if (order_ == address(0)) revert InvalidParameter("order");
        order = IBunkerOrder(order_);
    }

    /// @notice Record the meter reading (SS 709 BMT). METER_ORACLE only, once per order.
    /// @param id Order id.
    /// @param qtyKg Metered quantity in kilograms.
    /// @param ticketHash Hash of the bunker metering ticket (BMT).
    function submitMeterReading(uint256 id, uint256 qtyKg, bytes32 ticketHash) external {
        _requireRole(ROLE_METER_ORACLE, msg.sender);
        Order memory o = order.getOrder(id);
        Delivery storage d = _deliveries[id];
        if (d.meterSubmitted) revert AlreadySubmitted(id, "meter");
        if (o.status != Status.Funded) revert InvalidState(id, Status.Funded, o.status);
        if (qtyKg == 0) revert InvalidParameter("qtyKg");
        d.meterKg = qtyKg;
        d.ticketHash = ticketHash;
        d.meterSubmitted = true;
        emit MeterReadingSubmitted(id, qtyKg, ticketHash, DocType.BMT, msg.sender);
        if (d.ebdnSubmitted) _compare(id, d, o.toleranceBps);
    }

    /// @notice Record the e-BDN quantity (SS 709 BDN). EBDN_ORACLE only, once per order.
    /// @param id Order id.
    /// @param qtyKg Quantity on the delivery note in kilograms.
    /// @param ebdnHash Hash of the bunker delivery note (BDN).
    function submitEBDN(uint256 id, uint256 qtyKg, bytes32 ebdnHash) external {
        _requireRole(ROLE_EBDN_ORACLE, msg.sender);
        Order memory o = order.getOrder(id);
        Delivery storage d = _deliveries[id];
        if (d.ebdnSubmitted) revert AlreadySubmitted(id, "ebdn");
        if (o.status != Status.Funded) revert InvalidState(id, Status.Funded, o.status);
        if (qtyKg == 0) revert InvalidParameter("qtyKg");
        d.ebdnKg = qtyKg;
        d.ebdnHash = ebdnHash;
        d.ebdnSubmitted = true;
        emit EBDNSubmitted(id, qtyKg, ebdnHash, DocType.BDN, msg.sender);
        if (d.meterSubmitted) _compare(id, d, o.toleranceBps);
    }

    /// @notice Delivery evidence stored for an order.
    /// @param id Order id.
    function getDelivery(uint256 id) external view returns (Delivery memory) {
        return _deliveries[id];
    }

    /// @notice True when any delivery evidence (meter or e-BDN) has been submitted.
    /// @param id Order id.
    function hasEvidence(uint256 id) external view override returns (bool) {
        Delivery storage d = _deliveries[id];
        return d.meterSubmitted || d.ebdnSubmitted;
    }

    function _compare(uint256 id, Delivery storage d, uint16 toleranceBps) private {
        uint256 meter = d.meterKg;
        uint256 ebdn = d.ebdnKg;
        uint256 diff = meter > ebdn ? meter - ebdn : ebdn - meter;
        if (diff > meter * toleranceBps / 10_000) {
            emit QuantityMismatch(id, meter, ebdn);
            order.onQuantityMismatch(id);
        } else {
            emit DeliveryVerified(id, meter);
            order.onDeliveryVerified(id, meter);
        }
    }
}
