// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcPayPerRequest} from "../UsdcPayPerRequest.sol";

contract UsdcPayPerRequestTest is Test {
    UsdcPayPerRequest internal uwpr;

    address internal provider = address(1);
    address internal payer    = address(2);
    address internal payee    = address(3);

    uint128 internal constant PRICE = 1 ether; // 1e18 == 1 USDC on Arc
    string  internal constant NAME  = "my-api/v1";

    /// @dev Returns an unbound requestId (top 20 bytes == 0).
    function _unboundRid(uint256 nonce) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(nonce))) & type(uint96).max) | bytes32(uint256(1));
    }

    function setUp() public {
        uwpr = new UsdcPayPerRequest();
        vm.deal(provider, 100 ether);
        vm.deal(payer,    100 ether);
        vm.deal(payee,    100 ether);
    }

    // ─────────────────────────────────────────────
    // registerEndpoint — happy path
    // ─────────────────────────────────────────────

    function test_RegisterEndpoint_HappyPath() public {
        vm.prank(payee);
        vm.expectEmit(true, true, true, true, address(uwpr));
        emit UsdcPayPerRequest.EndpointRegistered(1, payee, payee, PRICE, NAME);
        uint256 id = uwpr.registerEndpoint(PRICE, payee, NAME);

        assertEq(id, 1, "id==1");
        assertEq(uwpr.endpointCount(), 1, "count==1");

        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(1);
        assertEq(ep.provider, payee,  "provider");
        assertEq(ep.payee,    payee,  "payee");
        assertEq(ep.price,    PRICE,  "price");
        assertTrue(ep.active,         "active");

        assertEq(uwpr.nameOf(1), NAME, "name");

        uint256[] memory ids = uwpr.endpointsOf(payee);
        assertEq(ids.length, 1, "endpointsOf length");
        assertEq(ids[0],     1, "endpointsOf[0]");
    }

    function test_RegisterEndpoint_ProviderDifferentFromPayee() public {
        // payee approves provider first
        vm.prank(payee);
        uwpr.approveProvider(provider, true);

        vm.prank(provider);
        uint256 id = uwpr.registerEndpoint(PRICE, payee, NAME);
        assertEq(id, 1);

        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(1);
        assertEq(ep.provider, provider);
        assertEq(ep.payee,    payee);
    }

    function test_RegisterEndpoint_IdIncrements() public {
        vm.prank(payee);
        uwpr.registerEndpoint(PRICE, payee, "ep1");
        vm.prank(payee);
        uint256 id2 = uwpr.registerEndpoint(PRICE, payee, "ep2");
        assertEq(id2, 2);
        assertEq(uwpr.endpointCount(), 2);
    }

    // ─────────────────────────────────────────────
    // registerEndpoint — revert paths
    // ─────────────────────────────────────────────

    function test_RegisterEndpoint_RevertZeroAddress() public {
        vm.prank(provider);
        vm.expectRevert(UsdcPayPerRequest.ZeroAddress.selector);
        uwpr.registerEndpoint(PRICE, address(0), NAME);
    }

    function test_RegisterEndpoint_RevertInvalidPayee() public {
        vm.prank(provider);
        vm.expectRevert(UsdcPayPerRequest.InvalidPayee.selector);
        uwpr.registerEndpoint(PRICE, address(uwpr), NAME);
    }

    function test_RegisterEndpoint_RevertPayeeNotApproved() public {
        // provider != payee, no approval granted
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.PayeeNotApproved.selector, payee)
        );
        uwpr.registerEndpoint(PRICE, payee, NAME);
    }

    function test_RegisterEndpoint_RevertInvalidPrice() public {
        vm.prank(payee);
        vm.expectRevert(UsdcPayPerRequest.InvalidPrice.selector);
        uwpr.registerEndpoint(0, payee, NAME);
    }

    function test_RegisterEndpoint_RevertInvalidNameEmpty() public {
        vm.prank(payee);
        vm.expectRevert(UsdcPayPerRequest.InvalidName.selector);
        uwpr.registerEndpoint(PRICE, payee, "");
    }

    function test_RegisterEndpoint_RevertInvalidNameTooLong() public {
        string memory longName = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 65 bytes
        vm.prank(payee);
        vm.expectRevert(UsdcPayPerRequest.InvalidName.selector);
        uwpr.registerEndpoint(PRICE, payee, longName);
    }

    function test_RegisterEndpoint_MaxNameExactly64() public {
        string memory name64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 64 bytes
        vm.prank(payee);
        uint256 id = uwpr.registerEndpoint(PRICE, payee, name64);
        assertEq(id, 1);
    }

    // ─────────────────────────────────────────────
    // approveProvider
    // ─────────────────────────────────────────────

    function test_ApproveProvider_HappyPath() public {
        vm.prank(payee);
        vm.expectEmit(true, true, false, true, address(uwpr));
        emit UsdcPayPerRequest.ProviderApproval(payee, provider, true);
        uwpr.approveProvider(provider, true);

        assertTrue(uwpr.isProviderApproved(payee, provider), "approved");
    }

    function test_ApproveProvider_AllowsRegistration() public {
        vm.prank(payee);
        uwpr.approveProvider(provider, true);

        vm.prank(provider);
        uint256 id = uwpr.registerEndpoint(PRICE, payee, NAME);
        assertEq(id, 1);
    }

    function test_ApproveProvider_RevokeStopsNewRegistrations() public {
        // Register one endpoint while approved
        vm.prank(payee);
        uwpr.approveProvider(provider, true);
        vm.prank(provider);
        uwpr.registerEndpoint(PRICE, payee, "ep1");

        // Revoke
        vm.prank(payee);
        uwpr.approveProvider(provider, false);

        // Existing endpoint still exists
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(1);
        assertEq(ep.provider, provider, "existing ep unaffected");

        // New registration is blocked
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.PayeeNotApproved.selector, payee)
        );
        uwpr.registerEndpoint(PRICE, payee, "ep2");
    }

    function test_ApproveProvider_RevertZeroAddress() public {
        vm.prank(payee);
        vm.expectRevert(UsdcPayPerRequest.ZeroAddress.selector);
        uwpr.approveProvider(address(0), true);
    }

    function test_IsProviderApproved_SelfAlwaysTrue() public view {
        // payee==provider → always approved
        assertTrue(uwpr.isProviderApproved(payee, payee));
    }

    function test_IsProviderApproved_ProviderNotSelf() public view {
        // provider != payee, no explicit approval
        assertFalse(uwpr.isProviderApproved(payee, provider));
    }

    // ─────────────────────────────────────────────
    // setPrice
    // ─────────────────────────────────────────────

    function _registerEp() internal returns (uint256 id) {
        vm.prank(payee);
        id = uwpr.registerEndpoint(PRICE, payee, NAME);
    }

    function test_SetPrice_HappyPath() public {
        uint256 id = _registerEp();
        uint128 newPrice = 2 ether;
        vm.prank(payee);
        vm.expectEmit(true, false, false, true, address(uwpr));
        emit UsdcPayPerRequest.PriceChanged(id, PRICE, newPrice);
        uwpr.setPrice(id, newPrice);

        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(id);
        assertEq(ep.price, newPrice);
    }

    function test_SetPrice_EmitsEvenIfSamePrice() public {
        uint256 id = _registerEp();
        vm.prank(payee);
        vm.expectEmit(true, false, false, true, address(uwpr));
        emit UsdcPayPerRequest.PriceChanged(id, PRICE, PRICE);
        uwpr.setPrice(id, PRICE);
    }

    function test_SetPrice_RevertUnknownEndpointZero() public {
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 0)
        );
        uwpr.setPrice(0, PRICE);
    }

    function test_SetPrice_RevertUnknownEndpointHigh() public {
        _registerEp();
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 99)
        );
        uwpr.setPrice(99, PRICE);
    }

    function test_SetPrice_RevertNotProvider() public {
        uint256 id = _registerEp();
        vm.prank(provider); // not the actual provider (payee is)
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        uwpr.setPrice(id, 2 ether);
    }

    function test_SetPrice_RevertInvalidPrice() public {
        uint256 id = _registerEp();
        vm.prank(payee);
        vm.expectRevert(UsdcPayPerRequest.InvalidPrice.selector);
        uwpr.setPrice(id, 0);
    }

    // ─────────────────────────────────────────────
    // setActive
    // ─────────────────────────────────────────────

    function test_SetActive_HappyPath() public {
        uint256 id = _registerEp();
        vm.prank(payee);
        vm.expectEmit(true, false, false, true, address(uwpr));
        emit UsdcPayPerRequest.ActiveSet(id, false);
        uwpr.setActive(id, false);

        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(id);
        assertFalse(ep.active);
    }

    function test_SetActive_RevertUnknownEndpoint() public {
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.UnknownEndpoint.selector, 0)
        );
        uwpr.setActive(0, false);
    }

    function test_SetActive_RevertNotProvider() public {
        uint256 id = _registerEp();
        vm.prank(provider);
        vm.expectRevert(UsdcPayPerRequest.NotProvider.selector);
        uwpr.setActive(id, false);
    }

    function test_SetActive_InactiveBlocksPay() public {
        uint256 id = _registerEp();
        vm.prank(payee);
        uwpr.setActive(id, false);

        bytes32 rid = _unboundRid(100);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(UsdcPayPerRequest.EndpointInactive.selector, id)
        );
        uwpr.pay{value: PRICE}(id, rid);
    }

    // ─────────────────────────────────────────────
    // View functions
    // ─────────────────────────────────────────────

    function test_GetEndpoint_UnknownReturnsZeroStruct() public view {
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(999);
        assertEq(ep.provider,  address(0));
        assertEq(ep.price,     0);
        assertEq(ep.paidCount, 0);
        assertFalse(ep.active);
    }

    function test_NameOf_UnknownReturnsEmpty() public view {
        string memory n = uwpr.nameOf(999);
        assertEq(bytes(n).length, 0);
    }

    function test_EndpointsOf_Empty() public view {
        uint256[] memory ids = uwpr.endpointsOf(provider);
        assertEq(ids.length, 0);
    }

    function test_GetPayment_UnknownReturnsZeroStruct() public view {
        UsdcPayPerRequest.Payment memory p = uwpr.getPayment(keccak256("nope"));
        assertEq(p.payer, address(0));
        assertEq(p.amount, 0);
        assertFalse(p.refunded);
    }

    function test_IsPaid_FalseBeforePay() public view {
        assertFalse(uwpr.isPaid(keccak256("nope")));
    }

    function test_CreditOf_ZeroInitially() public view {
        assertEq(uwpr.creditOf(payee), 0);
    }

    // ─────────────────────────────────────────────
    // canPay — all 7 reason codes
    // ─────────────────────────────────────────────

    function test_CanPay_Reason0_OK() public {
        uint256 id = _registerEp();
        bytes32 rid = _unboundRid(200);
        (bool ok, uint8 reason) = uwpr.canPay(id, rid, payer, PRICE);
        assertTrue(ok);
        assertEq(reason, 0);
    }

    function test_CanPay_Reason1_UnknownEndpoint() public view {
        (bool ok, uint8 reason) = uwpr.canPay(0, _unboundRid(201), payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 1);
    }

    function test_CanPay_Reason2_Inactive() public {
        uint256 id = _registerEp();
        vm.prank(payee);
        uwpr.setActive(id, false);
        (bool ok, uint8 reason) = uwpr.canPay(id, _unboundRid(202), payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 2);
    }

    function test_CanPay_Reason3_ZeroRequestId() public {
        uint256 id = _registerEp();
        (bool ok, uint8 reason) = uwpr.canPay(id, bytes32(0), payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 3);
    }

    function test_CanPay_Reason4_RequestNotForPayer() public {
        uint256 id = _registerEp();
        bytes32 rid = uwpr.requestIdFor(payer, _unboundRid(203));
        (bool ok, uint8 reason) = uwpr.canPay(id, rid, provider, PRICE);
        assertFalse(ok);
        assertEq(reason, 4);
    }

    function test_CanPay_Reason5_AlreadyPaid() public {
        uint256 id = _registerEp();
        bytes32 rid = _unboundRid(204);
        vm.prank(payer);
        uwpr.pay{value: PRICE}(id, rid);
        (bool ok, uint8 reason) = uwpr.canPay(id, rid, payer, PRICE);
        assertFalse(ok);
        assertEq(reason, 5);
    }

    function test_CanPay_Reason6_WrongAmount() public {
        uint256 id = _registerEp();
        (bool ok, uint8 reason) = uwpr.canPay(id, _unboundRid(205), payer, PRICE - 1);
        assertFalse(ok);
        assertEq(reason, 6);
    }
}
