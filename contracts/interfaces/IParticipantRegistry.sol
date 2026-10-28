// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IParticipantRegistry
/// @notice Read interface of the participant registry used by all modules.
interface IParticipantRegistry {
    function hasActiveRole(bytes32 role, address account) external view returns (bool);

    function hasRole(bytes32 role, address account) external view returns (bool);

    function isSuspended(address account) external view returns (bool);

    function nameOf(address account) external view returns (string memory);
}
