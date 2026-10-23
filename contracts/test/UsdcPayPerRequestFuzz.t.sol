// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcPayPerRequest} from "../UsdcPayPerRequest.sol";

contract UsdcPayPerRequestFuzzTest is Test {
    UsdcPayPerRequest internal uwpr;

    address internal payee    = address(3);
    address internal provider = address(1);
    address internal payer    = address(2);

    uint128 internal constant FIXED_PRICE = 1 ether;
    uint256 internal epId;

    function setUp() public {
        uwpr = new UsdcPayPerRequest();
        vm.deal(provider, 1_000_000 ether);
        vm.deal(payer,    1_000_000 ether);
        vm.deal(payee,    1_000_000 ether);

        vm.prank(payee);
        epId = uwpr.registerEndpoint(FIXED_PRICE, payee, "fuzz-ep");
    }

    // ─────────────────────────────────────────────
    // Fuzz registerEndpoint
    // ─────────────────────────────────────────────

    function testFuzz_RegisterEndpoint(uint128 price, string calldata name) public {
        price = uint128(bound(uint256(price), 1, type(uint128).max));

        // Truncate / replace name: must be 1..64 bytes
        bytes memory nameBytes = bytes(name);
        uint256 nameLen = nameBytes.length;
        if (nameLen == 0 || nameLen > 64) {
            // Use a valid fixed name when fuzz input is out of range
            nameLen = 8;
            nameBytes = bytes("fuzz-ok!");
        }

        string memory validName = string(nameBytes);

        uint256 countBefore = uwpr.endpointCount();
        vm.prank(payee);
        uint256 id = uwpr.registerEndpoint(price, payee, validName);

        assertEq(id, countBefore + 1, "id increments");
        assertEq(uwpr.endpointCount(), countBefore + 1, "count increments");
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(id);
        assertEq(ep.price, price, "price stored");
    }

    // ─────────────────────────────────────────────
    // Fuzz pay: wrong amount always reverts
    // ─────────────────────────────────────────────

    function testFuzz_Pay_WrongAmountReverts(uint256 amount) public {
        // Exclude the exact price; any other value should revert WrongAmount
        if (amount == FIXED_PRICE) return;

        // Bound to avoid overflow in vm.deal
        amount = bound(amount, 0, 100_000 ether);

        // Use an unbound requestId (zero top-20 bytes) so RequestNotForPayer never fires first
        bytes32 rid = bytes32(uint256(keccak256(abi.encode("fuzz-wrong", amount))) & type(uint96).max)
                      | bytes32(uint256(1));

        // Fund payer if needed
        if (address(payer).balance < amount) {
            vm.deal(payer, amount + 1 ether);
        }

        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.WrongAmount.selector, amount, FIXED_PRICE)
        );
        uwpr.pay{value: amount}(epId, rid);
    }

    function testFuzz_Pay_CorrectAmountSucceeds(bytes32 rid) public {
        // Ensure unbound (zero top-20 bytes) or payer-bound requestId
        // Use only ids with zero top-20 bytes to keep payer flexibility
        rid = bytes32(uint256(rid) & type(uint96).max); // keep low 96 bits only
        vm.assume(rid != bytes32(0));

        vm.prank(payer);
        uwpr.pay{value: FIXED_PRICE}(epId, rid);
        assertTrue(uwpr.isPaid(rid));
    }

    // ─────────────────────────────────────────────
    // Fuzz requestIdFor / payerOf round trip
    // ─────────────────────────────────────────────

    function testFuzz_RequestIdFor_PayerOf_RoundTrip(address p, bytes32 digest) public view {
        bytes32 rid = uwpr.requestIdFor(p, digest);

        // payerOf round trip
        assertEq(uwpr.payerOf(rid), p, "payerOf round-trip");

        // Top 20 bytes must be p
        address extracted = address(uint160(uint256(rid) >> 96));
        assertEq(extracted, p, "top-20 bytes == p");

        // Bottom 12 bytes (96 bits) come from low 96 bits of digest
        uint256 lowDigest = uint256(digest) & type(uint96).max;
        uint256 lowRid    = uint256(rid)    & type(uint96).max;
        assertEq(lowRid, lowDigest, "low-96-bits == digest & mask");
    }

    // ─────────────────────────────────────────────
    // Fuzz canPay agrees with pay
    // ─────────────────────────────────────────────

    function testFuzz_CanPayAgreesPay(
        uint256 fuzzEndpointId,
        bytes32 fuzzRequestId,
        address fuzzPayer,
        uint256 fuzzAmount
    ) public {
        // Bound endpointId: use 0..2 (epId==1 is valid, 0 and 2 are invalid)
        fuzzEndpointId = bound(fuzzEndpointId, 0, 2);
        // Bound amount to avoid huge vm.deal requirements
        fuzzAmount = bound(fuzzAmount, 0, 10 ether);

        // Give fuzzPayer enough ETH
        if (fuzzPayer != address(0) && fuzzPayer.code.length == 0) {
            vm.deal(fuzzPayer, fuzzAmount + 1 ether);
        } else {
            // Use a known EOA for contract addresses / zero
            fuzzPayer = address(uint160(uint256(keccak256(abi.encode("fuzz-payer", fuzzPayer)))));
            vm.deal(fuzzPayer, fuzzAmount + 1 ether);
        }

        (bool canPayOk, uint8 reason) = uwpr.canPay(fuzzEndpointId, fuzzRequestId, fuzzPayer, fuzzAmount);

        vm.prank(fuzzPayer);
        try uwpr.pay{value: fuzzAmount}(fuzzEndpointId, fuzzRequestId) {
            // pay succeeded — canPay must have said ok
            assertTrue(canPayOk, "canPay should be true when pay succeeds");
            assertEq(reason, 0,  "reason should be 0 when pay succeeds");
        } catch (bytes memory revertData) {
            // pay reverted — canPay must have said false
            assertFalse(canPayOk, "canPay should be false when pay reverts");

            // Check reason code matches the actual revert selector
            bytes4 sel = bytes4(revertData);
            if      (sel == UsdcPayPerRequest.UnknownEndpoint.selector)    assertEq(reason, 1);
            else if (sel == UsdcPayPerRequest.EndpointInactive.selector)   assertEq(reason, 2);
            else if (sel == UsdcPayPerRequest.ZeroRequestId.selector)      assertEq(reason, 3);
            else if (sel == UsdcPayPerRequest.RequestNotForPayer.selector) assertEq(reason, 4);
            else if (sel == UsdcPayPerRequest.AlreadyPaid.selector)        assertEq(reason, 5);
            else if (sel == UsdcPayPerRequest.WrongAmount.selector)        assertEq(reason, 6);
            // ReentrancyGuard panic is also possible but not expected in these inputs
        }
    }

    // ─────────────────────────────────────────────
    // Fuzz withdraw: amount > credit always reverts InsufficientCredit
    // ─────────────────────────────────────────────

    function testFuzz_Withdraw_ExcessReverts(uint256 excess) public {
        // Pay once so payee has FIXED_PRICE in credit (unbound requestId)
        bytes32 rid = bytes32(uint256(keccak256("fuzz-withdraw")) & type(uint96).max) | bytes32(uint256(1));
        vm.prank(payer);
        uwpr.pay{value: FIXED_PRICE}(epId, rid);

        uint256 creditBal = uwpr.credit(payee);
        // Only test amounts strictly above credit
        excess = bound(excess, 1, type(uint128).max);
        uint256 overAmount = creditBal + excess;

        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.InsufficientCredit.selector, overAmount, creditBal)
        );
        uwpr.withdraw(payee, overAmount);
    }
}
