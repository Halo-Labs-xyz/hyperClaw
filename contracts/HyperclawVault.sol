// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface INadFunLens {
    function getCurveState(address token) external view returns (
        uint256 virtualMon,
        uint256 virtualToken,
        uint256 realMon,
        uint256 realToken,
        uint256 totalSupply,
        bool isGraduated
    );
}

/**
 * @title HyperclawVault
 * @notice Multi-token vault on Monad with $HCLAW market-cap-scaled deposit caps.
 *         Users deposit MON/ERC20s to unlock Hyperliquid perp trading liquidity.
 *         Share-based accounting; PnL attributed off-chain from HL agent performance.
 */
contract HyperclawVault {
    address public owner;
    address public hclawToken;
    address public nadFunLens;

    // Whitelisted ERC20 tokens for deposit
    mapping(address => bool) public whitelistedTokens;

    // Per-agent vault state
    mapping(bytes32 => mapping(address => uint256)) public userShares;
    mapping(bytes32 => uint256) public totalShares;
    mapping(bytes32 => uint256) public totalDepositsUSD;

    // Deposit cap tiers (in USD with 18 decimals)
    uint256 constant TIER_0_CAP = 100e18;       // $100
    uint256 constant TIER_1_MCAP = 1_000e18;    // $1K mcap threshold
    uint256 constant TIER_1_CAP = 1_000e18;     // $1K cap
    uint256 constant TIER_2_MCAP = 10_000e18;   // $10K mcap threshold
    uint256 constant TIER_2_CAP = 10_000e18;    // $10K cap
    uint256 constant TIER_3_MCAP = 50_000e18;   // $50K mcap threshold
    uint256 constant TIER_3_CAP = 100_000e18;   // $100K cap
    uint256 constant MIN_MON_DEPOSIT = 450e18;

    event Deposited(bytes32 indexed agentId, address indexed user, address token, uint256 amount, uint256 shares);
    event Withdrawn(bytes32 indexed agentId, address indexed user, uint256 shares, uint256 monAmount);
    event CapTierUnlocked(uint256 newMaxDeposit, uint256 hclawMarketCap);
    event TokenWhitelisted(address token, bool status);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _hclawToken, address _nadFunLens) {
        owner = msg.sender;
        hclawToken = _hclawToken;
        nadFunLens = _nadFunLens;
    }

    // ============================================
    // Admin
    // ============================================

    function whitelistToken(address token, bool status) external onlyOwner {
        whitelistedTokens[token] = status;
        emit TokenWhitelisted(token, status);
    }

    function setHclawToken(address _token) external onlyOwner {
        hclawToken = _token;
    }

    function setNadFunLens(address _lens) external onlyOwner {
        nadFunLens = _lens;
    }

    // ============================================
    // Deposit Cap (reads $HCLAW market cap on-chain)
    // ============================================

    function getMaxDepositUSD() public view returns (uint256) {
        if (hclawToken == address(0) || nadFunLens == address(0)) {
            return TIER_0_CAP;
        }

        try INadFunLens(nadFunLens).getCurveState(hclawToken) returns (
            uint256 virtualMon,
            uint256,
            uint256,
            uint256,
            uint256 totalSupply,
            bool
        ) {
            // Simplified mcap: virtualMon * totalSupply / virtualToken
            // For hackathon, use simplified calculation
            uint256 mcap = virtualMon * totalSupply / 1e18;

            if (mcap >= TIER_3_MCAP) return TIER_3_CAP;
            if (mcap >= TIER_2_MCAP) return TIER_2_CAP;
            if (mcap >= TIER_1_MCAP) return TIER_1_CAP;
            return TIER_0_CAP;
        } catch {
            return TIER_0_CAP;
        }
    }

    // ============================================
    // Deposits
    // ============================================

    function depositMON(bytes32 agentId) external payable {
        require(msg.value >= MIN_MON_DEPOSIT, "Min deposit 450 MON");

        // For hackathon: 1 MON ~= $1 USD (simplified)
        uint256 usdValue = msg.value;
        uint256 maxCap = getMaxDepositUSD();
        require(totalDepositsUSD[agentId] + usdValue <= maxCap, "Exceeds vault cap");

        uint256 shares = _calculateShares(agentId, usdValue);
        userShares[agentId][msg.sender] += shares;
        totalShares[agentId] += shares;
        totalDepositsUSD[agentId] += usdValue;

        emit Deposited(agentId, msg.sender, address(0), msg.value, shares);
    }

    function depositERC20(bytes32 agentId, address token, uint256 amount) external {
        require(whitelistedTokens[token], "Token not whitelisted");
        require(amount > 0, "Zero deposit");

        IERC20(token).transferFrom(msg.sender, address(this), amount);

        // Calculate USD value based on token decimals
        uint8 decimals = IERC20(token).decimals();
        uint256 usdValue = amount * 1e18 / (10 ** decimals);

        uint256 maxCap = getMaxDepositUSD();
        require(totalDepositsUSD[agentId] + usdValue <= maxCap, "Exceeds vault cap");

        uint256 shares = _calculateShares(agentId, usdValue);
        userShares[agentId][msg.sender] += shares;
        totalShares[agentId] += shares;
        totalDepositsUSD[agentId] += usdValue;

        emit Deposited(agentId, msg.sender, token, amount, shares);
    }

    // ============================================
    // Withdrawal
    // ============================================

    function withdraw(bytes32 agentId, uint256 shares) external {
        require(shares > 0, "Zero shares");
        require(userShares[agentId][msg.sender] >= shares, "Insufficient shares");

        uint256 total = totalShares[agentId];
        uint256 monBalance = address(this).balance;

        // Proportional withdrawal from MON balance
        uint256 monAmount = (monBalance * shares) / total;

        userShares[agentId][msg.sender] -= shares;
        totalShares[agentId] -= shares;

        // Reduce tracked deposits proportionally
        uint256 depositReduction = (totalDepositsUSD[agentId] * shares) / total;
        totalDepositsUSD[agentId] -= depositReduction;

        payable(msg.sender).transfer(monAmount);

        emit Withdrawn(agentId, msg.sender, shares, monAmount);
    }

    // ============================================
    // View functions
    // ============================================

    function getUserSharePercent(bytes32 agentId, address user) external view returns (uint256) {
        uint256 total = totalShares[agentId];
        if (total == 0) return 0;
        return (userShares[agentId][user] * 10000) / total; // basis points
    }

    function getVaultTVL(bytes32 agentId) external view returns (uint256) {
        return totalDepositsUSD[agentId];
    }

    // ============================================
    // Internal
    // ============================================

    function _calculateShares(bytes32 agentId, uint256 usdValue) internal view returns (uint256) {
        if (totalShares[agentId] == 0) {
            return usdValue; // 1:1 for first deposit
        }
        // Proportional to existing deposits
        return (usdValue * totalShares[agentId]) / totalDepositsUSD[agentId];
    }

    receive() external payable {}
}
