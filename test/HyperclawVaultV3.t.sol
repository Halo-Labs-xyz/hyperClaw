// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/HyperclawVaultV3.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockNadFunLens.sol";
import "./mocks/MockHclawPolicy.sol";

contract VaultV3Actor {
    receive() external payable {}

    function depositMon(HyperclawVaultV3 vault, bytes32 agentId) external payable {
        vault.depositMON{value: msg.value}(agentId);
    }

    function withdraw(HyperclawVaultV3 vault, bytes32 agentId, uint256 shares) external {
        vault.withdraw(agentId, shares);
    }

    function monBalance() external view returns (uint256) {
        return address(this).balance;
    }
}

contract HyperclawVaultV3Test {
    HyperclawVaultV3 internal vault;
    MockERC20 internal hclaw;
    MockNadFunLens internal lens;
    MockHclawPolicy internal policy;

    VaultV3Actor internal alice;
    VaultV3Actor internal bob;

    bytes32 internal constant AGENT_A = bytes32(uint256(0xA11CE));

    function setUp() public {
        hclaw = new MockERC20("HCLAW", "HCLAW", 18);
        lens = new MockNadFunLens();
        policy = new MockHclawPolicy();

        vault = new HyperclawVaultV3(address(hclaw), address(lens), address(policy));

        lens.setCurveState(address(hclaw), 100_000e18, 1e18, 0, 0, 100_000e18, false);
        vault.setTokenPrice(address(0), 1e18);

        alice = new VaultV3Actor();
        bob = new VaultV3Actor();

        policy.setDefaultCapUsd(200e18);
        policy.setUserCapUsd(address(alice), 100e18);
        policy.setUserCapUsd(address(bob), 50e18);
    }

    function testEnforcesUserSpecificCapOnDeposit() public {
        alice.depositMon{value: 80 ether}(vault, AGENT_A);

        assertEq(vault.userDepositsUSD(AGENT_A, address(alice)), 80 ether, "alice basis mismatch");

        (bool ok, ) = address(alice).call{value: 30 ether}(
            abi.encodeWithSelector(VaultV3Actor.depositMon.selector, vault, AGENT_A)
        );
        assertTrue(!ok, "expected user cap revert for alice");

        (bool bobOk, ) = address(bob).call{value: 60 ether}(
            abi.encodeWithSelector(VaultV3Actor.depositMon.selector, vault, AGENT_A)
        );
        assertTrue(!bobOk, "expected user cap revert for bob");
    }

    function testWithdrawReducesUserDepositBasis() public {
        alice.depositMon{value: 90 ether}(vault, AGENT_A);
        assertEq(vault.userDepositsUSD(AGENT_A, address(alice)), 90 ether, "basis before withdraw");

        alice.withdraw(vault, AGENT_A, 30 ether);

        assertEq(vault.userDepositsUSD(AGENT_A, address(alice)), 60 ether, "basis after withdraw");
        assertEq(vault.userShares(AGENT_A, address(alice)), 60 ether, "shares after withdraw");
    }

    function testKeepsDepositAndWithdrawCompatibility() public {
        alice.depositMon{value: 40 ether}(vault, AGENT_A);
        bob.depositMon{value: 10 ether}(vault, AGENT_A);

        assertEq(vault.totalShares(AGENT_A), 50 ether, "total shares mismatch");
        assertEq(vault.totalDepositsUSD(AGENT_A), 50 ether, "total deposit basis mismatch");

        alice.withdraw(vault, AGENT_A, 20 ether);

        assertEq(vault.totalShares(AGENT_A), 30 ether, "shares should burn pro-rata");
        assertEq(vault.userDepositsUSD(AGENT_A, address(alice)), 20 ether, "alice basis should reduce");
    }

    function assertEq(uint256 left, uint256 right, string memory reason) internal pure {
        require(left == right, reason);
    }

    function assertTrue(bool ok, string memory reason) internal pure {
        require(ok, reason);
    }
}
