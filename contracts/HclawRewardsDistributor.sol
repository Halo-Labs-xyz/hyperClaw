// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20RewardsMinimal {
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title HclawRewardsDistributor
 * @notice Stores epoch rewards and supports user claims for rebates/incentives.
 */
contract HclawRewardsDistributor {
    struct RewardAllocation {
        uint256 rebateAmount;
        uint256 incentiveAmount;
        bool rebateClaimed;
        bool incentiveClaimed;
    }

    address public owner;
    address public hclawToken;
    address public rebateToken;
    bool public paused;

    mapping(uint256 => bytes32) public epochRoots;
    mapping(uint256 => mapping(address => RewardAllocation)) public rewards;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event PausedSet(bool paused);
    event EpochRootSet(uint256 indexed epochId, bytes32 rootHash);
    event AllocationSet(
        uint256 indexed epochId,
        address indexed user,
        uint256 rebateAmount,
        uint256 incentiveAmount
    );
    event Claimed(
        uint256 indexed epochId,
        address indexed user,
        uint256 rebateAmount,
        uint256 incentiveAmount
    );
    event RebateTokenUpdated(address indexed rebateToken);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    constructor(address _hclawToken, address _rebateToken) {
        require(_hclawToken != address(0), "Zero incentive token");
        owner = msg.sender;
        hclawToken = _hclawToken;
        rebateToken = _rebateToken;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero owner");
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function setRebateToken(address token) external onlyOwner {
        rebateToken = token;
        emit RebateTokenUpdated(token);
    }

    function setEpochRoot(uint256 epochId, bytes32 rootHash) external onlyOwner {
        epochRoots[epochId] = rootHash;
        emit EpochRootSet(epochId, rootHash);
    }

    function allocate(
        uint256 epochId,
        address user,
        uint256 rebateAmount,
        uint256 incentiveAmount
    ) public onlyOwner {
        require(user != address(0), "Zero user");
        RewardAllocation storage allocation = rewards[epochId][user];

        if (rebateAmount > 0) {
            allocation.rebateAmount += rebateAmount;
            allocation.rebateClaimed = false;
        }
        if (incentiveAmount > 0) {
            allocation.incentiveAmount += incentiveAmount;
            allocation.incentiveClaimed = false;
        }

        emit AllocationSet(epochId, user, rebateAmount, incentiveAmount);
    }

    function allocateBatch(
        uint256 epochId,
        address[] calldata users,
        uint256[] calldata rebateAmounts,
        uint256[] calldata incentiveAmounts
    ) external onlyOwner {
        require(users.length == rebateAmounts.length, "Rebate length mismatch");
        require(users.length == incentiveAmounts.length, "Incentive length mismatch");

        for (uint256 i = 0; i < users.length; i++) {
            allocate(epochId, users[i], rebateAmounts[i], incentiveAmounts[i]);
        }
    }

    function getClaimable(uint256 epochId, address user)
        external
        view
        returns (uint256 rebateClaimable, uint256 incentiveClaimable)
    {
        RewardAllocation memory allocation = rewards[epochId][user];
        rebateClaimable = allocation.rebateClaimed ? 0 : allocation.rebateAmount;
        incentiveClaimable = allocation.incentiveClaimed ? 0 : allocation.incentiveAmount;

        if (rebateToken == address(0)) {
            rebateClaimable = 0;
        }
    }

    function claim(uint256 epochId) external whenNotPaused returns (uint256 rebatePaid, uint256 incentivePaid) {
        RewardAllocation storage allocation = rewards[epochId][msg.sender];

        if (!allocation.rebateClaimed && allocation.rebateAmount > 0 && rebateToken != address(0)) {
            allocation.rebateClaimed = true;
            rebatePaid = allocation.rebateAmount;
            _safeTransfer(rebateToken, msg.sender, rebatePaid);
        }

        if (!allocation.incentiveClaimed && allocation.incentiveAmount > 0) {
            allocation.incentiveClaimed = true;
            incentivePaid = allocation.incentiveAmount;
            _safeTransfer(hclawToken, msg.sender, incentivePaid);
        }

        require(rebatePaid > 0 || incentivePaid > 0, "Nothing claimable");
        emit Claimed(epochId, msg.sender, rebatePaid, incentivePaid);
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20RewardsMinimal.transfer.selector, to, amount)
        );
        require(ok, "Token transfer failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transfer returned false");
        }
    }
}
