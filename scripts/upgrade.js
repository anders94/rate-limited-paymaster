const { ethers, upgrades } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  
  // Replace with your deployed proxy address
  const PROXY_ADDRESS = process.env.PROXY_ADDRESS;
  
  if (!PROXY_ADDRESS) {
    throw new Error("Please set PROXY_ADDRESS environment variable");
  }

  console.log("Upgrading contract with the account:", deployer.address);
  console.log("Proxy address:", PROXY_ADDRESS);

  const RateLimitedPaymasterV2 = await ethers.getContractFactory("RateLimitedPaymaster");
  
  console.log("Upgrading RateLimitedPaymaster...");
  const upgraded = await upgrades.upgradeProxy(PROXY_ADDRESS, RateLimitedPaymasterV2);
  
  await upgraded.waitForDeployment();
  
  console.log("RateLimitedPaymaster upgraded successfully");
  console.log("Proxy address:", await upgraded.getAddress());
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });