// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Order} from "./BunkerTypes.sol";

/// @title IBunkerOrder
/// @notice Views and module hooks of BunkerOrder.
interface IBunkerOrder {
    function getOrder(uint256 id) external view returns (Order memory);

    function heldAmount(uint256 id) external view returns (uint256);

    function onDeliveryVerified(uint256 id, uint256 deliveredKg) external;

    function onQuantityMismatch(uint256 id) external;

    function onLabResult(uint256 id, bool passed) external;

    function onDisputeOpened(uint256 id, uint256 disputeId) external;

    function onDisputeResolved(uint256 id, uint256 supplierAmount, uint256 bankAmount) external;
}
