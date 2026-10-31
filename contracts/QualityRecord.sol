// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SignedRoleGuard} from "./base/SignedRoleGuard.sol";
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
contract QualityRecord is SignedRoleGuard {
    struct Result {
        bool submitted;
        bool passed;
        bytes32 reportHash;
        address lab;
        uint256 submittedAt;
    }

    bytes32 public constant LAB_TYPEHASH = keccak256("LabResult(uint256 id,bool passed,bytes32 reportHash,uint256 deadline)");

    IBunkerOrder public immutable order;

    mapping(uint256 => Result) private _results;

    event LabResultSubmitted(uint256 indexed id, bool passed, bytes32 reportHash, address indexed lab, DocType docType);

    constructor(address registry_, address order_) SignedRoleGuard(registry_, "BunkerSettle QualityRecord") {
        if (order_ == address(0)) revert InvalidParameter("order");
        order = IBunkerOrder(order_);
    }

    /// @notice Submit the lab result. LAB only, once per order, order must be `QuantityApproved`.
    /// @param id Order id.
    /// @param passed Whether the fuel passed.
    /// @param reportHash Hash of the quality test report (QTR).
    function submitLabResult(uint256 id, bool passed, bytes32 reportHash) external {
        _requireRole(ROLE_LAB, msg.sender);
        _submitLab(id, passed, reportHash, msg.sender);
    }

    /// @notice Same as `submitLabResult`, but sent by any relayer with the LAB's EIP-712 signature.
    ///         The recovered signer must hold the role and is recorded as the lab.
    /// @param id Order id.
    /// @param passed Whether the fuel passed.
    /// @param reportHash Hash of the quality test report (QTR).
    /// @param deadline Unix time after which the signature is rejected.
    /// @param signature EIP-712 `LabResult` signature by the lab.
    function submitLabResultBySig(
        uint256 id,
        bool passed,
        bytes32 reportHash,
        uint256 deadline,
        bytes calldata signature
    ) external {
        address signer = _verifySigned(
            ROLE_LAB, keccak256(abi.encode(LAB_TYPEHASH, id, passed, reportHash, deadline)), deadline, signature
        );
        _submitLab(id, passed, reportHash, signer);
    }

    function _submitLab(uint256 id, bool passed, bytes32 reportHash, address lab) private {
        Order memory o = order.getOrder(id);
        Result storage r = _results[id];
        if (r.submitted) revert AlreadySubmitted(id, "lab");
        if (o.status != Status.QuantityApproved) revert InvalidState(id, Status.QuantityApproved, o.status);
        r.submitted = true;
        r.passed = passed;
        r.reportHash = reportHash;
        r.lab = lab;
        r.submittedAt = block.timestamp;
        emit LabResultSubmitted(id, passed, reportHash, lab, DocType.QTR);
        order.onLabResult(id, passed);
    }

    /// @notice Lab result stored for an order.
    /// @param id Order id.
    function getResult(uint256 id) external view returns (Result memory) {
        return _results[id];
    }
}
