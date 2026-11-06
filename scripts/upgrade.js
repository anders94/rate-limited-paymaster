// Upgrade an existing RateLimitedPaymaster proxy to the current implementation.
//
//   PROXY_ADDRESS=0x... PRIVATE_KEY=<owner key> npx hardhat run scripts/upgrade.js --network radiusTestnet
//
// Done explicitly (deploy implementation, then upgradeToAndCall) rather than via
// the upgrades plugin, so it works for proxies deployed from the web UI that the
// plugin's manifest has never seen. Proxies that predate signed requests get
// initializeV2() in the same transaction, which sets the EIP-712 domain.
const { ethers } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  const PROXY_ADDRESS = process.env.PROXY_ADDRESS;
  if (!PROXY_ADDRESS) throw new Error("Please set PROXY_ADDRESS environment variable");

  const Factory = await ethers.getContractFactory("RateLimitedPaymaster");
  const proxy = Factory.attach(PROXY_ADDRESS);
  const owner = await proxy.owner();
  console.log("Proxy:", PROXY_ADDRESS, "owner:", owner, "signer:", signer.address);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error("Signer is not the proxy owner");

  const needsV2 = await proxy.PAYMENT_REQUEST_TYPEHASH().then(() => false).catch(() => true);
  console.log(needsV2 ? "Legacy implementation detected: will call initializeV2()" : "Already supports signed requests: plain upgrade");

  const feeData = await ethers.provider.getFeeData();
  const overrides = feeData.gasPrice ? { gasPrice: feeData.gasPrice } : {}; // legacy gasPrice: Radius has a fixed price

  console.log("Deploying implementation...");
  const impl = await Factory.deploy(overrides);
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log("Implementation:", implAddress);

  const data = needsV2 ? Factory.interface.encodeFunctionData("initializeV2", []) : "0x";
  console.log("Calling upgradeToAndCall...");
  const tx = await proxy.upgradeToAndCall(implAddress, data, overrides);
  const receipt = await tx.wait();
  console.log("Upgraded in tx", receipt.hash);

  const domain = await proxy.eip712Domain();
  console.log("EIP-712 domain:", domain[1], "v" + domain[2], "| typehash", await proxy.PAYMENT_REQUEST_TYPEHASH());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.shortMessage ?? error.message ?? error);
    process.exit(1);
  });
