// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface INadFunLens {
    function getAmountOut(address token, uint256 amountIn, bool isBuy)
        external view returns (address router, uint256 amountOut);
}

/// @notice Minimal buy interface shared by BondingCurveRouter and DexRouter
interface INadFunBuyRouter {
    struct BuyParams {
        uint256 amountOutMin;
        address token;
        address to;
        uint256 deadline;
    }
    function buy(BuyParams calldata params) external payable;
}

interface IHclawLock {
    function lock(uint256 amount, uint16 durationDays) external returns (uint256 lockId);
}

/**
 * @title HclawBuybackLock
 * @notice Receives treasury buyback MON, buys HCLAW on nad.fun, and locks it in HclawLock.
 * Set this contract as HCLAW_BUYBACK_RECIPIENT when deploying HclawTreasuryRouter.
 */
contract HclawBuybackLock {
    address public owner;
    address public immutable nadFunLens;
    address public immutable hclawToken;
    address public immutable hclawLock;
    uint16 public lockDurationDays;
    uint16 public slippageBps; // e.g. 500 = 5%
    bool public paused;

    event BuybackLocked(uint256 monIn, uint256 hclawLocked, uint256 lockId);
    event PausedSet(bool paused);
    event SlippageUpdated(uint16 bps);
    event DurationUpdated(uint16 days_);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    constructor(
        address _nadFunLens,
        address _hclawToken,
        address _hclawLock,
        uint16 _lockDurationDays
    ) {
        require(_nadFunLens != address(0), "Zero lens");
        require(_hclawToken != address(0), "Zero token");
        require(_hclawLock != address(0), "Zero lock");
        require(_lockDurationDays == 30 || _lockDurationDays == 90 || _lockDurationDays == 180, "Invalid duration");

        owner = msg.sender;
        nadFunLens = _nadFunLens;
        hclawToken = _hclawToken;
        hclawLock = _hclawLock;
        lockDurationDays = _lockDurationDays;
        slippageBps = 500; // 5% default
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setSlippageBps(uint16 bps) external onlyOwner {
        require(bps <= 2000, "Max 20% slippage");
        slippageBps = bps;
        emit SlippageUpdated(bps);
    }

    function setLockDurationDays(uint16 days_) external onlyOwner {
        require(days_ == 30 || days_ == 90 || days_ == 180, "Invalid duration");
        lockDurationDays = days_;
        emit DurationUpdated(days_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero owner");
        owner = newOwner;
    }

    /// @notice Receive MON from treasury router and buy+lock HCLAW
    receive() external payable whenNotPaused {
        if (msg.value == 0) return;

        (address router, uint256 expectedOut) = INadFunLens(nadFunLens).getAmountOut(
            hclawToken,
            msg.value,
            true
        );
        require(router != address(0), "No router");
        require(expectedOut > 0, "Zero expected");

        uint256 amountOutMin = (expectedOut * (10000 - slippageBps)) / 10000;

        INadFunBuyRouter buyRouter = INadFunBuyRouter(router);
        buyRouter.buy{value: msg.value}(
            INadFunBuyRouter.BuyParams({
                amountOutMin: amountOutMin,
                token: hclawToken,
                to: address(this),
                deadline: block.timestamp + 300
            })
        );

        uint256 received = IERC20Minimal(hclawToken).balanceOf(address(this));
        require(received >= amountOutMin, "Slippage");

        IERC20Minimal(hclawToken).approve(hclawLock, received);
        uint256 lockId = IHclawLock(hclawLock).lock(received, lockDurationDays);

        emit BuybackLocked(msg.value, received, lockId);
    }

    /// @notice Manual flush: buy+lock any MON balance held by this contract
    function flush() external whenNotPaused {
        uint256 bal = address(this).balance;
        if (bal == 0) return;

        (address router, uint256 expectedOut) = INadFunLens(nadFunLens).getAmountOut(
            hclawToken,
            bal,
            true
        );
        require(router != address(0), "No router");
        require(expectedOut > 0, "Zero expected");

        uint256 amountOutMin = (expectedOut * (10000 - slippageBps)) / 10000;

        INadFunBuyRouter buyRouter = INadFunBuyRouter(router);
        buyRouter.buy{value: bal}(
            INadFunBuyRouter.BuyParams({
                amountOutMin: amountOutMin,
                token: hclawToken,
                to: address(this),
                deadline: block.timestamp + 300
            })
        );

        uint256 received = IERC20Minimal(hclawToken).balanceOf(address(this));
        require(received >= amountOutMin, "Slippage");

        IERC20Minimal(hclawToken).approve(hclawLock, received);
        uint256 lockId = IHclawLock(hclawLock).lock(received, lockDurationDays);

        emit BuybackLocked(bal, received, lockId);
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Zero to");
        require(token != address(0), "Zero token");
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "Transfer failed");
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Zero to");
        (bool sent,) = to.call{value: amount}("");
        require(sent, "Native transfer failed");
    }
}
