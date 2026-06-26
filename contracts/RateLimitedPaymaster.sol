// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract RateLimitedPaymaster is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    struct SpendingLimit {
        uint256 amount;
        uint256 timeWindow;
        bool isActive;
    }

    struct Transaction {
        uint256 amount;
        uint256 timestamp;
        address token;
    }

    mapping(address => mapping(address => SpendingLimit)) public authorizedKeys;
    mapping(address => Transaction[]) public keyTransactions;
    
    event KeyAuthorized(address indexed key, address indexed token, uint256 amount, uint256 timeWindow);
    event KeyRevoked(address indexed key, address indexed token);
    event PaymentProcessed(address indexed key, address indexed token, uint256 amount, uint256 timestamp);
    event PaymentDenied(address indexed key, address indexed token, uint256 amount, string reason);

    error KeyNotAuthorized();
    error SpendingLimitExceeded();
    error InsufficientPaymasterBalance();
    error InvalidTimeWindow();
    error InvalidAmount();

    function initialize(address _owner) public initializer {
        __Ownable_init();
        __UUPSUpgradeable_init();
        _transferOwnership(_owner);
    }

    function authorizeKey(
        address key,
        address token,
        uint256 amount,
        uint256 timeWindow
    ) external onlyOwner {
        if (amount == 0) revert InvalidAmount();
        if (timeWindow == 0) revert InvalidTimeWindow();

        authorizedKeys[key][token] = SpendingLimit({
            amount: amount,
            timeWindow: timeWindow,
            isActive: true
        });

        emit KeyAuthorized(key, token, amount, timeWindow);
    }

    function revokeKey(address key, address token) external onlyOwner {
        authorizedKeys[key][token].isActive = false;
        emit KeyRevoked(key, token);
    }

    function processPayment(
        address key,
        address token,
        uint256 amount
    ) external returns (bool) {
        SpendingLimit memory limit = authorizedKeys[key][token];
        
        if (!limit.isActive) {
            emit PaymentDenied(key, token, amount, "Key not authorized");
            revert KeyNotAuthorized();
        }

        if (IERC20(token).balanceOf(address(this)) < amount) {
            emit PaymentDenied(key, token, amount, "Insufficient paymaster balance");
            revert InsufficientPaymasterBalance();
        }

        _cleanupExpiredTransactions(key, limit.timeWindow);

        uint256 totalSpentInWindow = _calculateSpentInTimeWindow(key, token, limit.timeWindow);
        
        if (totalSpentInWindow + amount > limit.amount) {
            emit PaymentDenied(key, token, amount, "Spending limit exceeded");
            revert SpendingLimitExceeded();
        }

        keyTransactions[key].push(Transaction({
            amount: amount,
            timestamp: block.timestamp,
            token: token
        }));

        IERC20(token).safeTransfer(msg.sender, amount);

        emit PaymentProcessed(key, token, amount, block.timestamp);
        return true;
    }

    function _calculateSpentInTimeWindow(
        address key,
        address token,
        uint256 timeWindow
    ) internal view returns (uint256) {
        Transaction[] memory transactions = keyTransactions[key];
        uint256 totalSpent = 0;
        uint256 cutoffTime = block.timestamp - timeWindow;

        for (uint256 i = 0; i < transactions.length; i++) {
            if (transactions[i].timestamp > cutoffTime && transactions[i].token == token) {
                totalSpent += transactions[i].amount;
            }
        }

        return totalSpent;
    }

    function _cleanupExpiredTransactions(address key, uint256 timeWindow) internal {
        Transaction[] storage transactions = keyTransactions[key];
        uint256 cutoffTime = block.timestamp - timeWindow;
        uint256 writeIndex = 0;

        for (uint256 readIndex = 0; readIndex < transactions.length; readIndex++) {
            if (transactions[readIndex].timestamp > cutoffTime) {
                if (writeIndex != readIndex) {
                    transactions[writeIndex] = transactions[readIndex];
                }
                writeIndex++;
            }
        }

        while (transactions.length > writeIndex) {
            transactions.pop();
        }
    }

    function getSpendingLimit(address key, address token) external view returns (SpendingLimit memory) {
        return authorizedKeys[key][token];
    }

    function getCurrentSpending(address key, address token) external view returns (uint256) {
        SpendingLimit memory limit = authorizedKeys[key][token];
        if (!limit.isActive) return 0;
        return _calculateSpentInTimeWindow(key, token, limit.timeWindow);
    }

    function getRemainingSpendingCapacity(address key, address token) external view returns (uint256) {
        SpendingLimit memory limit = authorizedKeys[key][token];
        if (!limit.isActive) return 0;
        
        uint256 currentSpending = _calculateSpentInTimeWindow(key, token, limit.timeWindow);
        return limit.amount > currentSpending ? limit.amount - currentSpending : 0;
    }

    function getTransactionCount(address key) external view returns (uint256) {
        return keyTransactions[key].length;
    }

    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    function depositToken(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    uint256[48] private __gap;
}