// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RateLimitedPaymaster
 * @notice Holds ERC-20 tokens and pays them out on behalf of authorized keys,
 *         enforcing "no more than X of token per Y seconds" per key.
 *
 * Two ways to request a payment:
 *  - `processPayment`: the key itself is the caller and receives the tokens.
 *  - `processSignedPayment(s)`: anyone (a relayer) submits requests signed by
 *    the key (EIP-712). The key needs no gas and never holds tokens; the
 *    payment goes to the recipient named in the request. This is what makes
 *    ephemeral, unfunded client keys possible.
 *
 * Keys are authorized by the owner directly, or enrolled by an authorizer
 * (typically the relayer) under a per-token policy the owner sets.
 *
 * Denials never revert: they emit `PaymentDenied` and return false so every
 * decision is observable on-chain, including each item of a batch.
 */
contract RateLimitedPaymaster is Initializable, OwnableUpgradeable, UUPSUpgradeable, EIP712Upgradeable {
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

    struct PaymentRequest {
        address key;
        address token;
        address to;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    struct EnrollmentPolicy {
        uint256 amount;
        uint256 timeWindow;
        bool enabled;
    }

    bytes32 public constant PAYMENT_REQUEST_TYPEHASH =
        keccak256("PaymentRequest(address key,address token,address to,uint256 amount,uint256 nonce,uint256 deadline)");

    mapping(address => mapping(address => SpendingLimit)) public authorizedKeys;
    mapping(address => Transaction[]) public keyTransactions;

    /// @notice When true, every payment request is denied. Set by the owner.
    bool public paused;

    /// @notice Sequential nonce per key for signed requests.
    mapping(address => uint256) public nonces;

    /// @notice Addresses allowed to enroll keys under the enrollment policy (e.g. a relayer).
    mapping(address => bool) public authorizers;

    /// @notice Default limit applied by `enrollKey`, per token.
    mapping(address => EnrollmentPolicy) public enrollmentPolicy;

    event KeyAuthorized(address indexed key, address indexed token, uint256 amount, uint256 timeWindow);
    event KeyRevoked(address indexed key, address indexed token);
    event PaymentProcessed(address indexed key, address indexed token, uint256 amount, uint256 timestamp);
    event PaymentDenied(address indexed key, address indexed token, uint256 amount, string reason);
    event PausedChanged(bool paused);
    event AuthorizerChanged(address indexed authorizer, bool allowed);
    event EnrollmentPolicyChanged(address indexed token, uint256 amount, uint256 timeWindow, bool enabled);

    error CallerNotKey();
    error InvalidTimeWindow();
    error InvalidAmount();
    error NotAuthorizer();
    error EnrollmentDisabled();
    error AlreadyAuthorized();
    error LengthMismatch();

    string private constant REASON_PAUSED = "Paymaster paused";
    string private constant REASON_NOT_AUTHORIZED = "Key not authorized";
    string private constant REASON_INSUFFICIENT_BALANCE = "Insufficient paymaster balance";
    string private constant REASON_LIMIT_EXCEEDED = "Spending limit exceeded";
    string private constant REASON_BAD_SIGNATURE = "Invalid signature";
    string private constant REASON_EXPIRED = "Request expired";
    string private constant REASON_BAD_NONCE = "Bad nonce";

    function initialize(address _owner) public initializer {
        __Ownable_init(_owner);
        __EIP712_init("RateLimitedPaymaster", "1");
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
        _authorize(key, token, amount, timeWindow);
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

    function setAuthorizer(address authorizer, bool allowed) external onlyOwner {
        authorizers[authorizer] = allowed;
        emit AuthorizerChanged(authorizer, allowed);
    }

    function setEnrollmentPolicy(
        address token,
        uint256 amount,
        uint256 timeWindow,
        bool enabled
    ) external onlyOwner {
        if (enabled) {
            if (amount == 0) revert InvalidAmount();
            if (timeWindow == 0) revert InvalidTimeWindow();
        }
        enrollmentPolicy[token] = EnrollmentPolicy({amount: amount, timeWindow: timeWindow, enabled: enabled});
        emit EnrollmentPolicyChanged(token, amount, timeWindow, enabled);
    }

    /// @notice Authorize `key` for `token` with the token's enrollment policy.
    ///         Callable by the owner or any authorizer. Fails if the pair is
    ///         already active (use `authorizeKey` to change an active limit).
    function enrollKey(address key, address token) external {
        _enroll(key, token);
    }

    /// @notice Enroll many keys for `token` in one transaction (relayer batching).
    function enrollKeys(address[] calldata keys, address token) external {
        for (uint256 i = 0; i < keys.length; i++) {
            _enroll(keys[i], token);
        }
    }

    function _enroll(address key, address token) internal {
        if (msg.sender != owner() && !authorizers[msg.sender]) revert NotAuthorizer();
        EnrollmentPolicy memory policy = enrollmentPolicy[token];
        if (!policy.enabled) revert EnrollmentDisabled();
        if (authorizedKeys[key][token].isActive) revert AlreadyAuthorized();
        _authorize(key, token, policy.amount, policy.timeWindow);
    }

    function _authorize(address key, address token, uint256 amount, uint256 timeWindow) internal {
        if (amount == 0) revert InvalidAmount();
        if (timeWindow == 0) revert InvalidTimeWindow();

        authorizedKeys[key][token] = SpendingLimit({amount: amount, timeWindow: timeWindow, isActive: true});

        emit KeyAuthorized(key, token, amount, timeWindow);
    }

    // ---------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------

    /// @notice Request `amount` of `token` for `key`, paid to the caller. The caller must be `key`.
    /// @dev Denials do not revert: they emit `PaymentDenied` and return false so
    ///      they are observable on-chain. Callers must check the return value.
    function processPayment(
        address key,
        address token,
        uint256 amount
    ) external returns (bool) {
        if (msg.sender != key) revert CallerNotKey();
        return _pay(key, token, msg.sender, amount);
    }

    /// @notice Submit one request signed by `req.key` (EIP-712). Anyone may call.
    function processSignedPayment(PaymentRequest calldata req, bytes calldata signature) external returns (bool) {
        return _processSigned(req, signature);
    }

    /// @notice Submit a batch of signed requests. Each item is evaluated
    ///         independently and in order; nothing reverts per item.
    function processSignedPayments(
        PaymentRequest[] calldata reqs,
        bytes[] calldata signatures
    ) external returns (bool[] memory results) {
        if (reqs.length != signatures.length) revert LengthMismatch();
        results = new bool[](reqs.length);
        for (uint256 i = 0; i < reqs.length; i++) {
            results[i] = _processSigned(reqs[i], signatures[i]);
        }
    }

    function _processSigned(PaymentRequest calldata req, bytes calldata signature) internal returns (bool) {
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hashPaymentRequest(req), signature);
        if (err != ECDSA.RecoverError.NoError || signer != req.key) {
            emit PaymentDenied(req.key, req.token, req.amount, REASON_BAD_SIGNATURE);
            return false;
        }
        if (block.timestamp > req.deadline) {
            emit PaymentDenied(req.key, req.token, req.amount, REASON_EXPIRED);
            return false;
        }
        if (req.nonce != nonces[req.key]) {
            emit PaymentDenied(req.key, req.token, req.amount, REASON_BAD_NONCE);
            return false;
        }
        // A well-formed request is evaluated exactly once, whatever the outcome.
        nonces[req.key] = req.nonce + 1;
        return _pay(req.key, req.token, req.to, req.amount);
    }

    /// @notice EIP-712 digest a key must sign for `req`.
    function hashPaymentRequest(PaymentRequest calldata req) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(PAYMENT_REQUEST_TYPEHASH, req.key, req.token, req.to, req.amount, req.nonce, req.deadline))
        );
    }

    function _pay(address key, address token, address to, uint256 amount) internal returns (bool) {
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

        keyTransactions[key].push(Transaction({amount: amount, timestamp: block.timestamp, token: token}));

        IERC20(token).safeTransfer(to, amount);

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

    function getEnrollmentPolicy(address token) external view returns (EnrollmentPolicy memory) {
        return enrollmentPolicy[token];
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

    uint256[44] private __gap;
}
