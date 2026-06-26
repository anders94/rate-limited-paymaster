# Rate-Limited Paymaster

A smart contract paymaster that enforces spending limits on ERC-20 tokens over specified time windows. The paymaster allows administrators to authorize keys with specific spending limits and automatically tracks and enforces these limits for Account Abstraction (AA) transactions.

## Features

- **Rate Limiting**: Enforce "no more than X amount over Y time" limits per authorized key
- **Multi-Token Support**: Support for any ERC-20 token with individual limits per token
- **Key Management**: Admin can authorize/revoke keys with custom spending limits
- **Automatic Cleanup**: Efficiently removes expired transaction records to optimize gas costs
- **Upgradeable**: Uses OpenZeppelin's UUPS proxy pattern for future upgrades
- **Comprehensive Testing**: Full test suite with edge case coverage

## How It Works

1. **Key Authorization**: The paymaster administrator authorizes keys to spend X amount of some ERC-20 over Y seconds
2. **Transaction Processing**: When AA transactions come in, the paymaster:
   - Looks up the key to verify authorization
   - Checks the amount and time constraints set by the administrator  
   - Reviews historical transactions within the time window
   - Calculates total amount spent within that time
   - Denies transaction if it would exceed the spending limit
   - Allows transaction if within limits and paymaster has sufficient balance
3. **Storage Management**: Transaction records are automatically cleaned up when they fall outside the time window

## Installation

```bash
# Clone the repository
git clone https://github.com/radiustechsystems/rate-limited-paymaster.git
cd rate-limited-paymaster

# Install dependencies
npm install
```

## Configuration

Create a `.env` file in the root directory:

```bash
PRIVATE_KEY=your_private_key_here
ETHERSCAN_API_KEY=your_etherscan_api_key_here
ALCHEMY_API_KEY=your_alchemy_api_key_here
```

## Usage

### Compile Contracts

```bash
npm run compile
```

### Run Tests

```bash
npm run test
```

### Deploy to Local Network

```bash
# Start local Hardhat network
npm run node

# Deploy in another terminal
npm run deploy
```

### Deploy to Testnet

```bash
npm run deploy:testnet
```

### Verify Contract

```bash
npm run verify -- --network sepolia <deployed_contract_address>
```

## Smart Contract API

### Core Functions

#### `authorizeKey(address key, address token, uint256 amount, uint256 timeWindow)`
Authorizes a key to spend up to `amount` of `token` within `timeWindow` seconds.

**Parameters:**
- `key`: The address that will be authorized to spend
- `token`: The ERC-20 token contract address
- `amount`: Maximum amount that can be spent in the time window
- `timeWindow`: Time window in seconds

**Access:** Owner only

#### `revokeKey(address key, address token)`
Revokes authorization for a key to spend a specific token.

**Access:** Owner only

#### `processPayment(address key, address token, uint256 amount)`
Processes a payment request, checking spending limits and transferring tokens if approved.

**Returns:** `bool` - Success status

**Reverts:**
- `KeyNotAuthorized` - If the key is not authorized for the token
- `SpendingLimitExceeded` - If payment would exceed the spending limit
- `InsufficientPaymasterBalance` - If paymaster doesn't have enough tokens

### View Functions

#### `getSpendingLimit(address key, address token)`
Returns the spending limit configuration for a key-token pair.

#### `getCurrentSpending(address key, address token)`
Returns the current amount spent by a key for a token within the time window.

#### `getRemainingSpendingCapacity(address key, address token)`
Returns the remaining spending capacity for a key-token pair.

#### `getTransactionCount(address key)`
Returns the number of tracked transactions for a key.

### Token Management

#### `depositToken(address token, uint256 amount)`
Deposits tokens into the paymaster contract.

#### `withdrawToken(address token, uint256 amount)`
Withdraws tokens from the paymaster contract.

**Access:** Owner only

## Example Usage

```javascript
const { ethers } = require("hardhat");

async function example() {
  const [owner, authorizedKey] = await ethers.getSigners();
  
  // Deploy paymaster
  const RateLimitedPaymaster = await ethers.getContractFactory("RateLimitedPaymaster");
  const paymaster = await upgrades.deployProxy(
    RateLimitedPaymaster,
    [owner.address],
    { initializer: "initialize", kind: "uups" }
  );

  // Deploy a test ERC-20 token
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const token = await MockERC20.deploy("Test Token", "TEST", ethers.parseEther("1000000"));

  // Fund the paymaster
  await token.transfer(paymaster.target, ethers.parseEther("10000"));

  // Authorize a key to spend 100 tokens per hour
  await paymaster.authorizeKey(
    authorizedKey.address,
    token.target,
    ethers.parseEther("100"), // 100 tokens
    3600 // 1 hour in seconds
  );

  // Process a payment
  await paymaster.processPayment(
    authorizedKey.address,
    token.target,
    ethers.parseEther("50") // 50 tokens
  );

  console.log("Payment processed successfully!");
}
```

## Testing

The project includes comprehensive tests covering:

- Key authorization and revocation
- Payment processing within and exceeding limits
- Time window expiration and cleanup
- Token management
- Access control
- Edge cases and error conditions

Run tests with:

```bash
npm test
```

Generate coverage report:

```bash
npm run coverage
```

## Security Considerations

- The contract uses OpenZeppelin's battle-tested libraries
- All ERC-20 transfers use `SafeERC20` to handle tokens with different implementations
- Access control is enforced through OpenZeppelin's `Ownable` pattern
- The contract includes proper input validation and custom errors
- Storage cleanup prevents unbounded gas costs over time

## Upgradeability

The contract uses OpenZeppelin's UUPS (Universal Upgradeable Proxy Standard) pattern:

- Only the owner can authorize upgrades
- The upgrade mechanism is built into the implementation contract
- Storage layout is preserved through upgrade gaps

To upgrade:

```bash
PROXY_ADDRESS=0x... npm run upgrade
```

## Gas Optimization

- Efficient storage cleanup removes expired transactions
- Batch operations where possible
- Uses custom errors to reduce deployment costs
- Optimized for minimal gas usage during normal operations

## License

MIT

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

For questions and support, please open an issue on the GitHub repository.