// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/AgenticLPVault.sol";

contract ExecutorActor {
    function reportRisk(AgenticLPVault vault, uint16 skew, uint16 turnover, uint16 drawdown) external {
        vault.reportRisk(skew, turnover, drawdown);
    }

    function execute(AgenticLPVault vault, bytes32 planHash, int256 pnlUsd) external {
        vault.execute(planHash, pnlUsd);
    }
}

contract AgenticLPVaultTest {
    AgenticLPVault internal vault;
    ExecutorActor internal executor;

    function setUp() public {
        executor = new ExecutorActor();
        vault = new AgenticLPVault(address(executor));
    }

    function testExecutionWorksWithinLimits() public {
        executor.reportRisk(vault, 1_000, 1_500, 500);
        executor.execute(vault, bytes32(uint256(1)), int256(250e18));

        (, , , , , int256 cumulativePnl, uint256 lastExecTs) = vault.getStatus();
        assertEqSigned(cumulativePnl, int256(250e18), "pnl mismatch");
        assertTrue(lastExecTs > 0, "execution timestamp should be set");
    }

    function testKillSwitchAndPauseBlockExecution() public {
        executor.reportRisk(vault, 100, 100, 100);

        vault.setPaused(true);
        (bool pausedOk, ) = address(executor).call(
            abi.encodeWithSelector(ExecutorActor.execute.selector, vault, bytes32(uint256(2)), int256(1))
        );
        assertTrue(!pausedOk, "expected paused execution revert");

        vault.setPaused(false);
        vault.setKillSwitch(true);

        (bool killOk, ) = address(executor).call(
            abi.encodeWithSelector(ExecutorActor.execute.selector, vault, bytes32(uint256(3)), int256(1))
        );
        assertTrue(!killOk, "expected kill-switch execution revert");
    }

    function testRiskBoundChecksAreEnforced() public {
        vault.setRiskLimits(500, 500, 500);
        executor.reportRisk(vault, 600, 100, 100);

        (bool ok, ) = address(executor).call(
            abi.encodeWithSelector(ExecutorActor.execute.selector, vault, bytes32(uint256(4)), int256(1))
        );

        assertTrue(!ok, "expected inventory risk revert");
    }

    function assertTrue(bool ok, string memory reason) internal pure {
        require(ok, reason);
    }

    function assertEqSigned(int256 left, int256 right, string memory reason) internal pure {
        require(left == right, reason);
    }
}
