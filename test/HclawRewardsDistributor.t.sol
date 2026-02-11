// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/HclawRewardsDistributor.sol";
import "./mocks/MockERC20.sol";

contract RewardsActor {
    function claim(HclawRewardsDistributor distributor, uint256 epochId) external {
        distributor.claim(epochId);
    }
}

contract HclawRewardsDistributorTest {
    HclawRewardsDistributor internal distributor;
    MockERC20 internal hclaw;
    MockERC20 internal usdc;

    RewardsActor internal alice;

    uint256 internal constant EPOCH_ID = 1;

    function setUp() public {
        hclaw = new MockERC20("HCLAW", "HCLAW", 18);
        usdc = new MockERC20("USDC", "USDC", 6);

        distributor = new HclawRewardsDistributor(address(hclaw), address(usdc));
        alice = new RewardsActor();

        hclaw.mint(address(distributor), 10_000e18);
        usdc.mint(address(distributor), 1_000_000e6);
    }

    function testAllocationAndClaimLifecycle() public {
        distributor.allocate(EPOCH_ID, address(alice), 25e6, 100e18);

        (uint256 rebateClaimable, uint256 incentiveClaimable) = distributor.getClaimable(EPOCH_ID, address(alice));
        assertEq(rebateClaimable, 25e6, "rebate claimable mismatch");
        assertEq(incentiveClaimable, 100e18, "incentive claimable mismatch");

        alice.claim(distributor, EPOCH_ID);

        assertEq(usdc.balanceOf(address(alice)), 25e6, "rebate transfer mismatch");
        assertEq(hclaw.balanceOf(address(alice)), 100e18, "incentive transfer mismatch");

        (bool secondClaimOk, ) = address(alice).call(
            abi.encodeWithSelector(RewardsActor.claim.selector, distributor, EPOCH_ID)
        );
        assertTrue(!secondClaimOk, "expected second claim revert");
    }

    function testPauseBlocksClaims() public {
        distributor.allocate(EPOCH_ID, address(alice), 10e6, 20e18);
        distributor.setPaused(true);

        (bool ok, ) = address(alice).call(
            abi.encodeWithSelector(RewardsActor.claim.selector, distributor, EPOCH_ID)
        );
        assertTrue(!ok, "expected paused claim revert");
    }

    function testBatchAllocationLengthChecks() public {
        address[] memory users = new address[](1);
        users[0] = address(alice);

        uint256[] memory rebates = new uint256[](2);
        rebates[0] = 1e6;
        rebates[1] = 2e6;

        uint256[] memory incentives = new uint256[](1);
        incentives[0] = 1e18;

        (bool ok, ) = address(distributor).call(
            abi.encodeWithSignature(
                "allocateBatch(uint256,address[],uint256[],uint256[])",
                EPOCH_ID,
                users,
                rebates,
                incentives
            )
        );

        assertTrue(!ok, "expected length mismatch revert");
    }

    function assertEq(uint256 left, uint256 right, string memory reason) internal pure {
        require(left == right, reason);
    }

    function assertTrue(bool ok, string memory reason) internal pure {
        require(ok, reason);
    }
}
