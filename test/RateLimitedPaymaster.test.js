const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("RateLimitedPaymaster", function () {
  async function deployPaymasterFixture() {
    const [owner, user1, user2, spender] = await ethers.getSigners();

    // Deploy mock ERC20 tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token1 = await MockERC20.deploy("Token1", "TK1", ethers.parseEther("1000000"));
    const token2 = await MockERC20.deploy("Token2", "TK2", ethers.parseEther("1000000"));

    // Deploy the upgradeable paymaster
    const RateLimitedPaymaster = await ethers.getContractFactory("RateLimitedPaymaster");
    const paymaster = await upgrades.deployProxy(
      RateLimitedPaymaster,
      [owner.address],
      { initializer: "initialize", kind: "uups" }
    );

    // Fund the paymaster with tokens
    await token1.transfer(paymaster.target, ethers.parseEther("10000"));
    await token2.transfer(paymaster.target, ethers.parseEther("10000"));

    return { paymaster, token1, token2, owner, user1, user2, spender };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { paymaster, owner } = await loadFixture(deployPaymasterFixture);
      expect(await paymaster.owner()).to.equal(owner.address);
    });

    it("Should have correct token balances", async function () {
      const { paymaster, token1, token2 } = await loadFixture(deployPaymasterFixture);
      expect(await token1.balanceOf(paymaster.target)).to.equal(ethers.parseEther("10000"));
      expect(await token2.balanceOf(paymaster.target)).to.equal(ethers.parseEther("10000"));
    });
  });

  describe("Key Authorization", function () {
    it("Should authorize a key with spending limits", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      
      const amount = ethers.parseEther("100");
      const timeWindow = 3600; // 1 hour
      
      await expect(paymaster.connect(owner).authorizeKey(user1.address, token1.target, amount, timeWindow))
        .to.emit(paymaster, "KeyAuthorized")
        .withArgs(user1.address, token1.target, amount, timeWindow);

      const limit = await paymaster.getSpendingLimit(user1.address, token1.target);
      expect(limit.amount).to.equal(amount);
      expect(limit.timeWindow).to.equal(timeWindow);
      expect(limit.isActive).to.be.true;
    });

    it("Should reject authorization with zero amount", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      
      await expect(paymaster.connect(owner).authorizeKey(user1.address, token1.target, 0, 3600))
        .to.be.revertedWithCustomError(paymaster, "InvalidAmount");
    });

    it("Should reject authorization with zero time window", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      
      await expect(paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 0))
        .to.be.revertedWithCustomError(paymaster, "InvalidTimeWindow");
    });

    it("Should revoke a key", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      
      // First authorize
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      
      // Then revoke
      await expect(paymaster.connect(owner).revokeKey(user1.address, token1.target))
        .to.emit(paymaster, "KeyRevoked")
        .withArgs(user1.address, token1.target);

      const limit = await paymaster.getSpendingLimit(user1.address, token1.target);
      expect(limit.isActive).to.be.false;
    });

    it("Should only allow owner to authorize keys", async function () {
      const { paymaster, token1, user1, user2 } = await loadFixture(deployPaymasterFixture);
      
      await expect(paymaster.connect(user1).authorizeKey(user2.address, token1.target, ethers.parseEther("100"), 3600))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Payment Processing", function () {
    it("Should process payment within limits", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      const amount = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("50");
      
      // Authorize key
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, amount, 3600);
      
      // Process payment
      await expect(paymaster.connect(spender).processPayment(user1.address, token1.target, paymentAmount))
        .to.emit(paymaster, "PaymentProcessed")
        .withArgs(user1.address, token1.target, paymentAmount, await time.latest() + 1);

      // Check token transfer
      expect(await token1.balanceOf(spender.address)).to.equal(paymentAmount);
    });

    it("Should reject payment for unauthorized key", async function () {
      const { paymaster, token1, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      await expect(paymaster.connect(spender).processPayment(user1.address, token1.target, ethers.parseEther("50")))
        .to.be.revertedWithCustomError(paymaster, "KeyNotAuthorized");
    });

    it("Should reject payment exceeding spending limit", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      const amount = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("150");
      
      // Authorize key
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, amount, 3600);
      
      // Process payment that exceeds limit
      await expect(paymaster.connect(spender).processPayment(user1.address, token1.target, paymentAmount))
        .to.be.revertedWithCustomError(paymaster, "SpendingLimitExceeded");
    });

    it("Should reject payment when paymaster has insufficient balance", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      const amount = ethers.parseEther("20000"); // More than paymaster balance
      
      // Authorize key
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, amount, 3600);
      
      // Process payment
      await expect(paymaster.connect(spender).processPayment(user1.address, token1.target, amount))
        .to.be.revertedWithCustomError(paymaster, "InsufficientPaymasterBalance");
    });

    it("Should track multiple payments within time window", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      const limit = ethers.parseEther("100");
      const payment1 = ethers.parseEther("30");
      const payment2 = ethers.parseEther("40");
      const payment3 = ethers.parseEther("50"); // This should fail
      
      // Authorize key
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, limit, 3600);
      
      // First payment
      await paymaster.connect(spender).processPayment(user1.address, token1.target, payment1);
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(payment1);
      
      // Second payment
      await paymaster.connect(spender).processPayment(user1.address, token1.target, payment2);
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(payment1 + payment2);
      
      // Third payment should fail
      await expect(paymaster.connect(spender).processPayment(user1.address, token1.target, payment3))
        .to.be.revertedWithCustomError(paymaster, "SpendingLimitExceeded");
    });

    it("Should allow payments after time window expires", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      const limit = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("60");
      const timeWindow = 3600;
      
      // Authorize key
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, limit, timeWindow);
      
      // First payment
      await paymaster.connect(spender).processPayment(user1.address, token1.target, paymentAmount);
      
      // Advance time beyond the window
      await time.increase(timeWindow + 1);
      
      // Second payment should now be allowed
      await paymaster.connect(spender).processPayment(user1.address, token1.target, paymentAmount);
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(paymentAmount);
    });
  });

  describe("View Functions", function () {
    it("Should return correct remaining spending capacity", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      const limit = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("30");
      
      // Authorize key
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, limit, 3600);
      
      // Check initial capacity
      expect(await paymaster.getRemainingSpendingCapacity(user1.address, token1.target)).to.equal(limit);
      
      // Make payment
      await paymaster.connect(spender).processPayment(user1.address, token1.target, paymentAmount);
      
      // Check remaining capacity
      expect(await paymaster.getRemainingSpendingCapacity(user1.address, token1.target))
        .to.equal(limit - paymentAmount);
    });

    it("Should return correct transaction count", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      
      // Authorize key
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      
      // Initial count should be 0
      expect(await paymaster.getTransactionCount(user1.address)).to.equal(0);
      
      // Make a payment
      await paymaster.connect(spender).processPayment(user1.address, token1.target, ethers.parseEther("30"));
      
      // Count should be 1
      expect(await paymaster.getTransactionCount(user1.address)).to.equal(1);
    });
  });

  describe("Token Management", function () {
    it("Should allow owner to withdraw tokens", async function () {
      const { paymaster, token1, owner } = await loadFixture(deployPaymasterFixture);
      
      const withdrawAmount = ethers.parseEther("1000");
      const initialBalance = await token1.balanceOf(owner.address);
      
      await paymaster.connect(owner).withdrawToken(token1.target, withdrawAmount);
      
      expect(await token1.balanceOf(owner.address)).to.equal(initialBalance + withdrawAmount);
      expect(await token1.balanceOf(paymaster.target)).to.equal(ethers.parseEther("9000"));
    });

    it("Should allow deposits", async function () {
      const { paymaster, token1, owner } = await loadFixture(deployPaymasterFixture);
      
      const depositAmount = ethers.parseEther("500");
      
      // Approve and deposit
      await token1.connect(owner).approve(paymaster.target, depositAmount);
      await paymaster.connect(owner).depositToken(token1.target, depositAmount);
      
      expect(await token1.balanceOf(paymaster.target)).to.equal(ethers.parseEther("10500"));
    });

    it("Should only allow owner to withdraw", async function () {
      const { paymaster, token1, user1 } = await loadFixture(deployPaymasterFixture);
      
      await expect(paymaster.connect(user1).withdrawToken(token1.target, ethers.parseEther("100")))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Upgrades", function () {
    it("Should be upgradeable by owner", async function () {
      const { paymaster, owner } = await loadFixture(deployPaymasterFixture);
      
      const RateLimitedPaymasterV2 = await ethers.getContractFactory("RateLimitedPaymaster");
      
      // This should not revert if the owner is calling it
      await expect(upgrades.upgradeProxy(paymaster.target, RateLimitedPaymasterV2))
        .to.not.be.reverted;
    });
  });
});