// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockHclawLock {
    mapping(address => uint8) public tiers;
    mapping(address => uint256) public powers;

    function setUserTier(address user, uint8 tier) external {
        tiers[user] = tier;
    }

    function setUserPower(address user, uint256 power) external {
        powers[user] = power;
    }

    function getUserTier(address user) external view returns (uint8) {
        return tiers[user];
    }

    function getUserPower(address user) external view returns (uint256) {
        return powers[user];
    }
}
