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

      const next = (await time.latest()) + 5;
      await time.setNextBlockTimestamp(next);
      await expect(paymaster.connect(user1).processPayment(user1.address, token1.target, paymentAmount))
        .to.emit(paymaster, "PaymentProcessed")
        .withArgs(user1.address, token1.target, paymentAmount, next);

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

    it("Should let initializeV2 run exactly once (upgrade path for legacy proxies)", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).initializeV2();
      await expect(paymaster.initializeV2()).to.be.revertedWithCustomError(paymaster, "InvalidInitialization");
      // Domain still verifies signed requests
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("10"), 60);
      const req = await makeReq(paymaster, user1, token1, user2.address, 1n);
      await expect(paymaster.connect(spender).processSignedPayment(req, await signRequest(user1, paymaster, req))).to.emit(paymaster, "PaymentProcessed");
    });

    it("Should upgrade a proxy to a new implementation with upgradeToAndCall(initializeV2)", async function () {
      const [owner, user1] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("RateLimitedPaymaster");
      const implV1 = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await Proxy.deploy(implV1.target, Impl.interface.encodeFunctionData("initialize", [owner.address]));
      const pm = Impl.attach(proxy.target);
      const implV2 = await Impl.deploy();
      const data = Impl.interface.encodeFunctionData("initializeV2", []);
      await expect(pm.connect(user1).upgradeToAndCall(implV2.target, data)).to.be.revertedWithCustomError(pm, "OwnableUnauthorizedAccount");
      // initializeV2 on a proxy still at version 1 is fine; on this fresh proxy initialize() already set v1
      await expect(pm.connect(owner).upgradeToAndCall(implV2.target, data)).to.emit(pm, "Upgraded").withArgs(implV2.target);
      expect(await pm.owner()).to.equal(owner.address);
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

  // -------------------------------------------------------------------------
  // Signed requests (relayer path) and enrollment
  // -------------------------------------------------------------------------

  async function signRequest(signer, paymaster, req) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: "RateLimitedPaymaster", version: "1", chainId, verifyingContract: await paymaster.getAddress() };
    const types = {
      PaymentRequest: [
        { name: "key", type: "address" },
        { name: "token", type: "address" },
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    return signer.signTypedData(domain, types, req);
  }

  async function makeReq(paymaster, key, token, to, amount, overrides = {}) {
    return {
      key: key.address,
      token: token.target,
      to,
      amount,
      nonce: await paymaster.nonces(key.address),
      deadline: (await time.latest()) + 600,
      ...overrides,
    };
  }

  describe("Signed payments", function () {
    it("Should pay the recipient from a request signed by the key, submitted by a relayer", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      const amount = ethers.parseEther("25");
      const req = await makeReq(paymaster, user1, token1, user2.address, amount);
      const sig = await signRequest(user1, paymaster, req);

      expect(await paymaster.connect(spender).processSignedPayment.staticCall(req, sig)).to.be.true;
      const next = (await time.latest()) + 5;
      await time.setNextBlockTimestamp(next);
      await expect(paymaster.connect(spender).processSignedPayment(req, sig))
        .to.emit(paymaster, "PaymentProcessed")
        .withArgs(user1.address, token1.target, amount, next);

      expect(await token1.balanceOf(user2.address)).to.equal(amount);
      expect(await token1.balanceOf(user1.address)).to.equal(0);
      expect(await token1.balanceOf(spender.address)).to.equal(0);
      expect(await paymaster.nonces(user1.address)).to.equal(1);
      expect(await paymaster.getCurrentSpending(user1.address, token1.target)).to.equal(amount);
    });

    it("Should deny a request signed by someone other than the key and leave the nonce untouched", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      const req = await makeReq(paymaster, user1, token1, user2.address, ethers.parseEther("1"));
      const sig = await signRequest(user2, paymaster, req);
      await expect(paymaster.connect(spender).processSignedPayment(req, sig))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, ethers.parseEther("1"), "Invalid signature");
      expect(await paymaster.nonces(user1.address)).to.equal(0);
    });

    it("Should deny a malformed signature without reverting", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      const req = await makeReq(paymaster, user1, token1, user2.address, 1n);
      await expect(paymaster.connect(spender).processSignedPayment(req, "0x1234"))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, 1n, "Invalid signature");
    });

    it("Should deny an expired request and leave the nonce untouched", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      const req = await makeReq(paymaster, user1, token1, user2.address, 1n, { deadline: (await time.latest()) - 1 });
      const sig = await signRequest(user1, paymaster, req);
      await expect(paymaster.connect(spender).processSignedPayment(req, sig))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, 1n, "Request expired");
      expect(await paymaster.nonces(user1.address)).to.equal(0);
    });

    it("Should deny a wrong nonce and reject a replay", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("100"), 3600);
      const bad = await makeReq(paymaster, user1, token1, user2.address, 1n, { nonce: 5 });
      await expect(paymaster.connect(spender).processSignedPayment(bad, await signRequest(user1, paymaster, bad)))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, 1n, "Bad nonce");

      const good = await makeReq(paymaster, user1, token1, user2.address, 1n);
      const sig = await signRequest(user1, paymaster, good);
      await expect(paymaster.connect(spender).processSignedPayment(good, sig)).to.emit(paymaster, "PaymentProcessed");
      // Replay of the same signed request
      await expect(paymaster.connect(spender).processSignedPayment(good, sig))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, 1n, "Bad nonce");
      expect(await token1.balanceOf(user2.address)).to.equal(1n);
    });

    it("Should consume the nonce when a well-formed request is denied for the limit", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("10"), 3600);
      const req = await makeReq(paymaster, user1, token1, user2.address, ethers.parseEther("11"));
      await expect(paymaster.connect(spender).processSignedPayment(req, await signRequest(user1, paymaster, req)))
        .to.emit(paymaster, "PaymentDenied")
        .withArgs(user1.address, token1.target, ethers.parseEther("11"), "Spending limit exceeded");
      expect(await paymaster.nonces(user1.address)).to.equal(1);
    });

    it("Should process a batch from one key in order: 3 paid then 2 denied", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("10"), 60);
      const three = ethers.parseEther("3");
      const reqs = [];
      const sigs = [];
      for (let n = 0; n < 5; n++) {
        const r = await makeReq(paymaster, user1, token1, user2.address, three, { nonce: n });
        reqs.push(r);
        sigs.push(await signRequest(user1, paymaster, r));
      }
      const results = await paymaster.connect(spender).processSignedPayments.staticCall(reqs, sigs);
      expect(results).to.deep.equal([true, true, true, false, false]);

      const tx = await paymaster.connect(spender).processSignedPayments(reqs, sigs);
      const receipt = await tx.wait();
      const names = receipt.logs.map((l) => { try { return paymaster.interface.parseLog(l)?.name; } catch { return undefined; } }).filter(Boolean);
      expect(names).to.deep.equal(["PaymentProcessed", "PaymentProcessed", "PaymentProcessed", "PaymentDenied", "PaymentDenied"]);
      expect(await token1.balanceOf(user2.address)).to.equal(three * 3n);
      expect(await paymaster.nonces(user1.address)).to.equal(5);
      expect(await paymaster.getRemainingSpendingCapacity(user1.address, token1.target)).to.equal(ethers.parseEther("1"));
    });

    it("Should process a batch across several keys with independent limits", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("5"), 60);
      await paymaster.connect(owner).authorizeKey(user2.address, token1.target, ethers.parseEther("5"), 60);
      const r1 = await makeReq(paymaster, user1, token1, spender.address, ethers.parseEther("5"));
      const r2 = await makeReq(paymaster, user2, token1, spender.address, ethers.parseEther("5"));
      const r3 = await makeReq(paymaster, user1, token1, spender.address, ethers.parseEther("1"), { nonce: 1 });
      const sigs = [await signRequest(user1, paymaster, r1), await signRequest(user2, paymaster, r2), await signRequest(user1, paymaster, r3)];
      const results = await paymaster.connect(spender).processSignedPayments.staticCall([r1, r2, r3], sigs);
      expect(results).to.deep.equal([true, true, false]);
      await paymaster.connect(spender).processSignedPayments([r1, r2, r3], sigs);
      expect(await token1.balanceOf(spender.address)).to.equal(ethers.parseEther("10"));
    });

    it("Should revert a batch with mismatched array lengths", async function () {
      const { paymaster, token1, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      const r = await makeReq(paymaster, user1, token1, user2.address, 1n);
      await expect(paymaster.connect(spender).processSignedPayments([r], [])).to.be.revertedWithCustomError(paymaster, "LengthMismatch");
    });

    it("Should expose the EIP-712 digest used for signing", async function () {
      const { paymaster, token1, user1, user2 } = await loadFixture(deployPaymasterFixture);
      const req = await makeReq(paymaster, user1, token1, user2.address, 7n);
      const { chainId } = await ethers.provider.getNetwork();
      const domain = { name: "RateLimitedPaymaster", version: "1", chainId, verifyingContract: paymaster.target };
      const types = { PaymentRequest: [
        { name: "key", type: "address" }, { name: "token", type: "address" }, { name: "to", type: "address" },
        { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" } ] };
      expect(await paymaster.hashPaymentRequest(req)).to.equal(ethers.TypedDataEncoder.hash(domain, types, req));
    });
  });

  describe("Enrollment", function () {
    it("Should let an authorizer enroll keys under the owner's policy", async function () {
      const { paymaster, token1, owner, user1, spender } = await loadFixture(deployPaymasterFixture);
      await expect(paymaster.connect(owner).setAuthorizer(spender.address, true))
        .to.emit(paymaster, "AuthorizerChanged").withArgs(spender.address, true);
      await expect(paymaster.connect(owner).setEnrollmentPolicy(token1.target, ethers.parseEther("10"), 60, true))
        .to.emit(paymaster, "EnrollmentPolicyChanged").withArgs(token1.target, ethers.parseEther("10"), 60, true);

      await expect(paymaster.connect(spender).enrollKey(user1.address, token1.target))
        .to.emit(paymaster, "KeyAuthorized").withArgs(user1.address, token1.target, ethers.parseEther("10"), 60);
      const limit = await paymaster.getSpendingLimit(user1.address, token1.target);
      expect(limit.isActive).to.be.true;
      expect(limit.amount).to.equal(ethers.parseEther("10"));
      const policy = await paymaster.getEnrollmentPolicy(token1.target);
      expect(policy.enabled).to.be.true;
    });

    it("Should reject enrollment from strangers, when disabled, or when already active", async function () {
      const { paymaster, token1, owner, user1, user2, spender } = await loadFixture(deployPaymasterFixture);
      await expect(paymaster.connect(user2).enrollKey(user1.address, token1.target))
        .to.be.revertedWithCustomError(paymaster, "NotAuthorizer");

      await paymaster.connect(owner).setAuthorizer(spender.address, true);
      await expect(paymaster.connect(spender).enrollKey(user1.address, token1.target))
        .to.be.revertedWithCustomError(paymaster, "EnrollmentDisabled");

      await paymaster.connect(owner).setEnrollmentPolicy(token1.target, ethers.parseEther("10"), 60, true);
      await paymaster.connect(spender).enrollKey(user1.address, token1.target);
      await expect(paymaster.connect(spender).enrollKey(user1.address, token1.target))
        .to.be.revertedWithCustomError(paymaster, "AlreadyAuthorized");

      // Owner can override an enrolled key's limit, and revoke lets it be re-enrolled
      await paymaster.connect(owner).authorizeKey(user1.address, token1.target, ethers.parseEther("50"), 120);
      expect((await paymaster.getSpendingLimit(user1.address, token1.target)).amount).to.equal(ethers.parseEther("50"));
      await paymaster.connect(owner).revokeKey(user1.address, token1.target);
      await expect(paymaster.connect(spender).enrollKey(user1.address, token1.target)).to.emit(paymaster, "KeyAuthorized");

      // Owner may enroll directly too; removing the authorizer stops the relayer
      await paymaster.connect(owner).setEnrollmentPolicy(token1.target, ethers.parseEther("10"), 60, true);
      await paymaster.connect(owner).setAuthorizer(spender.address, false);
      await expect(paymaster.connect(spender).enrollKey(user2.address, token1.target))
        .to.be.revertedWithCustomError(paymaster, "NotAuthorizer");
      await expect(paymaster.connect(owner).enrollKey(user2.address, token1.target)).to.emit(paymaster, "KeyAuthorized");
    });

    it("Should enroll many keys in one transaction", async function () {
      const { paymaster, token1, owner, spender } = await loadFixture(deployPaymasterFixture);
      await paymaster.connect(owner).setAuthorizer(spender.address, true);
      await paymaster.connect(owner).setEnrollmentPolicy(token1.target, ethers.parseEther("10"), 60, true);
      const keys = Array.from({ length: 5 }, () => ethers.Wallet.createRandom().address);
      const tx = await paymaster.connect(spender).enrollKeys(keys, token1.target);
      const receipt = await tx.wait();
      expect(receipt.logs.filter((l) => { try { return paymaster.interface.parseLog(l)?.name === "KeyAuthorized"; } catch { return false; } }).length).to.equal(5);
      for (const k of keys) expect((await paymaster.getSpendingLimit(k, token1.target)).isActive).to.be.true;
      // One duplicate makes the whole batch revert (the relayer de-duplicates before sending)
      await expect(paymaster.connect(spender).enrollKeys([keys[0]], token1.target)).to.be.revertedWithCustomError(paymaster, "AlreadyAuthorized");
    });

    it("Should reject an enabled policy with zero amount or window, and only owner may set it", async function () {
      const { paymaster, token1, owner, user1 } = await loadFixture(deployPaymasterFixture);
      await expect(paymaster.connect(owner).setEnrollmentPolicy(token1.target, 0, 60, true)).to.be.revertedWithCustomError(paymaster, "InvalidAmount");
      await expect(paymaster.connect(owner).setEnrollmentPolicy(token1.target, 1, 0, true)).to.be.revertedWithCustomError(paymaster, "InvalidTimeWindow");
      await expect(paymaster.connect(user1).setEnrollmentPolicy(token1.target, 1, 1, true)).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
      await expect(paymaster.connect(user1).setAuthorizer(user1.address, true)).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
      // Disabling with zeros is fine
      await paymaster.connect(owner).setEnrollmentPolicy(token1.target, 0, 0, false);
    });

    it("End to end: enrolled ephemeral key, relayed signed payment, key never holds anything", async function () {
      const { paymaster, token1, owner, spender } = await loadFixture(deployPaymasterFixture);
      const ephemeral = ethers.Wallet.createRandom().connect(ethers.provider); // never funded
      const merchant = ethers.Wallet.createRandom();
      await paymaster.connect(owner).setAuthorizer(spender.address, true);
      await paymaster.connect(owner).setEnrollmentPolicy(token1.target, ethers.parseEther("10"), 60, true);
      await paymaster.connect(spender).enrollKey(ephemeral.address, token1.target);

      const req = await makeReq(paymaster, ephemeral, token1, merchant.address, ethers.parseEther("4"));
      const sig = await signRequest(ephemeral, paymaster, req);
      await expect(paymaster.connect(spender).processSignedPayment(req, sig)).to.emit(paymaster, "PaymentProcessed");
      expect(await token1.balanceOf(merchant.address)).to.equal(ethers.parseEther("4"));
      expect(await ethers.provider.getBalance(ephemeral.address)).to.equal(0);
      expect(await token1.balanceOf(ephemeral.address)).to.equal(0);
    });
  });
});
