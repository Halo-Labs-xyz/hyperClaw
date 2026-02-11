// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/HclawLock.sol";
import "./mocks/MockERC20.sol";

interface Vm {
    function warp(uint256 newTimestamp) external;
}

contract LockActor {
    receive() external payable {}

    function approveToken(address token, address spender, uint256 amount) external {
        MockERC20(token).approve(spender, amount);
    }

    function createLock(HclawLock lockContract, uint256 amount, uint16 durationDays) external returns (uint256) {
        return lockContract.lock(amount, durationDays);
    }

    function extendLock(HclawLock lockContract, uint256 lockId, uint16 durationDays) external {
        lockContract.extendLock(lockId, durationDays);
    }

    function increaseLock(HclawLock lockContract, uint256 lockId, uint256 amount) external {
        lockContract.increaseLock(lockId, amount);
    }

    function unlockLock(HclawLock lockContract, uint256 lockId) external {
        lockContract.unlock(lockId);
    }
}

contract HclawLockTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockERC20 internal hclaw;
    HclawLock internal lockContract;
    LockActor internal alice;

    function setUp() public {
        hclaw = new MockERC20("HCLAW", "HCLAW", 18);
        lockContract = new HclawLock(address(hclaw));
        alice = new LockActor();

        hclaw.mint(address(alice), 1_000e18);
        alice.approveToken(address(hclaw), address(lockContract), type(uint256).max);
    }

    function testLockLifecycleAndPowerDecay() public {
        uint256 lockId = alice.createLock(lockContract, 100e18, 30);

        uint256 powerAtStart = lockContract.getUserPower(address(alice));
        assertTrue(powerAtStart > 0, "power should be non-zero");
        assertEq(lockContract.getUserTier(address(alice)), 1, "expected 30d tier");

        vm.warp(block.timestamp + 15 days);
        uint256 midPower = lockContract.getUserPower(address(alice));
        assertTrue(midPower > 0, "mid power should be positive");
        assertTrue(midPower < powerAtStart, "power should decay over time");

        (bool earlyUnlockOk, ) = address(alice).call(
            abi.encodeWithSelector(LockActor.unlockLock.selector, lockContract, lockId)
        );
        assertTrue(!earlyUnlockOk, "expected early unlock revert");

        vm.warp(block.timestamp + 16 days);
        assertEq(lockContract.getUserPower(address(alice)), 0, "power should decay to zero");

        uint256 beforeBal = hclaw.balanceOf(address(alice));
        alice.unlockLock(lockContract, lockId);
        uint256 afterBal = hclaw.balanceOf(address(alice));
        assertEq(afterBal - beforeBal, 100e18, "unlock amount mismatch");
    }

    function testExtendAndIncreaseLock() public {
        uint256 lockId = alice.createLock(lockContract, 100e18, 30);

        vm.warp(block.timestamp + 10 days);
        alice.extendLock(lockContract, lockId, 180);

        assertEq(lockContract.getUserTier(address(alice)), 3, "expected 180d tier");

        alice.increaseLock(lockContract, lockId, 50e18);

        (, , uint256 amount, , , uint16 durationDays, uint16 multiplierBps, ) = lockContract.locks(lockId);
        assertEq(amount, 150e18, "amount should increase");
        assertEq(uint256(durationDays), 180, "duration should be updated");
        assertEq(uint256(multiplierBps), 25_000, "multiplier should match 180d");
    }

    function testRejectsInvalidDuration() public {
        (bool ok, ) = address(alice).call(
            abi.encodeWithSelector(LockActor.createLock.selector, lockContract, 10e18, uint16(45))
        );
        assertTrue(!ok, "expected invalid duration revert");
    }

    function assertEq(uint256 left, uint256 right, string memory reason) internal pure {
        require(left == right, reason);
    }

    function assertTrue(bool ok, string memory reason) internal pure {
        require(ok, reason);
    }
}
