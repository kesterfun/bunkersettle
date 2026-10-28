// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RoleGuard} from "./base/RoleGuard.sol";
import {IBunkerOrder} from "./interfaces/IBunkerOrder.sol";
import {
    Order,
    Status,
    DocType,
    ROLE_LAB,
    InvalidState,
    InvalidParameter,
    AlreadySubmitted
} from "./interfaces/BunkerTypes.sol";

/// @title QualityRecord
/// @notice Stores the lab verdict (SS 709 QTR / CoQ report hash) and informs BunkerOrder.
contract QualityRecord is RoleGuard {
    struct Result {
        bool submitted;
        bool passed;
        bytes32 reportHash;
        address lab;
        uint256 submittedAt;
    }

    IBunkerOrder public immutable order;

    mapping(uint256 => Result) private _results;

    event LabResultSubmitted(uint256 indexed id, bool passed, bytes32 reportHash, address indexed lab, DocType docType);

    constructor(address registry_, address order_) RoleGuard(registry_) {
        if (order_ == address(0)) revert InvalidParameter("order");
        order = IBunkerOrder(order_);
    }

    /// @notice Submit the lab result. LAB only, once per order, order must be `QuantityApproved`.
    /// @param id Order id.
    /// @param passed Whether the fuel passed.
    /// @param reportHash Hash of the quality test report (QTR).
    function submitLabResult(uint256 id, bool passed, bytes32 reportHash) external {
        _requireRole(ROLE_LAB, msg.sender);
        Order memory o = order.getOrder(id);
        Result storage r = _results[id];
        if (r.submitted) revert AlreadySubmitted(id, "lab");
        if (o.status != Status.QuantityApproved) revert InvalidState(id, Status.QuantityApproved, o.status);
        r.submitted = true;
        r.passed = passed;
        r.reportHash = reportHash;
        r.lab = msg.sender;
        r.submittedAt = block.timestamp;
        emit LabResultSubmitted(id, passed, reportHash, msg.sender, DocType.QTR);
        order.onLabResult(id, passed);
    }

    /// @notice Lab result stored for an order.
    /// @param id Order id.
    function getResult(uint256 id) external view returns (Result memory) {
        return _results[id];
    }
}
