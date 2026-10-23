// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcPayPerRequest} from "../UsdcPayPerRequest.sol";
import {RejectingReceiver, ReentrantPayReceiver} from "../test-helpers/PaywallHelpers.sol";

contract UsdcPayPerRequestRefundTest is Test {
    UsdcPayPerRequest internal uwpr;

    address internal provider = address(1);
    address internal payer    = address(2);
    address internal payee    = address(3);

    uint128 internal constant PRICE = 1 ether;
    string  internal constant NAME  = "refund-api";

    uint256 internal epId;

    /// @dev Returns an unbound requestId (top 20 bytes == 0).
    function _unboundRid(uint256 nonce) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(nonce))) & type(uint96).max) | bytes32(uint256(1));
    }

    function setUp() public {
        uwpr = new UsdcPayPerRequest();
        vm.deal(provider, 100 ether);
        vm.deal(payer,    100 ether);
        vm.deal(payee,    100 ether);

        vm.prank(payee);
        epId = uwpr.registerEndpoint(PRICE, payee, NAME);
    }

    function _pay(bytes32 rid) internal {
        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);
    }

    // ─────────────────────────────────────────────
    // refund — happy path
    // ─────────────────────────────────────────────

    function test_Refund_HappyPath() public {
        bytes32 rid = _unboundRid(1);
        _pay(rid);

        uint256 payerBefore = payer.balance;

        vm.prank(payee); // payee == provider here
        vm.expectEmit(true, true, true, true, address(uwpr));
        emit UsdcPayPerRequest.Refunded(epId, rid, payer, PRICE);
        uwpr.refund(rid);

        // Payment marked refunded
        UsdcPayPerRequest.Payment memory p = uwpr.getPayment(rid);
        assertTrue(p.refunded, "refunded flag");

        // Endpoint counters
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(epId);
        assertEq(ep.totalRefunded, PRICE, "ep.totalRefunded");
        assertEq(ep.refundCount,   1,     "ep.refundCount");

        // Global accounting
        assertEq(uwpr.credit(payee),      0,     "credit[payee]");
        assertEq(uwpr.totalCredits(),      0,     "totalCredits");
        assertEq(uwpr.totalRefunded(),     PRICE, "totalRefunded");

        // Payer got ETH back
        assertEq(payer.balance, payerBefore + PRICE, "payer balance restored");
    }

    function test_Refund_OriginalAmountNotCurrentPrice() public {
        bytes32 rid = _unboundRid(2);
        _pay(rid); // paid at PRICE

        // Change price after payment
        uint128 newPrice = 5 ether;
        vm.prank(payee);
        uwpr.setPrice(epId, newPrice);

        uint256 payerBefore = payer.balance;
        vm.prank(payee);
        uwpr.refund(rid);

        // Payer gets back original PRICE, not newPrice
        assertEq(payer.balance, payerBefore + PRICE);
        assertEq(uwpr.totalRefunded(), PRICE);
    }

    // ─────────────────────────────────────────────
    // refund — revert paths
    // ─────────────────────────────────────────────

    function test_Refund_RevertUnknownPayment() public {
        bytes32 rid = _unboundRid(10);
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.UnknownPayment.selector, rid)
        );
        uwpr.refund(rid);
    }

    function test_Refund_RevertNotProvider_Payee() public {
        bytes32 rid = _unboundRid(11);
        _pay(rid);

        // register a second endpoint so payee is different from provider
        address payee2  = address(10);
        address prov2   = address(11);
        vm.deal(payee2, 10 ether);
        vm.deal(prov2,  10 ether);
        vm.prank(payee2);
        uwpr.approveProvider(prov2, true);
        vm.prank(prov2);
        uint256 epId2 = uwpr.registerEndpoint(PRICE, payee2, "ep2");
        // ep2's provider is prov2; they cannot refund epId's payment
        vm.prank(prov2);
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        uwpr.refund(rid);
        assertGt(epId2, epId); // suppress warning; just assert the new ep has a higher id
    }

    function test_Refund_RevertNotProvider_Payer() public {
        bytes32 rid = _unboundRid(12);
        _pay(rid);

        vm.prank(payer);
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        uwpr.refund(rid);
    }

    function test_Refund_RevertNotProvider_Outsider() public {
        bytes32 rid = _unboundRid(13);
        _pay(rid);

        vm.prank(address(99));
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        uwpr.refund(rid);
    }

    function test_Refund_RevertAlreadyRefunded() public {
        bytes32 rid = _unboundRid(14);
        _pay(rid);

        vm.prank(payee);
        uwpr.refund(rid);

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.AlreadyRefunded.selector, rid)
        );
        uwpr.refund(rid);
    }

    function test_Refund_RevertInsufficientCredit() public {
        bytes32 rid = _unboundRid(15);
        _pay(rid);

        // Payee withdraws all credit
        vm.prank(payee);
        uwpr.withdraw(payee, PRICE);
        assertEq(uwpr.credit(payee), 0);

        // Now provider tries to refund — credit is 0 < PRICE
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.InsufficientCredit.selector, PRICE, 0)
        );
        uwpr.refund(rid);
    }

    // ─────────────────────────────────────────────
    // refund with RejectingReceiver as payer
    // ─────────────────────────────────────────────

    function test_Refund_RejectsTransferFailed() public {
        RejectingReceiver rejecter = new RejectingReceiver();
        vm.deal(address(rejecter), 100 ether);

        bytes32 rid = _unboundRid(20);
        // pay from rejecter's perspective — use call since it has no fallback
        vm.prank(address(rejecter));
        uwpr.pay{value: PRICE}(epId, rid);

        // snapshot state
        uint256 creditBefore   = uwpr.credit(payee);
        uint256 tRefBefore     = uwpr.totalRefunded();

        vm.prank(payee);
        vm.expectRevert(UsdcPayPerRequest.TransferFailed.selector);
        uwpr.refund(rid);

        // State unchanged after revert
        UsdcPayPerRequest.Payment memory p = uwpr.getPayment(rid);
        assertFalse(p.refunded,                       "refunded still false");
        assertEq(uwpr.credit(payee), creditBefore,    "credit unchanged");
        assertEq(uwpr.totalRefunded(), tRefBefore,    "totalRefunded unchanged");
    }

    // ─────────────────────────────────────────────
    // Inactive endpoint does NOT block refund
    // ─────────────────────────────────────────────

    function test_Refund_WorksWhenEndpointInactive() public {
        bytes32 rid = _unboundRid(25);
        _pay(rid);

        vm.prank(payee);
        uwpr.setActive(epId, false);

        // refund should still work
        uint256 payerBefore = payer.balance;
        vm.prank(payee);
        uwpr.refund(rid);

        UsdcPayPerRequest.Payment memory p = uwpr.getPayment(rid);
        assertTrue(p.refunded);
        assertEq(payer.balance, payerBefore + PRICE);
    }

    // ─────────────────────────────────────────────
    // Reentrancy: payer tries to re-enter refund via receive()
    // ─────────────────────────────────────────────

    function test_Refund_Reentrancy_ReentrantPayReceiver() public {
        // Deploy ReentrantPayReceiver — on receive(), tries to call pay() with a second requestId
        ReentrantPayReceiver reentrant = new ReentrantPayReceiver(address(uwpr));
        vm.deal(address(reentrant), 100 ether);

        bytes32 rid1 = _unboundRid(30);
        bytes32 rid2 = _unboundRid(31);

        // Setup: second requestId for re-entry attempt
        reentrant.setup(epId, rid2, PRICE);

        // Also fund the reentrant contract with enough for the inner pay
        // (but nonReentrant should block it anyway)

        // Pay first request from reentrant contract
        vm.prank(address(reentrant));
        uwpr.pay{value: PRICE}(epId, rid1);

        // Refund: on ETH receipt, reentrant tries to pay() with rid2
        // nonReentrant blocks the inner call; the outer refund may succeed or revert
        vm.prank(payee);
        // We can't know for certain if it succeeds or bubbles — just check consistency
        try uwpr.refund(rid1) {
            // Outer refund succeeded
            UsdcPayPerRequest.Payment memory p1 = uwpr.getPayment(rid1);
            assertTrue(p1.refunded, "rid1 refunded");
            // Inner pay attempt was blocked — rid2 should NOT be paid
            assertFalse(uwpr.isPaid(rid2), "rid2 not paid after blocked reentry");
        } catch {
            // Outer refund reverted due to inner revert bubbling up
            UsdcPayPerRequest.Payment memory p1 = uwpr.getPayment(rid1);
            assertFalse(p1.refunded, "rid1 not refunded after revert");
        }
    }
}
