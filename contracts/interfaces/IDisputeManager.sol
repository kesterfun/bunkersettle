// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DisputeReason} from "./BunkerTypes.sol";

/// @title IDisputeManager
/// @notice Entry point used by BunkerOrder to open disputes automatically.
interface IDisputeManager {
    function openDispute(uint256 orderId, DisputeReason reason) external returns (uint256 disputeId);
}
