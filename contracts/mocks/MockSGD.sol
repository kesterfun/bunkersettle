// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockSGD
/// @notice Test-only mock SGD stablecoin; not for production use.
// TODO(milestone 2)
contract MockSGD is ERC20 {
    constructor() ERC20("Mock SGD", "mSGD") {}
}
