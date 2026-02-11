// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface INadFunLensPolicy {
    function getCurveState(address token)
        external
        view
        returns (
            uint256 virtualMon,
            uint256 virtualToken,
            uint256 realMon,
            uint256 realToken,
            uint256 totalSupply,
            bool isGraduated
        );
}

interface IHclawLockReader {
    function getUserTier(address user) external view returns (uint8);
    function getUserPower(address user) external view returns (uint256);
}

/**
 * @title HclawPolicy
 * @notice Resolves base cap (nad.fun tiers) + lock-based cap/rebate policy.
 */
contract HclawPolicy {
    address public owner;
    address public hclawToken;
    address public nadFunLens;
    address public hclawLock;

    // Base cap tiers in USD 1e18.
    uint256 public constant TIER_0_CAP = 100e18;
    uint256 public constant TIER_1_MCAP = 1_000e18;
    uint256 public constant TIER_1_CAP = 1_000e18;
    uint256 public constant TIER_2_MCAP = 10_000e18;
    uint256 public constant TIER_2_CAP = 10_000e18;
    uint256 public constant TIER_3_MCAP = 50_000e18;
    uint256 public constant TIER_3_CAP = 100_000e18;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event HclawTokenUpdated(address token);
    event NadFunLensUpdated(address lens);
    event HclawLockUpdated(address lockContract);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _hclawToken, address _nadFunLens, address _hclawLock) {
        owner = msg.sender;
        hclawToken = _hclawToken;
        nadFunLens = _nadFunLens;
        hclawLock = _hclawLock;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero owner");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function setHclawToken(address token) external onlyOwner {
        hclawToken = token;
        emit HclawTokenUpdated(token);
    }

    function setNadFunLens(address lens) external onlyOwner {
        nadFunLens = lens;
        emit NadFunLensUpdated(lens);
    }

    function setHclawLock(address lockContract) external onlyOwner {
        hclawLock = lockContract;
        emit HclawLockUpdated(lockContract);
    }

    function getBaseCapUsd() public view returns (uint256) {
        if (hclawToken == address(0) || nadFunLens == address(0)) {
            return TIER_0_CAP;
        }

        try INadFunLensPolicy(nadFunLens).getCurveState(hclawToken) returns (
            uint256 virtualMon,
            uint256 virtualToken,
            uint256,
            uint256,
            uint256 totalSupply,
            bool
        ) {
            uint256 mcap = virtualToken == 0 ? 0 : (virtualMon * totalSupply) / virtualToken;
            if (mcap >= TIER_3_MCAP) return TIER_3_CAP;
            if (mcap >= TIER_2_MCAP) return TIER_2_CAP;
            if (mcap >= TIER_1_MCAP) return TIER_1_CAP;
            return TIER_0_CAP;
        } catch {
            return TIER_0_CAP;
        }
    }

    function getUserTier(address user) public view returns (uint8) {
        if (hclawLock == address(0)) return 0;
        try IHclawLockReader(hclawLock).getUserTier(user) returns (uint8 tier) {
            return tier;
        } catch {
            return 0;
        }
    }

    function getUserPower(address user) external view returns (uint256) {
        if (hclawLock == address(0)) return 0;
        try IHclawLockReader(hclawLock).getUserPower(user) returns (uint256 power) {
            return power;
        } catch {
            return 0;
        }
    }

    function getUserCapUsd(address user) external view returns (uint256) {
        uint256 baseCap = getBaseCapUsd();
        uint16 boostBps = getUserBoostBps(user);
        return (baseCap * uint256(boostBps)) / 10_000;
    }

    function getUserBoostBps(address user) public view returns (uint16) {
        uint8 tier = getUserTier(user);
        if (tier == 1) return 12_500; // 30d
        if (tier == 2) return 17_500; // 90d
        if (tier == 3) return 25_000; // 180d
        return 10_000; // no lock
    }

    function getUserRebateBps(address user) external view returns (uint16) {
        uint8 tier = getUserTier(user);
        if (tier == 1) return 1_500; // 15%
        if (tier == 2) return 3_500; // 35%
        if (tier == 3) return 5_500; // 55%
        return 0;
    }
}
