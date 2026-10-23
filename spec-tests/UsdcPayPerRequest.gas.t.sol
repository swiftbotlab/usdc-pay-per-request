// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {UsdcPayPerRequest} from "../src/UsdcPayPerRequest.sol";

/// @dev Execution gas of the demo calls (forge test --match-contract UsdcPayPerRequestGas -vv). A real tx adds 21,000 +
///      calldata (+25,000 when value lands on a fresh account).
contract UsdcPayPerRequestGas is Test {
    function test_gas_demoCalls() public {
        vm.warp(1_760_000_000);
        UsdcPayPerRequest c = new UsdcPayPerRequest();
        address provider = makeAddr("provider");
        address agent = makeAddr("agent");
        vm.deal(agent, 10 ether);
        uint256 g = gasleft();
        vm.prank(provider);
        uint256 id = c.registerEndpoint(0.01e18, provider, "GET /v1/weather (demo)");
        console.log("registerEndpoint (22-byte name)", g - gasleft());
        bytes32 r1 = c.requestIdFor(agent, keccak256("GET /v1/weather?city=Paris"));
        bytes32 r2 = c.requestIdFor(agent, keccak256("GET /v1/weather?city=Tokyo"));
        bytes32 r3 = c.requestIdFor(agent, keccak256("GET /v1/weather?city=Lima"));
        g = gasleft();
        vm.prank(agent);
        c.pay{value: 0.01e18}(id, r1);
        console.log("pay #1 (payee credit slot cold->nonzero)", g - gasleft());
        g = gasleft();
        vm.prank(agent);
        c.pay{value: 0.01e18}(id, r2);
        console.log("pay #2", g - gasleft());
        g = gasleft();
        vm.prank(agent);
        try c.pay{value: 0.01e18}(id, r2) {} catch {}
        console.log("pay rejected (AlreadyPaid)", g - gasleft());
        g = gasleft();
        vm.prank(provider);
        c.setPrice(id, 0.02e18);
        console.log("setPrice", g - gasleft());
        g = gasleft();
        vm.prank(agent);
        c.pay{value: 0.02e18}(id, r3);
        console.log("pay #3 (new price)", g - gasleft());
        g = gasleft();
        vm.prank(provider);
        c.refund(r2);
        console.log("refund (push to payer)", g - gasleft());
        g = gasleft();
        vm.prank(provider);
        c.setActive(id, false);
        console.log("setActive(false)", g - gasleft());
        uint256 credit = c.creditOf(provider); // read first: a call inside the args would consume the prank
        g = gasleft();
        vm.prank(provider);
        c.withdraw(provider, credit);
        console.log("withdraw (all credit)", g - gasleft());
    }
}
