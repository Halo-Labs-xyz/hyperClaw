// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../contracts/HyperclawVaultV2.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockNadFunLens.sol";

interface Vm {
    function warp(uint256 newTimestamp) external;
}

contract Actor {
    receive() external payable {}

    function depositMon(HyperclawVaultV2 vault, bytes32 agentId) external payable {
        vault.depositMON{value: msg.value}(agentId);
    }

    function depositToken(
        HyperclawVaultV2 vault,
        bytes32 agentId,
        address token,
        uint256 amount
    ) external {
        (bool okApprove, bytes memory approveData) = token.call(
            abi.encodeWithSignature("approve(address,uint256)", address(vault), amount)
        );
        require(okApprove, "approve call failed");
        if (approveData.length > 0) {
            require(abi.decode(approveData, (bool)), "approve returned false");
        }

        vault.depositERC20(agentId, token, amount);
    }

    function withdraw(HyperclawVaultV2 vault, bytes32 agentId, uint256 shares) external {
        vault.withdraw(agentId, shares);
    }

    function tokenBalance(address token) external view returns (uint256) {
        return MockERC20(token).balanceOf(address(this));
    }

    function monBalance() external view returns (uint256) {
        return address(this).balance;
    }
}

contract HyperclawVaultV2Test {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    HyperclawVaultV2 internal vault;
    MockERC20 internal usdc;
    MockERC20 internal badToken;
    MockERC20 internal hclaw;
    MockNadFunLens internal lens;

    Actor internal alice;
    Actor internal bob;

    bytes32 internal constant AGENT_A = bytes32(uint256(0xA11CE));
    bytes32 internal constant AGENT_B = bytes32(uint256(0xB0B));

    function setUp() public {
        hclaw = new MockERC20("HCLAW", "HCLAW", 18);
        usdc = new MockERC20("USDC", "USDC", 6);
        badToken = new MockERC20("BAD", "BAD", 18);
        lens = new MockNadFunLens();

        vault = new HyperclawVaultV2(address(hclaw), address(lens));

        // Ensure we hit highest cap tier in tests.
        lens.setCurveState(address(hclaw), 100_000e18, 1e18, 0, 0, 100_000e18, false);

        // Configure price feed: 1 MON = $1, 1 USDC = $1.
        vault.setTokenPrice(address(0), 1e18);
        vault.setTokenPrice(address(usdc), 1e18);

        vault.whitelistToken(address(usdc), true);

        alice = new Actor();
        bob = new Actor();
    }

    function testDepositMonMintsShares() public {
        alice.depositMon{value: 10 ether}(vault, AGENT_A);

        assertEq(vault.totalShares(AGENT_A), 10 ether, "total shares");
        assertEq(vault.userShares(AGENT_A, address(alice)), 10 ether, "alice shares");
        assertEq(vault.totalDepositsUSD(AGENT_A), 10 ether, "agent net deposits usd");
        assertEq(vault.agentMonBalance(AGENT_A), 10 ether, "agent mon balance");
        assertEq(vault.depositorCount(AGENT_A), 1, "depositor count");
    }

    function testDepositErc20AndWithdrawProRataAcrossAssets() public {
        // Alice deposits MON.
        alice.depositMon{value: 10 ether}(vault, AGENT_A);

        // Bob deposits 10 USDC (6 decimals).
        usdc.mint(address(bob), 10 * 1e6);
        bob.depositToken(vault, AGENT_A, address(usdc), 10 * 1e6);

        assertEq(vault.totalShares(AGENT_A), 20 ether, "shares after two deposits");

        // Alice withdraws all her shares (50% of vault).
        alice.withdraw(vault, AGENT_A, 10 ether);

        assertEq(alice.monBalance(), 5 ether, "alice mon withdrawal");
        assertEq(usdc.balanceOf(address(alice)), 5 * 1e6, "alice usdc withdrawal");

        assertEq(vault.userShares(AGENT_A, address(alice)), 0, "alice shares burned");
        assertEq(vault.depositorCount(AGENT_A), 1, "depositor count after full withdrawal");
    }

    function testAgentBalancesAreIsolated() public {
        alice.depositMon{value: 8 ether}(vault, AGENT_A);
        bob.depositMon{value: 12 ether}(vault, AGENT_B);

        alice.withdraw(vault, AGENT_A, vault.userShares(AGENT_A, address(alice)));

        assertEq(alice.monBalance(), 8 ether, "alice receives only agent A assets");
        assertEq(vault.agentMonBalance(AGENT_A), 0, "agent A mon drained");
        assertEq(vault.agentMonBalance(AGENT_B), 12 ether, "agent B mon untouched");
    }

    function testShareMintUsesCurrentTvlAfterPriceMove() public {
        alice.depositMon{value: 10 ether}(vault, AGENT_A);
        assertEq(vault.userShares(AGENT_A, address(alice)), 10 ether, "alice initial shares");

        // MON price doubles before Bob deposits.
        vault.setTokenPrice(address(0), 2e18);
        bob.depositMon{value: 10 ether}(vault, AGENT_A);

        // Bob's deposit is worth $20 at deposit time, and existing TVL is also $20,
        // so Bob should mint 10 shares (not 20).
        assertEq(vault.userShares(AGENT_A, address(bob)), 10 ether, "bob shares at new price");
        assertEq(vault.totalShares(AGENT_A), 20 ether, "total shares");

        // With 50% shares, Bob should receive exactly half of MON on withdraw.
        bob.withdraw(vault, AGENT_A, 10 ether);
        assertEq(bob.monBalance(), 10 ether, "bob gets fair pro-rata MON");
    }

    function testRevertsOnStalePrice() public {
        vault.setMaxPriceAge(60);
        vm.warp(block.timestamp + 61);

        (bool ok, ) = address(alice).call{value: 1 ether}(
            abi.encodeWithSelector(Actor.depositMon.selector, vault, AGENT_A)
        );
        assertTrue(!ok, "expected stale-price deposit revert");
    }

    function testRejectsUnwhitelistedToken() public {
        badToken.mint(address(alice), 2 ether);

        (bool ok, ) = address(alice).call(
            abi.encodeWithSelector(
                Actor.depositToken.selector,
                vault,
                AGENT_A,
                address(badToken),
                1 ether
            )
        );
        assertTrue(!ok, "expected unwhitelisted token revert");
    }

    // --- Minimal assertions (no forge-std dependency) ---

    function assertEq(uint256 left, uint256 right, string memory reason) internal pure {
        require(left == right, reason);
    }

    function assertTrue(bool ok, string memory reason) internal pure {
        require(ok, reason);
    }
}
