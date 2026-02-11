// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/HclawPolicy.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockNadFunLens.sol";
import "./mocks/MockHclawLock.sol";

contract RevertingLens {
    function getCurveState(address)
        external
        pure
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            bool
        )
    {
        revert("lens unavailable");
    }
}

contract HclawPolicyTest {
    MockERC20 internal hclaw;
    MockNadFunLens internal lens;
    MockHclawLock internal lockContract;
    HclawPolicy internal policy;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA901);

    function setUp() public {
        hclaw = new MockERC20("HCLAW", "HCLAW", 18);
        lens = new MockNadFunLens();
        lockContract = new MockHclawLock();

        // Force highest base cap tier in baseline tests.
        lens.setCurveState(address(hclaw), 100_000e18, 1e18, 0, 0, 100_000e18, false);
        policy = new HclawPolicy(address(hclaw), address(lens), address(lockContract));
    }

    function testBaseCapAndUserBoost() public {
        uint256 baseCap = policy.getBaseCapUsd();
        assertEq(baseCap, 100_000e18, "expected tier 3 base cap");

        lockContract.setUserTier(alice, 1);
        lockContract.setUserTier(bob, 2);
        lockContract.setUserTier(carol, 3);

        assertEq(policy.getUserCapUsd(alice), (baseCap * 12_500) / 10_000, "30d boost mismatch");
        assertEq(policy.getUserCapUsd(bob), (baseCap * 17_500) / 10_000, "90d boost mismatch");
        assertEq(policy.getUserCapUsd(carol), (baseCap * 25_000) / 10_000, "180d boost mismatch");
    }

    function testRebateBpsByTier() public {
        lockContract.setUserTier(alice, 1);
        lockContract.setUserTier(bob, 2);
        lockContract.setUserTier(carol, 3);

        assertEq(policy.getUserRebateBps(alice), 1_500, "30d rebate mismatch");
        assertEq(policy.getUserRebateBps(bob), 3_500, "90d rebate mismatch");
        assertEq(policy.getUserRebateBps(carol), 5_500, "180d rebate mismatch");
        assertEq(policy.getUserRebateBps(address(0x1234)), 0, "no-lock rebate mismatch");
    }

    function testLensFailureFallsBackToTierZeroCap() public {
        RevertingLens brokenLens = new RevertingLens();
        HclawPolicy fallbackPolicy = new HclawPolicy(
            address(hclaw),
            address(brokenLens),
            address(lockContract)
        );

        assertEq(fallbackPolicy.getBaseCapUsd(), 100e18, "fallback base cap mismatch");

        lockContract.setUserTier(alice, 3);
        uint256 userCap = fallbackPolicy.getUserCapUsd(alice);
        assertEq(userCap, (100e18 * 25_000) / 10_000, "fallback user cap mismatch");
    }

    function assertEq(uint256 left, uint256 right, string memory reason) internal pure {
        require(left == right, reason);
    }
}
