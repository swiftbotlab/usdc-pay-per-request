// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {UsdcPayPerRequest} from "../src/UsdcPayPerRequest.sol";
import {RejectingReceiver, PayerAccount} from "./Helpers.sol";

/// @dev Stateful handler with an independent model of every rule. Each call predicts success or the EXACT revert data
///      (selector + parameters) and compares it with what the contract did; any difference counts as a mismatch.
///      Ghosts: successful pays/refunds per requestId, exact balance deltas of every USDC movement.
contract PaywallHandler is Test {
    UsdcPayPerRequest public immutable c;
    address[2] internal providers;
    address[3] internal payers; // payers[2] is a smart account that rejects refunds
    address internal outsider;
    address internal payeeA;
    address internal payeeB;
    address internal rejPayee; // a payee that cannot receive (must withdraw elsewhere)
    address internal rejSink; // another address that cannot receive
    address[5] public creditHolders; // every address that can ever hold credit

    uint256 internal constant MAX_ENDPOINTS = 6;

    struct E {
        address provider;
        address payee;
        uint128 price;
        bool active;
        uint64 paidCount;
        uint128 totalPaid;
        uint128 totalRefunded;
        uint64 refundCount;
    }

    struct P {
        address payer;
        uint256 endpointId;
        uint128 amount;
        bool refunded;
    }

    mapping(uint256 => E) internal m;
    uint256 public count;
    mapping(bytes32 => P) internal pm;
    bytes32[33] public pool; // candidate requestIds: 4 payer prefixes x 8 salts + bytes32(0)
    mapping(address => uint256) public mCredit;
    mapping(address => mapping(address => bool)) public mApproved; // payee => provider
    uint256 public mPaid;
    uint256 public mRefunded;
    uint256 public mWithdrawn;

    // ghosts
    mapping(bytes32 => uint256) public ghostPays;
    mapping(bytes32 => uint256) public ghostRefunds;
    uint256 public mismatches;
    uint256 public badTransfers;
    string public lastMismatch;
    mapping(string => uint256) public calls;
    string[] internal callNames;

    constructor(UsdcPayPerRequest c_) {
        c = c_;
        providers = [makeAddr("providerA"), makeAddr("providerB")];
        PayerAccount acct = new PayerAccount(c_);
        acct.setMode(1); // rejects refunds
        payers = [makeAddr("agentA"), makeAddr("agentB"), address(acct)];
        outsider = makeAddr("outsider");
        payeeA = makeAddr("payeeA");
        payeeB = makeAddr("payeeB");
        rejPayee = address(new RejectingReceiver());
        rejSink = address(new RejectingReceiver());
        creditHolders = [payeeA, payeeB, rejPayee, providers[0], providers[1]];
        // consent: payeeA approves both providers, rejPayee approves provider A only, payeeB nobody (yet)
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(payeeA);
            c_.approveProvider(providers[i], true);
            mApproved[payeeA][providers[i]] = true;
        }
        vm.prank(rejPayee);
        c_.approveProvider(providers[0], true);
        mApproved[rejPayee][providers[0]] = true;
        for (uint256 i = 0; i < 3; i++) vm.deal(payers[i], 1_000_000 ether);
        vm.deal(outsider, 1_000_000 ether);
        address[4] memory prefixes = [payers[0], payers[1], payers[2], address(0)];
        for (uint256 p = 0; p < 4; p++) {
            for (uint256 s = 0; s < 8; s++) {
                pool[p * 8 + s] = c_.requestIdFor(prefixes[p], keccak256(abi.encode("salt", s)));
            }
        }
        pool[32] = bytes32(0);
        string[20] memory names = ["approve", "approve_rej", "register", "register_rej", "setPrice", "setPrice_rej", "setActive", "setActive_rej",
            "pay_ok", "pay_rej", "refund_ok", "refund_rej", "withdraw_ok", "withdraw_rej", "warp", "rej_notForPayer",
            "rej_alreadyPaid", "rej_wrongAmount", "rej_transferFailed", "rej_insufficientCredit"];
        for (uint256 i = 0; i < names.length; i++) callNames.push(names[i]);
    }

    // ------------------------------------------------------------------ helpers
    function _h(uint256 x, string memory tag) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(x, tag)));
    }

    function _pickEndpoint(uint256 seed) internal view returns (uint256) {
        seed = _h(seed, "ep");
        if (count == 0 || seed % 12 == 0) return seed % 2 == 0 ? 0 : count + 1;
        return 1 + (seed % count);
    }

    function _price(uint256 seed) internal pure returns (uint128) {
        uint256 s = _h(seed, "price");
        uint256 k = s % 6;
        if (k == 0) return 0;
        if (k == 1) return 1;
        if (k == 2) return 0.01e18;
        if (k == 3) return 0.05e18;
        return uint128(1 + (s >> 8) % 1e18);
    }

    function _canReceive(address a) internal view returns (bool) {
        return a != rejPayee && a != rejSink && a != address(c) && a != payers[2];
    }

    function _compare(string memory what, bool ok, bytes memory ret, bytes memory expected) internal {
        bool expectOk = expected.length == 0;
        if (ok != expectOk || (!ok && keccak256(ret) != keccak256(expected))) {
            mismatches++;
            lastMismatch = what;
            console.log("MISMATCH", what);
            console.logBytes(ret);
            console.logBytes(expected);
        }
    }

    // ------------------------------------------------------------------ actions
    function register(uint256 seed) external {
        if (count >= MAX_ENDPOINTS && seed % 4 != 0) return;
        address provider = providers[seed % 2];
        uint256 s = _h(seed, "payee");
        address[6] memory payeeChoices = [payeeA, payeeB, rejPayee, provider, address(0), address(c)];
        address payee = payeeChoices[s % 8 < 6 ? s % 8 : s % 4];
        uint128 price = _price(seed);
        uint256 nk = _h(seed, "name") % 10;
        string memory name = nk == 0 ? "" : (nk == 1
            ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // 65 bytes
            : "GET /v1/weather");
        bytes memory expected;
        if (payee == address(0)) expected = abi.encodeWithSelector(UsdcPayPerRequest.ZeroAddress.selector);
        else if (payee == address(c)) expected = abi.encodeWithSelector(UsdcPayPerRequest.InvalidPayee.selector);
        else if (payee != provider && !mApproved[payee][provider]) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.PayeeNotApproved.selector, payee);
        } else if (price == 0) expected = abi.encodeWithSelector(UsdcPayPerRequest.InvalidPrice.selector);
        else if (nk <= 1) expected = abi.encodeWithSelector(UsdcPayPerRequest.InvalidName.selector);
        vm.prank(provider);
        (bool ok, bytes memory ret) = address(c).call(abi.encodeCall(c.registerEndpoint, (price, payee, name)));
        _compare("register", ok, ret, expected);
        if (ok && expected.length == 0) {
            count++;
            if (abi.decode(ret, (uint256)) != count) {
                mismatches++;
                lastMismatch = "register id";
            }
            m[count] = E(provider, payee, price, true, 0, 0, 0, 0);
            calls["register"]++;
        } else {
            calls["register_rej"]++;
        }
    }

    function approve(uint256 seed) external {
        address[3] memory payeesList = [payeeA, payeeB, rejPayee];
        address payee = payeesList[_h(seed, "who") % 3];
        uint256 ps = _h(seed, "prov") % 9;
        address provider = ps == 8 ? address(0) : providers[ps % 2];
        bool approved = _h(seed, "ok") % 3 != 0;
        bytes memory expected;
        if (provider == address(0)) expected = abi.encodeWithSelector(UsdcPayPerRequest.ZeroAddress.selector);
        vm.prank(payee);
        (bool ok, bytes memory ret) = address(c).call(abi.encodeCall(c.approveProvider, (provider, approved)));
        _compare("approve", ok, ret, expected);
        if (ok && expected.length == 0) {
            mApproved[payee][provider] = approved;
            calls["approve"]++;
        } else {
            calls["approve_rej"]++;
        }
    }

    function _providerErr(uint256 id, address caller) internal view returns (bytes memory) {
        if (id == 0 || id > count) return abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, id);
        if (caller != m[id].provider) return abi.encodeWithSelector(UsdcPayPerRequest.NotProvider.selector);
        return "";
    }

    function setPrice(uint256 seed) external {
        uint256 id = _pickEndpoint(seed);
        address caller = _h(seed, "caller") % 5 == 0 ? outsider : (id >= 1 && id <= count ? m[id].provider : providers[0]);
        uint128 price = _price(_h(seed, "newprice"));
        bytes memory expected = _providerErr(id, caller);
        if (expected.length == 0 && price == 0) expected = abi.encodeWithSelector(UsdcPayPerRequest.InvalidPrice.selector);
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(c).call(abi.encodeCall(c.setPrice, (id, price)));
        _compare("setPrice", ok, ret, expected);
        if (ok && expected.length == 0) {
            m[id].price = price;
            calls["setPrice"]++;
        } else {
            calls["setPrice_rej"]++;
        }
    }

    function setActive(uint256 seed) external {
        bool active = _h(seed, "on") % 4 != 0; // mostly (re)activate, so payments keep flowing
        uint256 id = _pickEndpoint(seed);
        address caller = _h(seed, "caller") % 5 == 0 ? payeeA : (id >= 1 && id <= count ? m[id].provider : providers[1]);
        bytes memory expected = _providerErr(id, caller);
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(c).call(abi.encodeCall(c.setActive, (id, active)));
        _compare("setActive", ok, ret, expected);
        if (ok && expected.length == 0) {
            m[id].active = active;
            calls["setActive"]++;
        } else {
            calls["setActive_rej"]++;
        }
    }

    function _payExpected(uint256 id, bytes32 rid, address payer, uint256 amount, uint256 price)
        internal
        returns (bytes memory)
    {
        address bound = address(uint160(uint256(rid) >> 96));
        if (id == 0 || id > count) return abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, id);
        if (!m[id].active) return abi.encodeWithSelector(UsdcPayPerRequest.EndpointInactive.selector, id);
        if (rid == bytes32(0)) return abi.encodeWithSelector(UsdcPayPerRequest.ZeroRequestId.selector);
        if (bound != address(0) && bound != payer) {
            calls["rej_notForPayer"]++;
            return abi.encodeWithSelector(UsdcPayPerRequest.RequestNotForPayer.selector, bound);
        }
        if (pm[rid].payer != address(0)) {
            calls["rej_alreadyPaid"]++;
            return abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid);
        }
        if (amount != price) {
            calls["rej_wrongAmount"]++;
            return abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, amount, price);
        }
        return "";
    }

    function _recordPay(uint256 id, bytes32 rid, address payer, uint256 amount) internal {
        pm[rid] = P(payer, id, uint128(amount), false);
        ghostPays[rid]++;
        E storage e = m[id];
        e.paidCount++;
        e.totalPaid += uint128(amount);
        mCredit[e.payee] += amount;
        mPaid += amount;
    }

    struct PayCall {
        uint256 id;
        bytes32 rid;
        address payer;
        uint256 amount;
        uint256 price;
    }

    function _payArgs(uint256 seed) internal view returns (PayCall memory q) {
        q.id = _pickEndpoint(seed);
        q.rid = pool[_h(seed, "rid") % 33];
        uint256 ps = _h(seed, "payer") % 8;
        address bound = address(uint160(uint256(q.rid) >> 96));
        if (bound != address(0) && ps >= 2) q.payer = bound; // mostly the right payer
        else q.payer = ps % 4 == 3 ? outsider : payers[ps % 3];
        q.price = (q.id >= 1 && q.id <= count) ? m[q.id].price : 0;
        uint256 ak = _h(seed, "amount") % 8;
        q.amount = ak == 0 ? 0 : (ak == 6 ? q.price + 1 : (ak == 7 ? (q.price > 0 ? q.price - 1 : 1) : q.price));
    }

    function _send(PayCall memory q) internal returns (bool ok, bytes memory ret) {
        vm.prank(q.payer);
        (ok, ret) = address(c).call{value: q.amount}(abi.encodeCall(c.pay, (q.id, q.rid)));
    }

    function pay(uint256 seed) external {
        PayCall memory q = _payArgs(seed);
        bytes memory expected = _payExpected(q.id, q.rid, q.payer, q.amount, q.price);
        (bool okPre, uint8 reason) = c.canPay(q.id, q.rid, q.payer, q.amount);
        if (okPre != (expected.length == 0) || (okPre && reason != 0)) {
            mismatches++;
            lastMismatch = "canPay";
        }
        uint256 before = q.payer.balance;
        (bool ok, bytes memory ret) = _send(q);
        _compare("pay", ok, ret, expected);
        if (ok && expected.length == 0) {
            if (before - q.payer.balance != q.amount) badTransfers++;
            _recordPay(q.id, q.rid, q.payer, q.amount);
            calls["pay_ok"]++;
        } else {
            if (q.payer.balance != before) badTransfers++;
            calls["pay_rej"]++;
        }
    }

    function refund(uint256 seed) external {
        uint256 start = _h(seed, "rid") % 33;
        bytes32 rid = pool[start];
        if (_h(seed, "paidfirst") % 4 != 0) {
            for (uint256 i = 0; i < 33; i++) {
                bytes32 r = pool[(start + i) % 33];
                if (pm[r].payer != address(0)) {
                    rid = r;
                    break;
                }
            }
        }
        P storage p = pm[rid];
        address caller;
        if (_h(seed, "caller") % 4 == 0 || p.payer == address(0)) caller = [outsider, payeeA, providers[1]][seed % 3];
        else caller = m[p.endpointId].provider;
        bytes memory expected;
        if (p.payer == address(0)) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.UnknownPayment.selector, rid);
        } else if (caller != m[p.endpointId].provider) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.NotProvider.selector);
        } else if (p.refunded) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.AlreadyRefunded.selector, rid);
        } else if (p.amount > mCredit[m[p.endpointId].payee]) {
            expected = abi.encodeWithSelector(
                UsdcPayPerRequest.InsufficientCredit.selector, p.amount, mCredit[m[p.endpointId].payee]
            );
            calls["rej_insufficientCredit"]++;
        } else if (!_canReceive(p.payer)) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.TransferFailed.selector);
            calls["rej_transferFailed"]++;
        }
        address payer = p.payer;
        uint256 before = payer == address(0) ? 0 : payer.balance;
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(c).call(abi.encodeCall(c.refund, (rid)));
        _compare("refund", ok, ret, expected);
        if (ok && expected.length == 0) {
            if (payer.balance - before != p.amount) badTransfers++;
            p.refunded = true;
            ghostRefunds[rid]++;
            E storage e = m[p.endpointId];
            e.totalRefunded += p.amount;
            e.refundCount++;
            mCredit[e.payee] -= p.amount;
            mRefunded += p.amount;
            calls["refund_ok"]++;
        } else {
            if (payer != address(0) && payer.balance != before) badTransfers++;
            calls["refund_rej"]++;
        }
    }

    function withdraw(uint256 seed) external {
        uint256 as_ = _h(seed, "acct") % 6;
        address account = as_ == 5 ? outsider : creditHolders[as_];
        if (_h(seed, "rich") % 3 != 0) {
            for (uint256 i = 0; i < 5; i++) {
                if (mCredit[creditHolders[i]] > mCredit[account]) account = creditHolders[i];
            }
        }
        address[5] memory tos = [account, outsider, rejSink, address(0), address(c)];
        uint256 ts = _h(seed, "to") % 10;
        address to = tos[ts < 5 ? ts : (ts % 2 == 0 ? 0 : 1)];
        uint256 credit = mCredit[account];
        uint256 ak = _h(seed, "amt") % 6;
        uint256 amount = ak == 0 ? 0 : (ak == 1 ? credit + 1 : (ak == 2 ? credit / 2 : (ak == 3 ? 1 : credit)));
        bytes memory expected;
        if (to == address(0)) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.ZeroAddress.selector);
        } else if (amount == 0) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.ZeroAmount.selector);
        } else if (amount > credit) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.InsufficientCredit.selector, amount, credit);
            calls["rej_insufficientCredit"]++;
        } else if (!_canReceive(to)) {
            expected = abi.encodeWithSelector(UsdcPayPerRequest.TransferFailed.selector);
            calls["rej_transferFailed"]++;
        }
        uint256 before = to.balance;
        vm.prank(account);
        (bool ok, bytes memory ret) = address(c).call(abi.encodeCall(c.withdraw, (to, amount)));
        _compare("withdraw", ok, ret, expected);
        if (ok && expected.length == 0) {
            if (to.balance - before != amount) badTransfers++;
            mCredit[account] -= amount;
            mWithdrawn += amount;
            calls["withdraw_ok"]++;
        } else {
            if (to.balance != before) badTransfers++;
            calls["withdraw_rej"]++;
        }
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1, 3 days);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + 1 + secs / 2);
        calls["warp"]++;
    }

    // ------------------------------------------------------------------ views for the invariants
    function modelEndpoint(uint256 id) external view returns (E memory) {
        return m[id];
    }

    function modelPayment(bytes32 rid) external view returns (P memory) {
        return pm[rid];
    }

    function sumModelCredits() external view returns (uint256 s) {
        for (uint256 i = 0; i < 5; i++) s += mCredit[creditHolders[i]];
        s += mCredit[outsider];
    }

    function holders() external view returns (address[6] memory h) {
        for (uint256 i = 0; i < 5; i++) h[i] = creditHolders[i];
        h[5] = outsider;
    }

    function summary() external view {
        for (uint256 i = 0; i < callNames.length; i++) console.log(callNames[i], calls[callNames[i]]);
    }
}

contract UsdcPayPerRequestInvariants is StdInvariant, Test {
    UsdcPayPerRequest c;
    PaywallHandler h;

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.roll(100);
        c = new UsdcPayPerRequest();
        h = new PaywallHandler(c);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = PaywallHandler.register.selector;
        sel[1] = PaywallHandler.setPrice.selector;
        sel[2] = PaywallHandler.setActive.selector;
        sel[3] = PaywallHandler.pay.selector;
        sel[4] = PaywallHandler.refund.selector;
        sel[5] = PaywallHandler.withdraw.selector;
        sel[6] = PaywallHandler.warp.selector;
        sel[7] = PaywallHandler.approve.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// I0: every call succeeded or reverted with exactly the revert data the model predicted; canPay agreed.
    function invariant_matchesModel() public view {
        assertEq(h.mismatches(), 0, h.lastMismatch());
    }

    /// I1 solvency: contract balance == totalCredits == sum of every credit.
    function invariant_solvency() public view {
        assertEq(address(c).balance, c.totalCredits(), "balance == totalCredits");
        address[6] memory hs = h.holders();
        uint256 s;
        for (uint256 i = 0; i < 6; i++) {
            s += c.creditOf(hs[i]);
            assertEq(c.creditOf(hs[i]), h.mCredit(hs[i]), "credit == model");
        }
        assertEq(s, c.totalCredits(), "sum of credits == totalCredits");
        assertEq(h.sumModelCredits(), c.totalCredits(), "model credits == totalCredits");
    }

    /// I2 conservation: sum of credits + withdrawn == total paid - refunded (and every total matches the model).
    function invariant_conservation() public view {
        assertEq(c.totalCredits() + c.totalWithdrawn(), c.totalPaid() - c.totalRefunded(), "credits + withdrawn");
        assertEq(c.totalPaid(), h.mPaid());
        assertEq(c.totalRefunded(), h.mRefunded());
        assertEq(c.totalWithdrawn(), h.mWithdrawn());
    }

    /// I3: each requestId is paid at most once and refunded at most once; the stored payment matches the model.
    function invariant_requestIdsPaidAtMostOnce() public view {
        for (uint256 i = 0; i < 33; i++) {
            bytes32 rid = h.pool(i);
            assertLe(h.ghostPays(rid), 1, "paid at most once");
            assertLe(h.ghostRefunds(rid), h.ghostPays(rid), "refunded at most once, only if paid");
            assertEq(c.isPaid(rid), h.ghostPays(rid) == 1, "isPaid");
            UsdcPayPerRequest.Payment memory p = c.getPayment(rid);
            PaywallHandler.P memory q = h.modelPayment(rid);
            assertEq(p.payer, q.payer);
            assertEq(uint256(p.endpointId), q.endpointId);
            assertEq(p.amount, q.amount, "amount == price in force when paid");
            assertEq(p.refunded, q.refunded);
            if (p.payer != address(0)) {
                address bound = c.payerOf(rid);
                assertTrue(bound == address(0) || bound == p.payer, "bound requestIds are paid by their payer");
            }
        }
        assertEq(c.isPaid(bytes32(0)), false, "zero requestId never paid");
    }

    /// I4: per-endpoint accounting matches the model and sums to the global totals.
    function invariant_endpointAccounting() public view {
        uint256 n = c.endpointCount();
        assertEq(n, h.count());
        uint256 paid;
        uint256 refunded;
        for (uint256 id = 1; id <= n; id++) {
            UsdcPayPerRequest.Endpoint memory e = c.getEndpoint(id);
            PaywallHandler.E memory q = h.modelEndpoint(id);
            assertEq(e.provider, q.provider);
            assertEq(e.payee, q.payee);
            assertEq(e.price, q.price);
            assertEq(e.active, q.active);
            assertEq(e.paidCount, q.paidCount);
            assertEq(e.totalPaid, q.totalPaid);
            assertEq(e.totalRefunded, q.totalRefunded);
            assertEq(e.refundCount, q.refundCount);
            assertLe(e.totalRefunded, e.totalPaid);
            paid += e.totalPaid;
            refunded += e.totalRefunded;
        }
        assertEq(paid, c.totalPaid(), "sum of endpoint totals == totalPaid");
        address[6] memory hs = h.holders();
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = 3; j < 5; j++) {
                bool want = hs[i] == hs[j] || h.mApproved(hs[i], hs[j]);
                assertEq(c.isProviderApproved(hs[i], hs[j]), want, "consent view == model");
            }
        }
        assertEq(refunded, c.totalRefunded(), "sum of endpoint refunds == totalRefunded");
    }

    /// I5: every USDC movement had exactly the predicted size (payer charged the price, refunds and withdrawals exact,
    ///     nothing moved on a failed call).
    function invariant_exactTransfers() public view {
        assertEq(h.badTransfers(), 0, "balance deltas");
    }

    function afterInvariant() public view {
        h.summary();
    }
}
