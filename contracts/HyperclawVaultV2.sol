// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
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
 * @title HyperclawVaultV2
 * @notice Production-hardened multi-asset vault with per-agent balance segregation.
 *
 * Key safety properties:
 * - Per-agent asset accounting (MON + whitelisted ERC20 balances are isolated by agentId)
 * - Share mint/burn against tracked TVL (USD 1e18) with stale-price checks
 * - Pro-rata withdrawals across all assets (no cross-subsidy from pooled MON)
 * - Reentrancy protection and safe token transfer wrappers
 */
contract HyperclawVaultV2 {
    address public owner;
    address public hclawToken;
    address public nadFunLens;

    // Whitelisted ERC20s accepted for deposit.
    mapping(address => bool) public whitelistedTokens;
    address[] private supportedTokens;
    mapping(address => uint256) private tokenIndexPlusOne;

    // Per-agent share ledger.
    mapping(bytes32 => mapping(address => uint256)) public userShares;
    mapping(bytes32 => uint256) public totalShares;
    // Net deposit basis in USD 1e18 (used for cap enforcement and historical accounting).
    mapping(bytes32 => uint256) public totalDepositsUSD;

    // Per-agent asset balances (segregated accounting).
    mapping(bytes32 => uint256) public agentMonBalance;
    mapping(bytes32 => mapping(address => uint256)) public agentTokenBalance;

    // Per-agent unique depositor tracking.
    mapping(bytes32 => mapping(address => bool)) private hasDeposited;
    mapping(bytes32 => uint256) public depositorCount;

    // Token oracle prices in USD 1e18.
    struct TokenPrice {
        uint256 usdPriceE18;
        uint64 updatedAt;
    }
    mapping(address => TokenPrice) public tokenPrices; // token=address(0) for MON
    uint256 public maxPriceAge = 1 hours;

    // Deposit cap tiers (USD 1e18).
    uint256 constant TIER_0_CAP = 100e18;       // $100
    uint256 constant TIER_1_MCAP = 1_000e18;    // $1K mcap threshold
    uint256 constant TIER_1_CAP = 1_000e18;     // $1K cap
    uint256 constant TIER_2_MCAP = 10_000e18;   // $10K mcap threshold
    uint256 constant TIER_2_CAP = 10_000e18;    // $10K cap
    uint256 constant TIER_3_MCAP = 50_000e18;   // $50K mcap threshold
    uint256 constant TIER_3_CAP = 100_000e18;   // $100K cap
    uint256 constant MIN_MON_DEPOSIT = 450e18;

    uint256 constant MAX_SUPPORTED_TOKENS = 24;

    // Simple non-reentrant guard.
    bool private locked;

    event Deposited(bytes32 indexed agentId, address indexed user, address token, uint256 amount, uint256 shares);
    event Withdrawn(bytes32 indexed agentId, address indexed user, uint256 shares, uint256 monAmount);
    event WithdrawalAsset(bytes32 indexed agentId, address indexed user, address token, uint256 amount);
    event TokenWhitelisted(address token, bool status);
    event TokenPriceUpdated(address indexed token, uint256 usdPriceE18, uint64 updatedAt);
    event MaxPriceAgeUpdated(uint256 maxPriceAgeSeconds);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event CapTierUnlocked(uint256 newMaxDeposit, uint256 hclawMarketCap);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "Reentrant");
        locked = true;
        _;
        locked = false;
    }

    constructor(address _hclawToken, address _nadFunLens) {
        owner = msg.sender;
        hclawToken = _hclawToken;
        nadFunLens = _nadFunLens;
    }

    // ============================================
    // Admin
    // ============================================

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero owner");
        address old = owner;
        owner = newOwner;
        emit OwnershipTransferred(old, newOwner);
    }

    function setHclawToken(address _token) external onlyOwner {
        hclawToken = _token;
    }

    function setNadFunLens(address _lens) external onlyOwner {
        nadFunLens = _lens;
    }

    function whitelistToken(address token, bool status) external onlyOwner {
        require(token != address(0), "Use MON deposit");
        whitelistedTokens[token] = status;

        if (status && tokenIndexPlusOne[token] == 0) {
            require(supportedTokens.length < MAX_SUPPORTED_TOKENS, "Too many tokens");
            supportedTokens.push(token);
            tokenIndexPlusOne[token] = supportedTokens.length;
        }

        emit TokenWhitelisted(token, status);
    }

    function setTokenPrice(address token, uint256 usdPriceE18) external onlyOwner {
        require(usdPriceE18 > 0, "Zero price");
        tokenPrices[token] = TokenPrice({
            usdPriceE18: usdPriceE18,
            updatedAt: uint64(block.timestamp)
        });
        emit TokenPriceUpdated(token, usdPriceE18, uint64(block.timestamp));
    }

    function setMaxPriceAge(uint256 secondsAge) external onlyOwner {
        require(secondsAge >= 60, "Too small");
        require(secondsAge <= 7 days, "Too large");
        maxPriceAge = secondsAge;
        emit MaxPriceAgeUpdated(secondsAge);
    }

    // ============================================
    // Deposit Cap
    // ============================================

    function getMaxDepositUSD() public view returns (uint256) {
        if (hclawToken == address(0) || nadFunLens == address(0)) {
            return TIER_0_CAP;
        }

        try INadFunLens(nadFunLens).getCurveState(hclawToken) returns (
            uint256 virtualMon,
            uint256 virtualToken,
            uint256,
            uint256,
            uint256 totalSupply,
            bool
        ) {
            // Approximate market cap from virtual reserves.
            uint256 mcap = virtualToken == 0 ? 0 : (virtualMon * totalSupply) / virtualToken;

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

    function depositMON(bytes32 agentId) external payable nonReentrant {
        require(msg.value >= MIN_MON_DEPOSIT, "Min deposit 450 MON");
        uint256 usdValue = _tokenToUsd(address(0), msg.value);
        _deposit(agentId, address(0), msg.value, usdValue);
        agentMonBalance[agentId] += msg.value;
    }

    function depositERC20(bytes32 agentId, address token, uint256 amount) external nonReentrant {
        require(whitelistedTokens[token], "Token not whitelisted");
        require(amount > 0, "Zero deposit");

        uint256 beforeBal = IERC20Minimal(token).balanceOf(address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 afterBal = IERC20Minimal(token).balanceOf(address(this));
        require(afterBal > beforeBal, "No tokens received");
        uint256 received = afterBal - beforeBal;

        uint256 usdValue = _tokenToUsd(token, received);
        _deposit(agentId, token, received, usdValue);
        agentTokenBalance[agentId][token] += received;
    }

    function _deposit(bytes32 agentId, address token, uint256 amount, uint256 usdValue) internal {
        require(usdValue > 0, "Zero USD value");
        uint256 maxCap = getMaxDepositUSD();
        require(totalDepositsUSD[agentId] + usdValue <= maxCap, "Exceeds vault cap");

        uint256 shares = _calculateShares(agentId, usdValue);
        require(shares > 0, "Deposit too small");

        userShares[agentId][msg.sender] += shares;
        totalShares[agentId] += shares;
        totalDepositsUSD[agentId] += usdValue;

        if (!hasDeposited[agentId][msg.sender]) {
            hasDeposited[agentId][msg.sender] = true;
            depositorCount[agentId] += 1;
        }

        emit Deposited(agentId, msg.sender, token, amount, shares);
    }

    // ============================================
    // Withdrawals
    // ============================================

    function withdraw(bytes32 agentId, uint256 shares) external nonReentrant {
        require(shares > 0, "Zero shares");
        uint256 userShare = userShares[agentId][msg.sender];
        require(userShare >= shares, "Insufficient shares");

        uint256 total = totalShares[agentId];
        require(total > 0, "No shares");

        uint256 monAmount = (agentMonBalance[agentId] * shares) / total;
        uint256[] memory tokenAmounts = new uint256[](supportedTokens.length);

        // Effects first.
        userShares[agentId][msg.sender] = userShare - shares;
        totalShares[agentId] = total - shares;

        uint256 depositReduction = (totalDepositsUSD[agentId] * shares) / total;
        totalDepositsUSD[agentId] -= depositReduction;

        if (userShares[agentId][msg.sender] == 0 && hasDeposited[agentId][msg.sender]) {
            hasDeposited[agentId][msg.sender] = false;
            if (depositorCount[agentId] > 0) {
                depositorCount[agentId] -= 1;
            }
        }

        if (monAmount > 0) {
            agentMonBalance[agentId] -= monAmount;
        }

        for (uint256 i = 0; i < supportedTokens.length; i++) {
            address token = supportedTokens[i];
            uint256 bal = agentTokenBalance[agentId][token];
            if (bal == 0) continue;
            uint256 amount = (bal * shares) / total;
            if (amount == 0) continue;
            agentTokenBalance[agentId][token] = bal - amount;
            tokenAmounts[i] = amount;
        }

        // Interactions after state updates.
        if (monAmount > 0) {
            (bool sent, ) = payable(msg.sender).call{value: monAmount}("");
            require(sent, "MON transfer failed");
        }

        for (uint256 i = 0; i < supportedTokens.length; i++) {
            uint256 amount = tokenAmounts[i];
            if (amount == 0) continue;
            address token = supportedTokens[i];
            _safeTransfer(token, msg.sender, amount);
            emit WithdrawalAsset(agentId, msg.sender, token, amount);
        }

        emit Withdrawn(agentId, msg.sender, shares, monAmount);
    }

    // ============================================
    // Views
    // ============================================

    function getUserSharePercent(bytes32 agentId, address user) external view returns (uint256) {
        uint256 total = totalShares[agentId];
        if (total == 0) return 0;
        return (userShares[agentId][user] * 10000) / total; // bps
    }

    function getVaultTVL(bytes32 agentId) external view returns (uint256) {
        return _currentVaultValueUsd(agentId);
    }

    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }

    function previewDepositShares(bytes32 agentId, address token, uint256 amount) external view returns (
        uint256 shares,
        uint256 usdValue
    ) {
        usdValue = _tokenToUsd(token, amount);
        shares = _calculateShares(agentId, usdValue);
    }

    function previewWithdraw(bytes32 agentId, uint256 shares) external view returns (
        uint256 monAmount,
        address[] memory tokens,
        uint256[] memory tokenAmounts,
        uint256 usdReduction
    ) {
        uint256 total = totalShares[agentId];
        require(total > 0, "No shares");
        require(shares <= total, "Shares too large");

        monAmount = (agentMonBalance[agentId] * shares) / total;
        uint256 tvl = _currentVaultValueUsd(agentId);
        usdReduction = (tvl * shares) / total;

        tokens = supportedTokens;
        tokenAmounts = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            uint256 bal = agentTokenBalance[agentId][tokens[i]];
            tokenAmounts[i] = (bal * shares) / total;
        }
    }

    // ============================================
    // Internals
    // ============================================

    function _calculateShares(bytes32 agentId, uint256 usdValue) internal view returns (uint256) {
        uint256 shares = totalShares[agentId];
        if (shares == 0) return usdValue; // 1:1 bootstrap

        uint256 tvl = _currentVaultValueUsd(agentId);
        require(tvl > 0, "Invalid TVL");
        return (usdValue * shares) / tvl;
    }

    function _currentVaultValueUsd(bytes32 agentId) internal view returns (uint256 tvlUsd) {
        uint256 monBal = agentMonBalance[agentId];
        if (monBal > 0) {
            tvlUsd += _tokenToUsd(address(0), monBal);
        }

        for (uint256 i = 0; i < supportedTokens.length; i++) {
            address token = supportedTokens[i];
            uint256 bal = agentTokenBalance[agentId][token];
            if (bal == 0) continue;
            tvlUsd += _tokenToUsd(token, bal);
        }
    }

    function _tokenToUsd(address token, uint256 amount) internal view returns (uint256) {
        TokenPrice memory price = tokenPrices[token];
        require(price.usdPriceE18 > 0, "Price not set");
        require(block.timestamp - uint256(price.updatedAt) <= maxPriceAge, "Price stale");

        uint8 decimals = token == address(0) ? 18 : IERC20Minimal(token).decimals();
        require(decimals <= 36, "Unsupported decimals");
        return (amount * price.usdPriceE18) / (10 ** decimals);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        require(ok, "Token transfer failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transfer returned false");
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        require(ok, "Token transferFrom failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transferFrom returned false");
        }
    }

    receive() external payable {}
}
