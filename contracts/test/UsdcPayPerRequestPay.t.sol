// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcPayPerRequest} from "../UsdcPayPerRequest.sol";

contract UsdcPayPerRequestPayTest is Test {
    UsdcPayPerRequest internal uwpr;

    address internal provider = address(1);
    address internal payer    = address(2);
    address internal payee    = address(3);

    uint128 internal constant PRICE = 1 ether;
    string  internal constant NAME  = "pay-api/v1";

    uint256 internal epId;

    /// @dev Returns an unbound requestId (top 20 bytes == 0) using a deterministic nonce.
    function _unboundRid(uint256 nonce) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(nonce))) & type(uint96).max) | bytes32(uint256(1));
    }

    function setUp() public {
        uwpr = new UsdcPayPerRequest();
        vm.deal(provider, 100 ether);
        vm.deal(payer,    100 ether);
        vm.deal(payee,    100 ether);

        // Register one endpoint (payee==provider here for simplicity)
        vm.prank(payee);
        epId = uwpr.registerEndpoint(PRICE, payee, NAME);
    }

    // ─────────────────────────────────────────────
    // pay — happy path
    // ─────────────────────────────────────────────

    function test_Pay_HappyPath() public {
        bytes32 rid = _unboundRid(1);
        uint256 before = address(uwpr).balance;

        vm.prank(payer);
        vm.expectEmit(true, true, true, true, address(uwpr));
        emit UsdcPayPerRequest.Paid(epId, rid, payer, payee, PRICE);
        uwpr.pay{value: PRICE}(epId, rid);

        // Contract balance increased
        assertEq(address(uwpr).balance, before + PRICE, "contract balance");

        // Payment struct
        UsdcPayPerRequest.Payment memory p = uwpr.getPayment(rid);
        assertEq(p.payer,      payer,            "p.payer");
        assertEq(p.endpointId, uint64(epId),     "p.endpointId");
        assertFalse(p.refunded,                  "p.refunded");
        assertEq(p.amount,     PRICE,            "p.amount");
        assertEq(p.paidAt,     block.timestamp,  "p.paidAt");
        assertEq(p.paidBlock,  block.number,     "p.paidBlock");

        // Endpoint counters
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(epId);
        assertEq(ep.paidCount,  1,     "ep.paidCount");
        assertEq(ep.totalPaid,  PRICE, "ep.totalPaid");

        // Credit and global totals
        assertEq(uwpr.credit(payee),    PRICE, "credit[payee]");
        assertEq(uwpr.totalCredits(),   PRICE, "totalCredits");
        assertEq(uwpr.totalPaid(),      PRICE, "totalPaid");

        // isPaid
        assertTrue(uwpr.isPaid(rid));
    }

    // ─────────────────────────────────────────────
    // pay — revert paths
    // ─────────────────────────────────────────────

    function test_Pay_RevertUnknownEndpointZero() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 0)
        );
        uwpr.pay{value: PRICE}(0, _unboundRid(10));
    }

    function test_Pay_RevertUnknownEndpointHigh() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 99)
        );
        uwpr.pay{value: PRICE}(99, _unboundRid(11));
    }

    function test_Pay_RevertEndpointInactive() public {
        vm.prank(payee);
        uwpr.setActive(epId, false);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.EndpointInactive.selector, epId)
        );
        uwpr.pay{value: PRICE}(epId, _unboundRid(12));
    }

    function test_Pay_RevertZeroRequestId() public {
        vm.prank(payer);
        vm.expectRevert(UsdcPayPerRequest.ZeroRequestId.selector);
        uwpr.pay{value: PRICE}(epId, bytes32(0));
    }

    function test_Pay_RevertRequestNotForPayer() public {
        // Bind requestId to payer
        bytes32 rid = uwpr.requestIdFor(payer, keccak256("digest-1"));

        // provider tries to pay payer-bound requestId
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.RequestNotForPayer.selector, payer)
        );
        uwpr.pay{value: PRICE}(epId, rid);

        // Bound payer CAN pay it
        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);
        assertTrue(uwpr.isPaid(rid));
    }

    function test_Pay_RevertAlreadyPaid() public {
        bytes32 rid = _unboundRid(20);
        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid)
        );
        uwpr.pay{value: PRICE}(epId, rid);
    }

    function test_Pay_RevertAlreadyPaidAfterRefund() public {
        bytes32 rid = _unboundRid(21);
        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);

        // Refund it
        vm.prank(payee);
        uwpr.refund(rid);

        // Try to re-pay: AlreadyPaid (payment record still exists)
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid)
        );
        uwpr.pay{value: PRICE}(epId, rid);
    }

    function test_Pay_RevertWrongAmount_TooLow() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, PRICE - 1, PRICE)
        );
        uwpr.pay{value: PRICE - 1}(epId, _unboundRid(30));
    }

    function test_Pay_RevertWrongAmount_TooHigh() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, PRICE + 1, PRICE)
        );
        uwpr.pay{value: PRICE + 1}(epId, _unboundRid(31));
    }

    function test_Pay_RevertWrongAmount_Zero() public {
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, 0, PRICE)
        );
        uwpr.pay{value: 0}(epId, _unboundRid(32));
    }

    function test_Pay_FailedPaymentDoesNotConsumeRequestId() public {
        bytes32 rid = _unboundRid(33);

        // First attempt with wrong amount — fails
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, PRICE - 1, PRICE)
        );
        uwpr.pay{value: PRICE - 1}(epId, rid);

        // requestId not consumed; can pay with correct amount
        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);
        assertTrue(uwpr.isPaid(rid));
    }

    // ─────────────────────────────────────────────
    // Unbound requestId
    // ─────────────────────────────────────────────

    function test_Pay_UnboundRequestId_AnyoneCanPay() public {
        // Top 20 bytes == 0 means unbound
        bytes32 rid = bytes32(uint256(0x000000000000000000000000000000000000000000000000000000000000ABCD));

        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);
        assertTrue(uwpr.isPaid(rid));
    }

    function test_Pay_UnboundRequestId_SecondPayerReverts() public {
        bytes32 rid = bytes32(uint256(0x000000000000000000000000000000000000000000000000000000000000ABCD));

        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);

        // Second payer tries same unbound rid
        address payer2 = address(4);
        vm.deal(payer2, 100 ether);
        vm.prank(payer2);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.AlreadyPaid.selector, rid)
        );
        uwpr.pay{value: PRICE}(epId, rid);
    }

    // ─────────────────────────────────────────────
    // requestIdFor vector / payerOf
    // ─────────────────────────────────────────────

    function test_RequestIdFor_KnownVector() public view {
        address testPayer = 0x2222222222222222222222222222222222222222;
        bytes32 digest    = 0xf7bbb6442ebdcb04aed15aae4fedb9149c0675c791fd801985e2bd8a9a5903dd;
        bytes32 expected  = 0x222222222222222222222222222222222222222291fd801985e2bd8a9a5903dd;

        bytes32 result = uwpr.requestIdFor(testPayer, digest);
        assertEq(result, expected, "requestIdFor vector");
        assertEq(uwpr.payerOf(result), testPayer, "payerOf round-trip");
    }

    function test_PayerOf_UnboundIsZero() public view {
        bytes32 rid = bytes32(uint256(0x0000000000000000000000000000000000000000000000000000000000ABCDEF));
        assertEq(uwpr.payerOf(rid), address(0));
    }

    // ─────────────────────────────────────────────
    // Price change affects next pay
    // ─────────────────────────────────────────────

    function test_Pay_PriceChange_OldQuoteReverts() public {
        uint128 newPrice = 2 ether;
        vm.prank(payee);
        uwpr.setPrice(epId, newPrice);

        bytes32 rid = _unboundRid(40);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, PRICE, newPrice)
        );
        uwpr.pay{value: PRICE}(epId, rid);
    }

    function test_Pay_PriceChange_NewPriceSucceeds() public {
        uint128 newPrice = 2 ether;
        vm.prank(payee);
        uwpr.setPrice(epId, newPrice);

        bytes32 rid = _unboundRid(41);
        vm.prank(payer);
        uwpr.pay{value: newPrice}(epId, rid);
        assertTrue(uwpr.isPaid(rid));
    }

    // ─────────────────────────────────────────────
    // Plain ETH transfer rejected
    // ─────────────────────────────────────────────

    function test_PlainEthTransferReverts() public {
        (bool ok,) = address(uwpr).call{value: 1 ether}("");
        assertFalse(ok, "plain ETH should revert");
    }

    // ─────────────────────────────────────────────
    // canPay agrees with pay
    // ─────────────────────────────────────────────

    function test_CanPayAgreesPay_OK() public {
        bytes32 rid = _unboundRid(50);
        (bool ok, uint8 reason) = uwpr.canPay(epId, rid, payer, PRICE);
        assertTrue(ok);
        assertEq(reason, 0);
        // pay succeeds
        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);
    }

    function test_CanPayAgreesPay_UnknownEndpoint() public view {
        (bool ok, uint8 reason) = uwpr.canPay(99, _unboundRid(51), payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 1); // UnknownEndpoint
    }

    function test_CanPayAgreesPay_Inactive() public {
        vm.prank(payee);
        uwpr.setActive(epId, false);
        (bool ok, uint8 reason) = uwpr.canPay(epId, _unboundRid(52), payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 2); // EndpointInactive
    }

    function test_CanPayAgreesPay_ZeroRid() public {
        (bool ok, uint8 reason) = uwpr.canPay(epId, bytes32(0), payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 3); // ZeroRequestId
    }

    function test_CanPayAgreesPay_WrongPayer() public {
        bytes32 rid = uwpr.requestIdFor(payer, keccak256("d"));
        (bool ok, uint8 reason) = uwpr.canPay(epId, rid, provider, PRICE);
        assertFalse(ok);
        assertEq(reason, 4); // RequestNotForPayer
    }

    function test_CanPayAgreesPay_AlreadyPaid() public {
        bytes32 rid = _unboundRid(53);
        vm.prank(payer);
        uwpr.pay{value: PRICE}(epId, rid);
        (bool ok, uint8 reason) = uwpr.canPay(epId, rid, payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 5); // AlreadyPaid
    }

    function test_CanPayAgreesPay_WrongAmount() public {
        (bool ok, uint8 reason) = uwpr.canPay(epId, _unboundRid(54), payer, PRICE - 1);
        assertFalse(ok);
        assertEq(reason, 6); // WrongAmount
    }
}
