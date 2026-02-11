// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20LockMinimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title HclawLock
 * @notice Fixed-term HCLAW lock contract with linear-decay power.
 * Product labels map to:
 * - Locked HCLAW: amount held by active locks
 * - HCLAW Power: linearly decayed weighted amount
 */
contract HclawLock {
    struct LockPosition {
        uint256 lockId;
        address owner;
        uint256 amount;
        uint64 startTs;
        uint64 endTs;
        uint16 durationDays;
        uint16 multiplierBps;
        bool unlocked;
    }

    address public owner;
    address public immutable hclawToken;
    bool public paused;
    uint256 public nextLockId = 1;

    mapping(uint256 => LockPosition) public locks;
    mapping(address => uint256[]) private userLockIds;

    event Locked(
        uint256 indexed lockId,
        address indexed user,
        uint256 amount,
        uint16 durationDays,
        uint64 endTs
    );
    event LockExtended(uint256 indexed lockId, uint16 durationDays, uint64 endTs);
    event LockIncreased(uint256 indexed lockId, uint256 amountAdded, uint256 newAmount);
    event Unlocked(uint256 indexed lockId, address indexed user, uint256 amount);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    constructor(address _hclawToken) {
        require(_hclawToken != address(0), "Zero token");
        owner = msg.sender;
        hclawToken = _hclawToken;
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

    function lock(uint256 amount, uint16 durationDays) external whenNotPaused returns (uint256 lockId) {
        require(amount > 0, "Zero amount");

        uint16 multiplierBps = _durationToMultiplier(durationDays);
        lockId = nextLockId++;

        _safeTransferFrom(hclawToken, msg.sender, address(this), amount);

        uint64 startTs = uint64(block.timestamp);
        uint64 endTs = uint64(block.timestamp + (uint256(durationDays) * 1 days));

        locks[lockId] = LockPosition({
            lockId: lockId,
            owner: msg.sender,
            amount: amount,
            startTs: startTs,
            endTs: endTs,
            durationDays: durationDays,
            multiplierBps: multiplierBps,
            unlocked: false
        });
        userLockIds[msg.sender].push(lockId);

        emit Locked(lockId, msg.sender, amount, durationDays, endTs);
    }

    function extendLock(uint256 lockId, uint16 newDurationDays) external whenNotPaused {
        LockPosition storage position = locks[lockId];
        require(position.owner == msg.sender, "Not lock owner");
        require(!position.unlocked, "Already unlocked");
        require(block.timestamp < position.endTs, "Lock expired");
        require(newDurationDays >= position.durationDays, "Duration too short");

        uint16 newMultiplier = _durationToMultiplier(newDurationDays);
        uint64 newEndTs = uint64(block.timestamp + (uint256(newDurationDays) * 1 days));
        require(newEndTs > position.endTs, "No extension");

        position.startTs = uint64(block.timestamp);
        position.endTs = newEndTs;
        position.durationDays = newDurationDays;
        position.multiplierBps = newMultiplier;

        emit LockExtended(lockId, newDurationDays, newEndTs);
    }

    function increaseLock(uint256 lockId, uint256 amount) external whenNotPaused {
        require(amount > 0, "Zero amount");

        LockPosition storage position = locks[lockId];
        require(position.owner == msg.sender, "Not lock owner");
        require(!position.unlocked, "Already unlocked");
        require(block.timestamp < position.endTs, "Lock expired");

        _safeTransferFrom(hclawToken, msg.sender, address(this), amount);
        position.amount += amount;

        emit LockIncreased(lockId, amount, position.amount);
    }

    function unlock(uint256 lockId) external whenNotPaused {
        LockPosition storage position = locks[lockId];
        require(position.owner == msg.sender, "Not lock owner");
        require(!position.unlocked, "Already unlocked");
        require(block.timestamp >= position.endTs, "Still locked");

        uint256 amount = position.amount;
        position.amount = 0;
        position.unlocked = true;

        _safeTransfer(hclawToken, msg.sender, amount);
        emit Unlocked(lockId, msg.sender, amount);
    }

    function getUserPower(address user) external view returns (uint256 power) {
        uint256[] memory ids = userLockIds[user];
        for (uint256 i = 0; i < ids.length; i++) {
            LockPosition memory position = locks[ids[i]];
            power += _positionPower(position);
        }
    }

    function getUserTier(address user) external view returns (uint8 tier) {
        uint256[] memory ids = userLockIds[user];
        uint16 maxMultiplier;
        for (uint256 i = 0; i < ids.length; i++) {
            LockPosition memory position = locks[ids[i]];
            if (_positionPower(position) == 0) continue;
            if (position.multiplierBps > maxMultiplier) {
                maxMultiplier = position.multiplierBps;
            }
        }

        if (maxMultiplier >= 25_000) return 3;
        if (maxMultiplier >= 17_500) return 2;
        if (maxMultiplier >= 12_500) return 1;
        return 0;
    }

    function getUserLockIds(address user) external view returns (uint256[] memory) {
        return userLockIds[user];
    }

    function previewPower(uint256 amount, uint16 durationDays) external pure returns (uint256) {
        uint16 multiplierBps = _durationToMultiplier(durationDays);
        return (amount * uint256(multiplierBps)) / 10_000;
    }

    function _positionPower(LockPosition memory position) internal view returns (uint256) {
        if (position.unlocked || position.amount == 0) return 0;
        if (block.timestamp >= position.endTs) return 0;
        if (position.endTs <= position.startTs) return 0;

        uint256 maxPower = (position.amount * uint256(position.multiplierBps)) / 10_000;
        uint256 remaining = uint256(position.endTs) - block.timestamp;
        uint256 total = uint256(position.endTs) - uint256(position.startTs);
        return (maxPower * remaining) / total;
    }

    function _durationToMultiplier(uint16 durationDays) internal pure returns (uint16) {
        if (durationDays == 30) return 12_500; // 1.25x
        if (durationDays == 90) return 17_500; // 1.75x
        if (durationDays == 180) return 25_000; // 2.50x
        revert("Invalid duration");
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20LockMinimal.transfer.selector, to, amount)
        );
        require(ok, "Token transfer failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transfer returned false");
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20LockMinimal.transferFrom.selector, from, to, amount)
        );
        require(ok, "Token transferFrom failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transferFrom returned false");
        }
    }
}
