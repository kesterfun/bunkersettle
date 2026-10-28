// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDeliveryRecord
/// @notice View used by BunkerOrder to learn whether any delivery evidence exists.
interface IDeliveryRecord {
    function hasEvidence(uint256 id) external view returns (bool);
}
