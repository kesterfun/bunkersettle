// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPaymentEscrow
/// @notice Token custody per order.
interface IPaymentEscrow {
    function deposit(uint256 id, address from, uint256 amount) external;

    function release(uint256 id, address to, uint256 amount) external;

    function refund(uint256 id, address to, uint256 amount) external;

    function split(uint256 id, address supplier, uint256 supplierAmt, address bank, uint256 bankAmt) external;

    function balanceOf(uint256 id) external view returns (uint256);
}
