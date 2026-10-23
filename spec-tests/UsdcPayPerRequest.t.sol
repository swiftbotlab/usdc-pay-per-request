// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcPayPerRequest} from "../src/UsdcPayPerRequest.sol";
import {RejectingReceiver, PayerAccount, ReentrantPayee, NoReceivePayee} from "./Helpers.sol";

/// @dev Spec tests for UsdcPayPerRequest (SPEC.md). Amounts are native USDC wei (18 decimals).
contract UsdcPayPerRequestTest is Test {
    UsdcPayPerRequest c;
    address provider = makeAddr("provider");
    address payee = makeAddr("payee");
    address agent = makeAddr("agent");
    address agent2 = makeAddr("agent2");
    address outsider = makeAddr("outsider");
    uint128 constant PRICE = 0.01e18;

    event EndpointRegistered(
        uint256 indexed id, address indexed provider, address indexed payee, uint256 price, string name
    );
    event PriceChanged(uint256 indexed id, uint256 oldPrice, uint256 newPrice);
    event ActiveSet(uint256 indexed id, bool active);
    event Paid(
        uint256 indexed endpointId, bytes32 indexed requestId, address indexed payer, address payee, uint256 amount
    );
    event Refunded(uint256 indexed endpointId, bytes32 indexed requestId, address indexed payer, uint256 amount);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event ProviderApproval(address indexed payee, address indexed provider, bool approved);

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.roll(1_000);
        c = new UsdcPayPerRequest();
        vm.deal(agent, 10 ether);
        vm.deal(agent2, 10 ether);
        vm.deal(outsider, 10 ether);
        vm.deal(provider, 1 ether);
        vm.prank(payee); // the payee consents to endpoints registered by `provider`
        c.approveProvider(provider, true);
    }

    // ------------------------------------------------------------------ helpers
    function _register(uint128 price) internal returns (uint256 id) {
        vm.prank(provider);
        id = c.registerEndpoint(price, payee, "GET /v1/weather");
    }

    function _rid(address payer, string memory tag) internal view returns (bytes32) {
        return c.requestIdFor(payer, keccak256(bytes(tag)));
    }

    function _pay(address payer, uint256 id, bytes32 rid, uint256 value) internal {
        vm.prank(payer);
        c.pay{value: value}(id, rid);
    }

    function _accounting() internal view {
        assertEq(address(c).balance, c.totalCredits(), "balance == totalCredits");
        assertEq(c.totalCredits() + c.totalWithdrawn(), c.totalPaid() - c.totalRefunded(), "conservation");
    }

    // ------------------------------------------------------------------ registerEndpoint
    function test_register_storesEndpoint() public {
        vm.expectEmit(true, true, true, true, address(c));
        emit EndpointRegistered(1, provider, payee, PRICE, "GET /v1/weather");
        uint256 id = _register(PRICE);
        assertEq(id, 1);
        assertEq(c.endpointCount(), 1);
        UsdcPayPerRequest.Endpoint memory e = c.getEndpoint(id);
        assertEq(e.provider, provider);
        assertTrue(e.active);
        assertEq(e.createdAt, block.timestamp);
        assertEq(e.payee, payee);
        assertEq(e.paidCount, 0);
        assertEq(e.price, PRICE);
        assertEq(e.totalPaid, 0);
        assertEq(e.totalRefunded, 0);
        assertEq(e.refundCount, 0);
        assertEq(c.nameOf(id), "GET /v1/weather");
    }

    function test_register_idsIncrementAndIndexByProvider() public {
        uint256 a = _register(PRICE);
        vm.prank(outsider);
        uint256 b = c.registerEndpoint(1, outsider, "other provider");
        uint256 d = _register(2 * PRICE);
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(d, 3);
        uint256[] memory mine = c.endpointsOf(provider);
        assertEq(mine.length, 2);
        assertEq(mine[0], 1);
        assertEq(mine[1], 3);
        assertEq(c.endpointsOf(outsider).length, 1);
        assertEq(c.endpointsOf(agent).length, 0);
    }

    function test_register_rejectsBadInput() public {
        vm.startPrank(provider);
        vm.expectRevert(UsdcPayPerRequest.ZeroAddress.selector);
        c.registerEndpoint(PRICE, address(0), "x");
        vm.expectRevert(UsdcPayPerRequest.InvalidPayee.selector);
        c.registerEndpoint(PRICE, address(c), "x");
        vm.expectRevert(UsdcPayPerRequest.InvalidPrice.selector);
        c.registerEndpoint(0, payee, "x");
        vm.expectRevert(UsdcPayPerRequest.InvalidName.selector);
        c.registerEndpoint(PRICE, payee, "");
        string memory n65 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        assertEq(bytes(n65).length, 65);
        vm.expectRevert(UsdcPayPerRequest.InvalidName.selector);
        c.registerEndpoint(PRICE, payee, n65);
        string memory n64 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        uint256 id = c.registerEndpoint(PRICE, payee, n64); // exactly 64 bytes is fine
        vm.stopPrank();
        assertEq(c.nameOf(id), n64);
        assertEq(c.endpointCount(), 1);
    }

    function test_register_checkOrder() public {
        vm.startPrank(provider);
        vm.expectRevert(UsdcPayPerRequest.ZeroAddress.selector); // payee first
        c.registerEndpoint(0, address(0), "");
        vm.expectRevert(UsdcPayPerRequest.InvalidPayee.selector);
        c.registerEndpoint(0, address(c), "");
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.PayeeNotApproved.selector, agent)); // then consent
        c.registerEndpoint(0, agent, "");
        vm.expectRevert(UsdcPayPerRequest.InvalidPrice.selector); // then price
        c.registerEndpoint(0, payee, "");
        vm.stopPrank();
    }

    function test_register_payeeMustConsent() public {
        // nobody can attach a stranger's address as payee (and later refund out of the stranger's credit)
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.PayeeNotApproved.selector, agent2));
        vm.prank(outsider);
        c.registerEndpoint(PRICE, agent2, "griefing attempt");
        assertFalse(c.isProviderApproved(agent2, outsider));
        assertTrue(c.isProviderApproved(outsider, outsider), "a provider may always pay itself");
        vm.expectEmit(true, true, false, true, address(c));
        emit ProviderApproval(agent2, outsider, true);
        vm.prank(agent2);
        c.approveProvider(outsider, true);
        assertTrue(c.isProviderApproved(agent2, outsider));
        vm.prank(outsider);
        uint256 id = c.registerEndpoint(PRICE, agent2, "approved");
        // revoking stops NEW endpoints only; the existing one keeps paying agent2
        vm.prank(agent2);
        c.approveProvider(outsider, false);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.PayeeNotApproved.selector, agent2));
        vm.prank(outsider);
        c.registerEndpoint(PRICE, agent2, "after revoke");
        _pay(agent, id, _rid(agent, "x"), PRICE);
        assertEq(c.creditOf(agent2), PRICE);
        vm.expectRevert(UsdcPayPerRequest.ZeroAddress.selector);
        vm.prank(agent2);
        c.approveProvider(address(0), true);
    }

    function test_register_maxPrice() public {
        vm.prank(provider);
        uint256 id = c.registerEndpoint(type(uint128).max, payee, "expensive");
        assertEq(c.getEndpoint(id).price, type(uint128).max);
    }

    // ------------------------------------------------------------------ setPrice / setActive
    function test_setPrice_onlyProviderKnownNonZero() public {
        uint256 id = _register(PRICE);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 0));
        vm.prank(provider);
        c.setPrice(0, PRICE);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 2));
        vm.prank(provider);
        c.setPrice(2, PRICE);
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        vm.prank(payee); // the payee is not the provider
        c.setPrice(id, PRICE);
        vm.expectRevert(UsdcPayPerRequest.InvalidPrice.selector);
        vm.prank(provider);
        c.setPrice(id, 0);
        vm.expectEmit(true, false, false, true, address(c));
        emit PriceChanged(id, PRICE, 3 * PRICE);
        vm.prank(provider);
        c.setPrice(id, 3 * PRICE);
        assertEq(c.getEndpoint(id).price, 3 * PRICE);
        vm.expectEmit(true, false, false, true, address(c)); // same value: allowed, still emits
        emit PriceChanged(id, 3 * PRICE, 3 * PRICE);
        vm.prank(provider);
        c.setPrice(id, 3 * PRICE);
    }

    function test_setPrice_appliesToNewPaymentsOnly() public {
        uint256 id = _register(PRICE);
        bytes32 r1 = _rid(agent, "r1");
        bytes32 r2 = _rid(agent, "r2");
        _pay(agent, id, r1, PRICE);
        vm.prank(provider);
        c.setPrice(id, 2 * PRICE);
        // a client holding the old quote is refused, never charged a different amount
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, PRICE, 2 * PRICE));
        _pay(agent, id, r2, PRICE);
        _pay(agent, id, r2, 2 * PRICE);
        assertEq(c.getPayment(r1).amount, PRICE, "old payment keeps its amount");
        assertEq(c.getPayment(r2).amount, 2 * PRICE);
        assertEq(c.creditOf(payee), 3 * PRICE);
        // a refund returns what was paid, not the current price
        uint256 before = agent.balance;
        vm.prank(provider);
        c.refund(r1);
        assertEq(agent.balance - before, PRICE);
        _accounting();
    }

    function test_setActive_pausesNewPaymentsOnly() public {
        uint256 id = _register(PRICE);
        bytes32 r1 = _rid(agent, "r1");
        bytes32 r2 = _rid(agent, "r2");
        _pay(agent, id, r1, PRICE);
        _pay(agent, id, r2, PRICE);
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        vm.prank(outsider);
        c.setActive(id, false);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 9));
        vm.prank(provider);
        c.setActive(9, false);
        vm.expectEmit(true, false, false, true, address(c));
        emit ActiveSet(id, false);
        vm.prank(provider);
        c.setActive(id, false);
        assertFalse(c.getEndpoint(id).active);
        bytes32 r3 = _rid(agent, "r3");
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.EndpointInactive.selector, id));
        _pay(agent, id, r3, PRICE);
        // refunds and withdrawals still work while inactive
        vm.prank(provider);
        c.refund(r1);
        vm.prank(payee);
        c.withdraw(payee, PRICE);
        assertEq(c.creditOf(payee), 0);
        vm.prank(provider);
        c.setActive(id, true);
        _pay(agent, id, r3, PRICE);
        assertEq(c.getEndpoint(id).paidCount, 3);
        _accounting();
    }

    // ------------------------------------------------------------------ pay
    function test_pay_creditsPayeeAndRecords() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "GET /v1/weather?city=Paris");
        vm.roll(1_234);
        vm.warp(1_760_000_100);
        vm.expectEmit(true, true, true, true, address(c));
        emit Paid(id, rid, agent, payee, PRICE);
        _pay(agent, id, rid, PRICE);
        UsdcPayPerRequest.Payment memory p = c.getPayment(rid);
        assertEq(p.payer, agent);
        assertEq(p.endpointId, id);
        assertFalse(p.refunded);
        assertEq(p.amount, PRICE);
        assertEq(p.paidAt, 1_760_000_100);
        assertEq(p.paidBlock, 1_234);
        assertTrue(c.isPaid(rid));
        assertEq(c.creditOf(payee), PRICE);
        assertEq(c.totalPaid(), PRICE);
        assertEq(c.totalCredits(), PRICE);
        assertEq(address(c).balance, PRICE);
        assertEq(payee.balance, 0, "pull model: nothing is pushed to the payee");
        UsdcPayPerRequest.Endpoint memory e = c.getEndpoint(id);
        assertEq(e.paidCount, 1);
        assertEq(e.totalPaid, PRICE);
        _accounting();
    }

    function test_pay_unknownEndpoint() public {
        _register(PRICE);
        bytes32 rid = _rid(agent, "x"); // computed first: _rid is an external call and would eat expectRevert
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 0));
        _pay(agent, 0, rid, PRICE);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 2));
        _pay(agent, 2, rid, PRICE);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, type(uint256).max));
        _pay(agent, type(uint256).max, rid, PRICE);
    }

    function test_pay_zeroRequestId() public {
        uint256 id = _register(PRICE);
        vm.expectRevert(UsdcPayPerRequest.ZeroRequestId.selector);
        _pay(agent, id, bytes32(0), PRICE);
    }

    function test_pay_boundToOtherPayer() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "mine");
        assertEq(c.payerOf(rid), agent);
        // a front-runner copying the agent's requestId from the mempool cannot pay (and so cannot burn) it
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.RequestNotForPayer.selector, agent));
        _pay(outsider, id, rid, PRICE);
        _pay(agent, id, rid, PRICE);
        assertEq(c.getPayment(rid).payer, agent);
    }

    function test_pay_unboundAnyoneCanPayOnce() public {
        uint256 id = _register(PRICE);
        bytes32 rid = c.requestIdFor(address(0), keccak256("open"));
        assertEq(c.payerOf(rid), address(0));
        assertTrue(rid != bytes32(0));
        _pay(outsider, id, rid, PRICE);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid));
        _pay(agent, id, rid, PRICE);
        assertEq(c.getPayment(rid).payer, outsider);
    }

    function test_pay_alreadyPaidAcrossEndpoints() public {
        uint256 a = _register(PRICE);
        uint256 b = _register(PRICE);
        bytes32 rid = _rid(agent, "once");
        _pay(agent, a, rid, PRICE);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid));
        _pay(agent, a, rid, PRICE); // a retried payment never charges twice
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid));
        _pay(agent, b, rid, PRICE); // requestIds are global, not per endpoint
        assertEq(c.totalPaid(), PRICE);
        assertEq(c.getEndpoint(b).paidCount, 0);
    }

    function test_pay_wrongAmount() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "amount");
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, PRICE - 1, PRICE));
        _pay(agent, id, rid, PRICE - 1);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, PRICE + 1, PRICE));
        _pay(agent, id, rid, PRICE + 1);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, 0, PRICE));
        _pay(agent, id, rid, 0);
        assertFalse(c.isPaid(rid), "a failed payment does not use up the requestId");
        _pay(agent, id, rid, PRICE);
    }

    function test_pay_checkOrder() public {
        uint256 id = _register(PRICE);
        bytes32 paidRid = _rid(agent, "paid");
        _pay(agent, id, paidRid, PRICE);
        bytes32 foreign = _rid(agent2, "foreign");
        // unknown endpoint beats everything
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 7));
        _pay(agent, 7, bytes32(0), 0);
        vm.prank(provider);
        c.setActive(id, false);
        // inactive beats zero id / binding / already paid / amount
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.EndpointInactive.selector, id));
        _pay(agent, id, bytes32(0), 0);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.EndpointInactive.selector, id));
        _pay(agent, id, paidRid, PRICE);
        vm.prank(provider);
        c.setActive(id, true);
        vm.expectRevert(UsdcPayPerRequest.ZeroRequestId.selector);
        _pay(agent, id, bytes32(0), 0);
        // binding beats already-paid and amount
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.RequestNotForPayer.selector, agent));
        _pay(agent2, id, paidRid, 0);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.RequestNotForPayer.selector, agent2));
        _pay(agent, id, foreign, 0);
        // already-paid beats amount (a retry with a stale price still says "already paid")
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, paidRid));
        _pay(agent, id, paidRid, 0);
    }

    function test_pay_refundedRequestStaysUsed() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "refund-me");
        _pay(agent, id, rid, PRICE);
        vm.prank(provider);
        c.refund(rid);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid));
        _pay(agent, id, rid, PRICE);
        assertTrue(c.isPaid(rid));
        assertTrue(c.getPayment(rid).refunded);
    }

    function test_pay_selfPayAndMultiEndpointCreditsAggregate() public {
        uint256 a = _register(PRICE);
        vm.prank(payee);
        c.approveProvider(outsider, true);
        vm.prank(outsider);
        uint256 b = c.registerEndpoint(3 * PRICE, payee, "same payee, other provider");
        _pay(agent, a, _rid(agent, "1"), PRICE);
        _pay(agent2, b, _rid(agent2, "2"), 3 * PRICE);
        vm.deal(payee, 1 ether);
        _pay(payee, a, _rid(payee, "self"), PRICE); // the payee may pay its own endpoint
        assertEq(c.creditOf(payee), 5 * PRICE);
        _accounting();
    }

    function test_pay_fromSmartAccount() public {
        uint256 id = _register(PRICE);
        PayerAccount acct = new PayerAccount(c);
        vm.deal(address(acct), 1 ether);
        bytes32 rid = c.requestIdFor(address(acct), keccak256("sa"));
        vm.prank(outsider);
        acct.pay{value: PRICE}(id, rid);
        assertEq(c.getPayment(rid).payer, address(acct));
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.RequestNotForPayer.selector, address(acct)));
        _pay(outsider, id, rid, PRICE);
    }

    function test_noReceiveOrFallback() public {
        vm.prank(agent);
        (bool ok,) = address(c).call{value: 1}("");
        assertFalse(ok, "plain transfer must fail");
        vm.prank(agent);
        (ok,) = address(c).call{value: 1}(hex"deadbeef");
        assertFalse(ok, "unknown selector must fail");
        assertEq(address(c).balance, 0);
    }

    // ------------------------------------------------------------------ canPay
    function test_canPay_reportsEachReason() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "ok");
        _expectReason(id, rid, agent, PRICE, 0);
        _expectReason(0, rid, agent, PRICE, 1);
        _expectReason(id, bytes32(0), agent, PRICE, 3);
        _expectReason(id, rid, agent2, PRICE, 4);
        _expectReason(id, rid, agent, PRICE + 1, 6);
        _pay(agent, id, rid, PRICE);
        _expectReason(id, rid, agent, PRICE, 5);
        vm.prank(provider);
        c.setActive(id, false);
        _expectReason(id, _rid(agent, "new"), agent, PRICE, 2);
    }

    function _expectReason(uint256 id, bytes32 rid, address payer, uint256 amount, uint8 want) internal view {
        (bool ok, uint8 reason) = c.canPay(id, rid, payer, amount);
        assertEq(reason, want, "reason");
        assertEq(ok, want == 0, "ok flag");
    }

    // ------------------------------------------------------------------ refund
    function test_refund_happyPath() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "upstream failed");
        _pay(agent, id, rid, PRICE);
        _pay(agent, id, _rid(agent, "kept"), PRICE);
        uint256 before = agent.balance;
        vm.expectEmit(true, true, true, true, address(c));
        emit Refunded(id, rid, agent, PRICE);
        vm.prank(provider);
        c.refund(rid);
        assertEq(agent.balance - before, PRICE, "payer gets exactly the amount back");
        assertTrue(c.getPayment(rid).refunded);
        assertEq(c.creditOf(payee), PRICE);
        assertEq(c.totalRefunded(), PRICE);
        UsdcPayPerRequest.Endpoint memory e = c.getEndpoint(id);
        assertEq(e.totalRefunded, PRICE);
        assertEq(e.refundCount, 1);
        assertEq(e.paidCount, 2);
        assertEq(e.totalPaid, 2 * PRICE);
        _accounting();
    }

    function test_refund_onlyProvider() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "r");
        _pay(agent, id, rid, PRICE);
        address[3] memory notAllowed = [payee, agent, outsider];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
            vm.prank(notAllowed[i]);
            c.refund(rid);
        }
    }

    function test_refund_unknownAndTwice() public {
        uint256 id = _register(PRICE);
        bytes32 rid = _rid(agent, "r");
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.UnknownPayment.selector, rid));
        vm.prank(provider);
        c.refund(rid);
        _pay(agent, id, rid, PRICE);
        vm.prank(provider);
        c.refund(rid);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.AlreadyRefunded.selector, rid));
        vm.prank(provider);
        c.refund(rid);
        // order: unknown payment, then provider, then already refunded
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        vm.prank(outsider);
        c.refund(rid);
    }

    function test_refund_comesOutOfUnwithdrawnCredit() public {
        uint256 id = _register(PRICE);
        bytes32 r1 = _rid(agent, "r1");
        bytes32 r2 = _rid(agent, "r2");
        _pay(agent, id, r1, PRICE);
        _pay(agent, id, r2, PRICE);
        vm.prank(payee);
        c.withdraw(payee, 2 * PRICE - 1);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.InsufficientCredit.selector, PRICE, 1));
        vm.prank(provider);
        c.refund(r1);
        assertFalse(c.getPayment(r1).refunded);
        _accounting();
    }

    function test_refund_rejectingPayerChangesNothing() public {
        uint256 id = _register(PRICE);
        PayerAccount acct = new PayerAccount(c);
        vm.deal(address(acct), 1 ether);
        bytes32 rid = c.requestIdFor(address(acct), keccak256("x"));
        acct.pay{value: PRICE}(id, rid);
        acct.setMode(1);
        vm.expectRevert(UsdcPayPerRequest.TransferFailed.selector);
        vm.prank(provider);
        c.refund(rid);
        assertFalse(c.getPayment(rid).refunded);
        assertEq(c.creditOf(payee), PRICE);
        assertEq(c.totalRefunded(), 0);
        _accounting();
    }

    function test_refund_reentrancyIsBlocked() public {
        uint256 id = _register(PRICE);
        PayerAccount acct = new PayerAccount(c);
        vm.deal(address(acct), 1 ether);
        bytes32 rid = c.requestIdFor(address(acct), keccak256("re"));
        acct.pay{value: PRICE}(id, rid);
        // bubble: the inner refund hits the guard, so the payout fails and the whole refund reverts
        acct.setMode(2);
        vm.expectRevert(UsdcPayPerRequest.TransferFailed.selector);
        vm.prank(provider);
        c.refund(rid);
        // a payer that re-enters pay() while being refunded: same
        acct.setMode(4);
        vm.expectRevert(UsdcPayPerRequest.TransferFailed.selector);
        vm.prank(provider);
        c.refund(rid);
        // swallow: the refund goes through exactly once
        acct.setMode(3);
        vm.prank(provider);
        c.refund(rid);
        assertTrue(acct.innerFailed());
        assertEq(acct.received(), PRICE);
        assertEq(c.totalRefunded(), PRICE);
        _accounting();
    }

    // ------------------------------------------------------------------ withdraw
    function test_withdraw_partialAndFull() public {
        uint256 id = _register(PRICE);
        _pay(agent, id, _rid(agent, "1"), PRICE);
        _pay(agent2, id, _rid(agent2, "2"), PRICE);
        vm.expectEmit(true, true, false, true, address(c));
        emit Withdrawn(payee, payee, PRICE / 2);
        vm.prank(payee);
        c.withdraw(payee, PRICE / 2);
        assertEq(payee.balance, PRICE / 2);
        assertEq(c.creditOf(payee), 2 * PRICE - PRICE / 2);
        vm.prank(payee);
        c.withdraw(outsider, 2 * PRICE - PRICE / 2); // to any address
        assertEq(outsider.balance, 10 ether + 2 * PRICE - PRICE / 2);
        assertEq(c.creditOf(payee), 0);
        assertEq(c.totalWithdrawn(), 2 * PRICE);
        assertEq(address(c).balance, 0);
        _accounting();
    }

    function test_withdraw_errors() public {
        uint256 id = _register(PRICE);
        _pay(agent, id, _rid(agent, "1"), PRICE);
        vm.startPrank(payee);
        vm.expectRevert(UsdcPayPerRequest.ZeroAddress.selector);
        c.withdraw(address(0), 1);
        vm.expectRevert(UsdcPayPerRequest.ZeroAmount.selector);
        c.withdraw(payee, 0);
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.InsufficientCredit.selector, PRICE + 1, PRICE));
        c.withdraw(payee, PRICE + 1);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.InsufficientCredit.selector, 1, 0));
        vm.prank(provider); // the provider is not the payee: it has no credit
        c.withdraw(provider, 1);
        vm.expectRevert(UsdcPayPerRequest.TransferFailed.selector);
        vm.prank(payee);
        c.withdraw(address(c), 1); // the contract cannot receive
    }

    function test_withdraw_toRejectingAddressChangesNothing() public {
        uint256 id = _register(PRICE);
        _pay(agent, id, _rid(agent, "1"), PRICE);
        RejectingReceiver r = new RejectingReceiver();
        vm.expectRevert(UsdcPayPerRequest.TransferFailed.selector);
        vm.prank(payee);
        c.withdraw(address(r), PRICE);
        assertEq(c.creditOf(payee), PRICE);
        assertEq(c.totalWithdrawn(), 0);
        _accounting();
    }

    function test_withdraw_payeeThatCannotReceiveWithdrawsElsewhere() public {
        NoReceivePayee cold = new NoReceivePayee(c);
        vm.prank(address(cold)); // the payee contract consents (any contract can make this call)
        c.approveProvider(provider, true);
        vm.prank(provider);
        uint256 id = c.registerEndpoint(PRICE, address(cold), "cold payee");
        _pay(agent, id, _rid(agent, "1"), PRICE); // pull model: paying never touches the payee
        assertEq(c.creditOf(address(cold)), PRICE);
        cold.pull(outsider, PRICE);
        assertEq(c.creditOf(address(cold)), 0);
        assertEq(outsider.balance, 10 ether + PRICE);
    }

    function test_withdraw_reentrancyIsBlocked() public {
        ReentrantPayee rp = new ReentrantPayee(c);
        vm.prank(address(rp));
        c.approveProvider(provider, true);
        vm.prank(provider);
        uint256 id = c.registerEndpoint(PRICE, address(rp), "reentrant payee");
        _pay(agent, id, _rid(agent, "1"), PRICE);
        _pay(agent, id, _rid(agent, "2"), PRICE);
        rp.arm(false); // bubble
        vm.expectRevert(UsdcPayPerRequest.TransferFailed.selector);
        rp.withdrawAll();
        assertEq(c.creditOf(address(rp)), 2 * PRICE);
        rp.arm(true); // swallow: only the outer half goes out
        rp.withdrawAll();
        assertTrue(rp.innerFailed());
        assertEq(rp.received(), PRICE);
        assertEq(c.creditOf(address(rp)), PRICE);
        _accounting();
    }

    // ------------------------------------------------------------------ views
    function test_views_unknownIdsReturnZeros() public view {
        UsdcPayPerRequest.Endpoint memory e = c.getEndpoint(42);
        assertEq(e.provider, address(0));
        assertEq(e.price, 0);
        assertFalse(e.active);
        assertEq(bytes(c.nameOf(42)).length, 0);
        UsdcPayPerRequest.Payment memory p = c.getPayment(keccak256("nope"));
        assertEq(p.payer, address(0));
        assertEq(p.amount, 0);
        assertFalse(c.isPaid(keccak256("nope")));
        assertEq(c.creditOf(agent), 0);
        assertEq(c.endpointsOf(agent).length, 0);
        (bool ok, uint8 reason) = c.canPay(42, keccak256("nope"), agent, 1);
        assertFalse(ok);
        assertEq(reason, 1);
        assertEq(c.MAX_NAME(), 64);
    }

    /// Cross-language vector: the same numbers are checked by verifier/test (JS) and ops/test_ops.py (Python).
    function test_requestIdFor_offchainVector() public view {
        bytes32 domain = keccak256("arc-paywall/v1");
        assertEq(domain, 0xa9be0759f3319b8086d2aab6359727ab7c6040ca65e834246e87d5bdfaae3770);
        address payer = 0x2222222222222222222222222222222222222222;
        bytes32 resourceHash = keccak256("GET /v1/weather?city=Paris");
        bytes32 token = 0x3333333333333333333333333333333333333333333333333333333333333333;
        bytes32 digest = keccak256(
            abi.encode(domain, uint256(5042), address(0x1111111111111111111111111111111111111111), uint256(1), payer,
                resourceHash, token)
        );
        assertEq(digest, 0xf7bbb6442ebdcb04aed15aae4fedb9149c0675c791fd801985e2bd8a9a5903dd);
        assertEq(c.requestIdFor(payer, digest), 0x222222222222222222222222222222222222222291fd801985e2bd8a9a5903dd);
        assertEq(c.payerOf(0x222222222222222222222222222222222222222291fd801985e2bd8a9a5903dd), payer);
    }

    // ------------------------------------------------------------------ fuzz
    function testFuzz_requestIdForRoundTrip(address payer, bytes32 digest) public view {
        bytes32 rid = c.requestIdFor(payer, digest);
        assertEq(c.payerOf(rid), payer);
        assertEq(uint256(rid) & type(uint96).max, uint256(digest) & type(uint96).max);
    }

    function testFuzz_payNeedsExactlyThePrice(uint128 price, uint256 sent) public {
        price = uint128(bound(price, 1, 1_000 ether));
        sent = bound(sent, 0, 2_000 ether);
        vm.prank(provider);
        uint256 id = c.registerEndpoint(price, payee, "fuzz");
        bytes32 rid = _rid(agent, "fuzz");
        vm.deal(agent, sent);
        if (sent != price) {
            vm.expectRevert(abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, sent, price));
        }
        _pay(agent, id, rid, sent);
        assertEq(c.creditOf(payee), sent == price ? price : 0);
        _accounting();
    }

    function testFuzz_canPayAgreesWithPay(uint8 endpointSel, uint8 ridSel, uint8 payerSel, uint8 amountSel, bool inactive)
        public
    {
        uint256 id = _register(PRICE);
        bytes32 used = _rid(agent, "used");
        _pay(agent, id, used, PRICE);
        if (inactive) {
            vm.prank(provider);
            c.setActive(id, false);
        }
        uint256 eid = endpointSel % 3 == 0 ? 0 : (endpointSel % 3 == 1 ? id : id + 1);
        bytes32[4] memory rids =
            [bytes32(0), used, _rid(agent, "fresh"), c.requestIdFor(address(0), keccak256("open"))];
        bytes32 rid = rids[ridSel % 4];
        address payer = payerSel % 2 == 0 ? agent : agent2;
        uint256[3] memory amounts = [uint256(0), uint256(PRICE), uint256(PRICE) + 1];
        uint256 amount = amounts[amountSel % 3];
        (bool ok, uint8 reason) = c.canPay(eid, rid, payer, amount);
        vm.prank(payer);
        (bool success, bytes memory ret) = address(c).call{value: amount}(abi.encodeCall(c.pay, (eid, rid)));
        assertEq(success, ok, "canPay ok == pay success");
        if (!success) {
            bytes4 sel = bytes4(ret);
            bytes4[7] memory want = [
                bytes4(0),
                UsdcPayPerRequest.UnknownEndpoint.selector,
                UsdcPayPerRequest.EndpointInactive.selector,
                UsdcPayPerRequest.ZeroRequestId.selector,
                UsdcPayPerRequest.RequestNotForPayer.selector,
                UsdcPayPerRequest.AlreadyPaid.selector,
                UsdcPayPerRequest.WrongAmount.selector
            ];
            assertEq(sel, want[reason], "revert selector matches the canPay reason");
        } else {
            assertEq(reason, 0);
        }
    }
}
