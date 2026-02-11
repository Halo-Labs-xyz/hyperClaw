// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockHclawPolicy {
    uint256 public defaultCapUsd = 100e18;
    mapping(address => uint256) public userCaps;

    function setDefaultCapUsd(uint256 capUsd) external {
        defaultCapUsd = capUsd;
    }

    function setUserCapUsd(address user, uint256 capUsd) external {
        userCaps[user] = capUsd;
    }

    function getUserCapUsd(address user) external view returns (uint256) {
        uint256 cap = userCaps[user];
        if (cap == 0) return defaultCapUsd;
        return cap;
    }
}
