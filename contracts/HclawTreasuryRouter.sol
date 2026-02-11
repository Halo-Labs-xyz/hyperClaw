// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20TreasuryMinimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title HclawTreasuryRouter
 * @notice Splits incoming treasury revenue between buyback, incentives, and reserve.
 */
contract HclawTreasuryRouter {
    address public owner;
    bool public paused;

    address public buybackRecipient;
    address public incentiveRecipient;
    address public reserveRecipient;

    uint16 public buybackSplitBps = 4000;
    uint16 public incentiveSplitBps = 4000;
    uint16 public reserveSplitBps = 2000;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event PausedSet(bool paused);
    event RecipientsUpdated(address buyback, address incentive, address reserve);
    event SplitsUpdated(uint16 buybackBps, uint16 incentiveBps, uint16 reserveBps);
    event TreasuryRouted(
        address indexed source,
        address indexed token,
        uint256 totalAmount,
        uint256 buybackAmount,
        uint256 incentiveAmount,
        uint256 reserveAmount
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Paused");
        _;
    }

    constructor(address _buyback, address _incentive, address _reserve) {
        require(_buyback != address(0), "Zero buyback");
        require(_incentive != address(0), "Zero incentive");
        require(_reserve != address(0), "Zero reserve");

        owner = msg.sender;
        buybackRecipient = _buyback;
        incentiveRecipient = _incentive;
        reserveRecipient = _reserve;
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

    function configureRecipients(address _buyback, address _incentive, address _reserve) external onlyOwner {
        require(_buyback != address(0), "Zero buyback");
        require(_incentive != address(0), "Zero incentive");
        require(_reserve != address(0), "Zero reserve");

        buybackRecipient = _buyback;
        incentiveRecipient = _incentive;
        reserveRecipient = _reserve;

        emit RecipientsUpdated(_buyback, _incentive, _reserve);
    }

    function configureSplits(uint16 buybackBps, uint16 incentiveBps, uint16 reserveBps) external onlyOwner {
        require(
            uint256(buybackBps) + uint256(incentiveBps) + uint256(reserveBps) == 10_000,
            "Invalid split total"
        );

        buybackSplitBps = buybackBps;
        incentiveSplitBps = incentiveBps;
        reserveSplitBps = reserveBps;

        emit SplitsUpdated(buybackBps, incentiveBps, reserveBps);
    }

    function routeNative() external payable whenNotPaused {
        require(msg.value > 0, "Zero amount");
        (uint256 buybackAmt, uint256 incentiveAmt, uint256 reserveAmt) = _splitAmount(msg.value);

        _safeTransferNative(payable(buybackRecipient), buybackAmt);
        _safeTransferNative(payable(incentiveRecipient), incentiveAmt);
        _safeTransferNative(payable(reserveRecipient), reserveAmt);

        emit TreasuryRouted(msg.sender, address(0), msg.value, buybackAmt, incentiveAmt, reserveAmt);
    }

    function routeERC20(address token, uint256 amount) external whenNotPaused {
        require(token != address(0), "Zero token");
        require(amount > 0, "Zero amount");

        _safeTransferFrom(token, msg.sender, address(this), amount);

        (uint256 buybackAmt, uint256 incentiveAmt, uint256 reserveAmt) = _splitAmount(amount);

        _safeTransfer(token, buybackRecipient, buybackAmt);
        _safeTransfer(token, incentiveRecipient, incentiveAmt);
        _safeTransfer(token, reserveRecipient, reserveAmt);

        emit TreasuryRouted(msg.sender, token, amount, buybackAmt, incentiveAmt, reserveAmt);
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Zero to");
        _safeTransfer(token, to, amount);
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Zero to");
        _safeTransferNative(to, amount);
    }

    function _splitAmount(uint256 amount)
        internal
        view
        returns (uint256 buybackAmt, uint256 incentiveAmt, uint256 reserveAmt)
    {
        buybackAmt = (amount * uint256(buybackSplitBps)) / 10_000;
        incentiveAmt = (amount * uint256(incentiveSplitBps)) / 10_000;
        reserveAmt = amount - buybackAmt - incentiveAmt;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20TreasuryMinimal.transfer.selector, to, amount)
        );
        require(ok, "Token transfer failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transfer returned false");
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20TreasuryMinimal.transferFrom.selector, from, to, amount)
        );
        require(ok, "Token transferFrom failed");
        if (data.length > 0) {
            require(abi.decode(data, (bool)), "Token transferFrom returned false");
        }
    }

    function _safeTransferNative(address payable to, uint256 amount) internal {
        if (amount == 0) return;
        (bool sent, ) = to.call{value: amount}("");
        require(sent, "Native transfer failed");
    }

    receive() external payable {}
}
