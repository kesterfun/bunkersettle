// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISettlementClaim
/// @notice Calls BunkerOrder makes on the settlement claim token.
interface ISettlementClaim {
    function mint(uint256 orderId, address supplier) external;

    function burn(uint256 orderId) external;

    function payeeOf(uint256 orderId) external view returns (address);
}
