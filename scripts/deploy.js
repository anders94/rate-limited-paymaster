const { ethers, upgrades } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", (await deployer.provider.getBalance(deployer.address)).toString());

  // Deploy the upgradeable RateLimitedPaymaster contract
  const RateLimitedPaymaster = await ethers.getContractFactory("RateLimitedPaymaster");
  
  console.log("Deploying RateLimitedPaymaster...");
  const paymaster = await upgrades.deployProxy(
    RateLimitedPaymaster,
    [deployer.address], // Initialize with deployer as owner
    { 
      initializer: "initialize",
      kind: "uups"
    }
  );

  await paymaster.waitForDeployment();
  const paymasterAddress = await paymaster.getAddress();

  console.log("RateLimitedPaymaster deployed to:", paymasterAddress);
  console.log("Proxy admin owner:", deployer.address);

  // Verify the contract on Etherscan if not on localhost/hardhat
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 1337n && network.chainId !== 31337n) {
    console.log("Waiting for block confirmations...");
    await paymaster.deploymentTransaction().wait(5);
    
    try {
      await hre.run("verify:verify", {
        address: paymasterAddress,
        constructorArguments: [],
      });
      console.log("Contract verified on Etherscan");
    } catch (error) {
      console.log("Verification failed:", error.message);
    }
  }

  return {
    paymaster: paymasterAddress,
    owner: deployer.address
  };
}

main()
  .then((result) => {
    console.log("\nDeployment Summary:");
    console.log("===================");
    console.log("Paymaster:", result.paymaster);
    console.log("Owner:", result.owner);
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });