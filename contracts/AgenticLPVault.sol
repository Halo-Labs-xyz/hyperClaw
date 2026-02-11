// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title AgenticLPVault
 * @notice Treasury-owned strategy shell with role-gated execution and risk guardrails.
 */
contract AgenticLPVault {
    address public owner;
    address public executor;

    bool public paused;
    bool public killSwitch;

    uint16 public maxInventorySkewBps = 2_000; // 20%
    uint16 public maxDailyTurnoverBps = 4_000; // 40%
    uint16 public maxDrawdownBps = 1_500; // 15%

    uint16 public currentInventorySkewBps;
    uint16 public currentDailyTurnoverBps;
    uint16 public currentDrawdownBps;

    int256 public cumulativeRealizedPnlUsd;
    uint256 public lastExecutionTs;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ExecutorUpdated(address indexed executor);
    event PausedSet(bool paused);
    event KillSwitchSet(bool killSwitch);
    event RiskLimitsUpdated(uint16 maxInventorySkewBps, uint16 maxDailyTurnoverBps, uint16 maxDrawdownBps);
    event RiskReported(uint16 inventorySkewBps, uint16 dailyTurnoverBps, uint16 drawdownBps);
    event StrategyExecuted(bytes32 indexed planHash, int256 realizedPnlUsd, uint256 ts);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyExecutor() {
        require(msg.sender == executor, "Not executor");
        _;
    }

    modifier whenLive() {
        require(!paused, "Paused");
        require(!killSwitch, "Kill switch active");
        _;
    }

    constructor(address _executor) {
        owner = msg.sender;
        executor = _executor;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero owner");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function setExecutor(address newExecutor) external onlyOwner {
        require(newExecutor != address(0), "Zero executor");
        executor = newExecutor;
        emit ExecutorUpdated(newExecutor);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setKillSwitch(bool value) external onlyOwner {
        killSwitch = value;
        emit KillSwitchSet(value);
    }

    function setRiskLimits(
        uint16 _maxInventorySkewBps,
        uint16 _maxDailyTurnoverBps,
        uint16 _maxDrawdownBps
    ) external onlyOwner {
        require(_maxInventorySkewBps > 0 && _maxInventorySkewBps <= 10_000, "Invalid inventory bound");
        require(_maxDailyTurnoverBps > 0 && _maxDailyTurnoverBps <= 10_000, "Invalid turnover bound");
        require(_maxDrawdownBps > 0 && _maxDrawdownBps <= 10_000, "Invalid drawdown bound");

        maxInventorySkewBps = _maxInventorySkewBps;
        maxDailyTurnoverBps = _maxDailyTurnoverBps;
        maxDrawdownBps = _maxDrawdownBps;

        emit RiskLimitsUpdated(_maxInventorySkewBps, _maxDailyTurnoverBps, _maxDrawdownBps);
    }

    function reportRisk(
        uint16 inventorySkewBps,
        uint16 dailyTurnoverBps,
        uint16 drawdownBps
    ) external onlyExecutor {
        currentInventorySkewBps = inventorySkewBps;
        currentDailyTurnoverBps = dailyTurnoverBps;
        currentDrawdownBps = drawdownBps;

        emit RiskReported(inventorySkewBps, dailyTurnoverBps, drawdownBps);
    }

    function execute(bytes32 planHash, int256 realizedPnlUsd) external onlyExecutor whenLive {
        require(currentInventorySkewBps <= maxInventorySkewBps, "Inventory skew limit");
        require(currentDailyTurnoverBps <= maxDailyTurnoverBps, "Turnover limit");
        require(currentDrawdownBps <= maxDrawdownBps, "Drawdown limit");

        cumulativeRealizedPnlUsd += realizedPnlUsd;
        lastExecutionTs = block.timestamp;

        emit StrategyExecuted(planHash, realizedPnlUsd, block.timestamp);
    }

    function getStatus()
        external
        view
        returns (
            bool isPaused,
            bool isKilled,
            uint16 inventorySkewBps,
            uint16 dailyTurnoverBps,
            uint16 drawdownBps,
            int256 totalRealizedPnlUsd,
            uint256 lastExecTs
        )
    {
        return (
            paused,
            killSwitch,
            currentInventorySkewBps,
            currentDailyTurnoverBps,
            currentDrawdownBps,
            cumulativeRealizedPnlUsd,
            lastExecutionTs
        );
    }
}
