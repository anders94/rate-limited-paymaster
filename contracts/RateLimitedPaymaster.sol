// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

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

    /// @notice When true, every payment request is denied. Set by the owner.
    bool public paused;

    event KeyAuthorized(address indexed key, address indexed token, uint256 amount, uint256 timeWindow);
    event KeyRevoked(address indexed key, address indexed token);
    event PaymentProcessed(address indexed key, address indexed token, uint256 amount, uint256 timestamp);
    event PaymentDenied(address indexed key, address indexed token, uint256 amount, string reason);
    event PausedChanged(bool paused);

    error CallerNotKey();
    error InvalidTimeWindow();
    error InvalidAmount();

    string private constant REASON_PAUSED = "Paymaster paused";
    string private constant REASON_NOT_AUTHORIZED = "Key not authorized";
    string private constant REASON_INSUFFICIENT_BALANCE = "Insufficient paymaster balance";
    string private constant REASON_LIMIT_EXCEEDED = "Spending limit exceeded";

    function initialize(address _owner) public initializer {
        __Ownable_init(_owner);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

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

    function pause() external onlyOwner {
        paused = true;
        emit PausedChanged(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedChanged(false);
    }

    // ---------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------

    /// @notice Request `amount` of `token` for `key`. The caller must be `key`.
    /// @dev Denials do not revert: they emit `PaymentDenied` and return false so
    ///      they are observable on-chain. Callers must check the return value.
    function processPayment(
        address key,
        address token,
        uint256 amount
    ) external returns (bool) {
        if (msg.sender != key) revert CallerNotKey();

        SpendingLimit memory limit = authorizedKeys[key][token];

        if (paused) {
            emit PaymentDenied(key, token, amount, REASON_PAUSED);
            return false;
        }

        if (!limit.isActive) {
            emit PaymentDenied(key, token, amount, REASON_NOT_AUTHORIZED);
            return false;
        }

        if (IERC20(token).balanceOf(address(this)) < amount) {
            emit PaymentDenied(key, token, amount, REASON_INSUFFICIENT_BALANCE);
            return false;
        }

        _cleanupExpiredTransactions(key, limit.timeWindow);

        uint256 totalSpentInWindow = _calculateSpentInTimeWindow(key, token, limit.timeWindow);

        if (totalSpentInWindow + amount > limit.amount) {
            emit PaymentDenied(key, token, amount, REASON_LIMIT_EXCEEDED);
            return false;
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

    /// @notice Preflight a payment without changing state.
    function checkPayment(
        address key,
        address token,
        uint256 amount
    ) external view returns (bool ok, string memory reason) {
        SpendingLimit memory limit = authorizedKeys[key][token];
        if (paused) return (false, REASON_PAUSED);
        if (!limit.isActive) return (false, REASON_NOT_AUTHORIZED);
        if (IERC20(token).balanceOf(address(this)) < amount) return (false, REASON_INSUFFICIENT_BALANCE);
        uint256 spent = _calculateSpentInTimeWindow(key, token, limit.timeWindow);
        if (spent + amount > limit.amount) return (false, REASON_LIMIT_EXCEEDED);
        return (true, "");
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _calculateSpentInTimeWindow(
        address key,
        address token,
        uint256 timeWindow
    ) internal view returns (uint256) {
        Transaction[] memory transactions = keyTransactions[key];
        uint256 totalSpent = 0;
        uint256 cutoffTime = block.timestamp > timeWindow ? block.timestamp - timeWindow : 0;

        for (uint256 i = 0; i < transactions.length; i++) {
            if (transactions[i].timestamp > cutoffTime && transactions[i].token == token) {
                totalSpent += transactions[i].amount;
            }
        }

        return totalSpent;
    }

    function _cleanupExpiredTransactions(address key, uint256 timeWindow) internal {
        Transaction[] storage transactions = keyTransactions[key];
        uint256 cutoffTime = block.timestamp > timeWindow ? block.timestamp - timeWindow : 0;
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

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

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

    /// @notice All tracked (not yet cleaned up) transactions for `key`.
    function getKeyTransactions(address key) external view returns (Transaction[] memory) {
        return keyTransactions[key];
    }

    // ---------------------------------------------------------------------
    // Treasury
    // ---------------------------------------------------------------------

    function withdrawToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }

    function depositToken(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    uint256[47] private __gap;
}
