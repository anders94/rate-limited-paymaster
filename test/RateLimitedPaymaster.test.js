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

    it("Should start unpaused", async function () {
      const { paymaster } = await loadFixture(deployPaymasterFixture);
      expect(await paymaster.paused()).to.be.false;
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

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);

      await expect(paymaster.connect(owner).revokeKey(user1.address, token1.target))
        .to.emit(paymaster, "KeyRevoked")
        .withArgs(user1.address, token1.target);

      const limit = await paymaster.getSpendingLimit(user1.address, token1.target);
      expect(limit.isActive).to.be.false;
    });

    it("Should only allow owner to authorize keys", async function () {
      const { paymaster, token1, user1, user2 } = await loadFixture(deployPaymasterFixture);

      await expect(paymaster.connect(user1).authorizeKey(user2.address, token1.target, ethers.parseEther("100"), 3600))
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount")
        .withArgs(user1.address);
    });
  });

  describe("Payment Processing", function () {
    it("Should process payment within limits and pay the key", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);

      const amount = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("50");

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, amount, 3600);

      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, paymentAmount))
        .to.emit(paymaster, "PaymentProcessed")
        .withArgs(user1.address, token1.target, paymentAmount, (await time.latest()) + 1);

      expect(await token1.balanceOf(user1.address)).to.equal(paymentAmount);
    });

    it("Should return true from a static call when payment is allowed", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      expect(
        await paymaster.connect(user1).processPayment.staticCall(user1.address, token1.target, ethers.parseEther("1"))
      ).to.be.true;
    });

    it("Should revert when the caller is not the key", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);

      await expect(paymaster.connect(spender).processPayment(user1.address, token1.target, ethers.parseEther("50")))
        .to.be.revertedWithCustomError(paymaster, "CallerNotKey");
    });

    it("Should deny (not revert) payment for unauthorized key", async function () {
      const { paymaster, token1, user1 } = await loadFixture(deployPaymasterFixture);
      const amount = ethers.parseEther("50");

      expect(await paymaster.connect(user1).processPayment.staticCall(user1.address, token1.target, amount)).to.be.false;
      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, amount))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, amount, "Key not authorized");
      expect(await token1.balanceOf(user1.address)).to.equal(0);
    });

    it("Should deny payment exceeding spending limit", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);

      const amount = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("150");

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, amount, 3600);

      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, paymentAmount))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, paymentAmount, "Spending limit exceeded");
      expect(await token1.balanceOf(user1.address)).to.equal(0);
    });

    it("Should deny payment when paymaster has insufficient balance", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);

      const amount = ethers.parseEther("20000"); // More than paymaster balance

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, amount, 3600);

      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, amount))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, amount, "Insufficient paymaster balance");
    });

    it("Should track multiple payments within time window", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);

      const limit = ethers.parseEther("100");
      const payment1 = ethers.parseEther("30");
      const payment2 = ethers.parseEther("40");
      const payment3 = ethers.parseEther("50"); // This should be denied

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, limit, 3600);

      await paymaster.connect(user1).processPayment(user1.address, token1.target, payment1);
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(payment1);

      await paymaster.connect(user1).processPayment(user1.address, token1.target, payment2);
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(payment1 + payment2);

      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, payment3))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, payment3, "Spending limit exceeded");
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(payment1 + payment2);
    });

    it("Should allow payments after time window expires", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);

      const limit = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("60");
      const timeWindow = 3600;

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, limit, timeWindow);

      await paymaster.connect(user1).processPayment(user1.address, token1.target, paymentAmount);

      await time.increase(timeWindow + 1);

      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, paymentAmount))
        .to.emit(paymaster, "PaymentProcessed");
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(paymentAmount);
      // Expired record was cleaned up
      expect(await paymaster.getTransactionCount(user1.address)).to.equal(1);
    });

    it("Should keep per-token limits independent", async function () {
      const { paymaster, token1, token2, owner, user1 } = await loadFixture(deployPaymasterFixture);

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("10"), 3600);
      await paymaster.connect(owner).authorizeKey(user1.address, token2.target, ethers.parseEther("10"), 3600);

      await paymaster.connect(user1).processPayment(user1.address, token1.target, ethers.parseEther("10"));
      await expect(paymaster.connect(user1).processPayment(user1.address, token2.target, ethers.parseEther("10")))
        .to.emit(paymaster, "PaymentProcessed");
    });
  });

  describe("Pause", function () {
    it("Should deny payments while paused and allow after unpause", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      const amount = ethers.parseEther("10");

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);

      await expect(paymaster.connect(owner).pause()).to.emit(paymaster, "PausedChanged").withArgs(true);
      expect(await paymaster.paused()).to.be.true;

      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, amount))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, amount, "Paymaster paused");

      await expect(paymaster.connect(owner).unpause()).to.emit(paymaster, "PausedChanged").withArgs(false);

      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, amount))
        .to.emit(paymaster, "PaymentProcessed");
    });

    it("Should only allow owner to pause", async function () {
      const { paymaster, user1 } = await loadFixture(deployPaymasterFixture);
      await expect(paymaster.connect(user1).pause())
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });
  });

  describe("View Functions", function () {
    it("Should return correct remaining spending capacity", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);

      const limit = ethers.parseEther("100");
      const paymentAmount = ethers.parseEther("30");

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, limit, 3600);

      expect(await paymaster.getRemainingSpendingCapacity(user1.address, token1.target)).to.equal(limit);

      await paymaster.connect(user1).processPayment(user1.address, token1.target, paymentAmount);

      expect(await paymaster.getRemainingSpendingCapacity(user1.address, token1.target))
        .to.equal(limit - paymentAmount);
    });

    it("Should return correct transaction count and records", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);

      expect(await paymaster.getTransactionCount(user1.address)).to.equal(0);
      expect(await paymaster.getKeyTransactions(user1.address)).to.deep.equal([]);

      const amount = ethers.parseEther("30");
      await paymaster.connect(user1).processPayment(user1.address, token1.target, amount);

      expect(await paymaster.getTransactionCount(user1.address)).to.equal(1);
      const records = await paymaster.getKeyTransactions(user1.address);
      expect(records.length).to.equal(1);
      expect(records[0].amount).to.equal(amount);
      expect(records[0].token).to.equal(token1.target);
      expect(records[0].timestamp).to.equal(await time.latest());
    });

    it("checkPayment should mirror processPayment decisions", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      const ten = ethers.parseEther("10");

      let [ok, reason] = await paymaster.checkPayment(user1.address, token1.target, ten);
      expect(ok).to.be.false;
      expect(reason).to.equal("Key not authorized");

      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ten, 3600);
      [ok, reason] = await paymaster.checkPayment(user1.address, token1.target, ten);
      expect(ok).to.be.true;
      expect(reason).to.equal("");

      await paymaster.connect(user1).processPayment(user1.address, token1.target, ten);
      [ok, reason] = await paymaster.checkPayment(user1.address, token1.target, 1n);
      expect(ok).to.be.false;
      expect(reason).to.equal("Spending limit exceeded");

      await paymaster.connect(owner).pause();
      [ok, reason] = await paymaster.checkPayment(user1.address, token1.target, 1n);
      expect(reason).to.equal("Paymaster paused");

      await paymaster.connect(owner).unpause();
      [ok, reason] = await paymaster.checkPayment(user1.address, token1.target, ethers.parseEther("20000"));
      expect(reason).to.equal("Insufficient paymaster balance");
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

      await token1.connect(owner).approve(paymaster.target, depositAmount);
      await paymaster.connect(owner).depositToken(token1.target, depositAmount);

      expect(await token1.balanceOf(paymaster.target)).to.equal(ethers.parseEther("10500"));
    });

    it("Should only allow owner to withdraw", async function () {
      const { paymaster, token1, user1 } = await loadFixture(deployPaymasterFixture);

      await expect(paymaster.connect(user1).withdrawToken(token1.target, ethers.parseEther("100")))
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });
  });

  describe("Upgrades", function () {
    it("Should be upgradeable by owner", async function () {
      const { paymaster } = await loadFixture(deployPaymasterFixture);

      const RateLimitedPaymasterV2 = await ethers.getContractFactory("RateLimitedPaymaster");

      await expect(upgrades.upgradeProxy(paymaster.target, RateLimitedPaymasterV2))
        .to.not.be.reverted;
    });

    it("Should reject upgrades from non-owners", async function () {
      const { paymaster, user1 } = await loadFixture(deployPaymasterFixture);
      const Impl = await ethers.getContractFactory("RateLimitedPaymaster");
      const impl = await Impl.deploy();
      await expect(paymaster.connect(user1).upgradeToAndCall(impl.target, "0x"))
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });
  });

  describe("Manual proxy deployment (what the web UI does)", function () {
    it("Should work with a bare ERC1967Proxy + initialize calldata", async function () {
      const [owner, user1] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("RateLimitedPaymaster");
      const impl = await Impl.deploy();
      const initData = Impl.interface.encodeFunctionData("initialize", [owner.address]);
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await Proxy.deploy(impl.target, initData);
      const paymaster = Impl.attach(proxy.target);

      expect(await paymaster.owner()).to.equal(owner.address);
      await expect(paymaster.connect(user1).pause())
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
      // Implementation cannot be re-initialized
      await expect(paymaster.initialize(user1.address))
        .to.be.revertedWithCustomError(paymaster, "InvalidInitialization");
    });
  });
});
