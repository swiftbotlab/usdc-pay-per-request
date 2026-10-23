// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {UsdcPayPerRequest} from "../UsdcPayPerRequest.sol";
import {RejectingReceiver} from "../test-helpers/PaywallHelpers.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Handler — drives all state transitions
// ─────────────────────────────────────────────────────────────────────────────
contract UsdcPayPerRequestHandler is Test {
    UsdcPayPerRequest public uwpr;

    // Actors
    address[2] public providers;
    address[3] public payers;     // payers[2] is a RejectingReceiver
    address[2] public payees;     // payees[1] is also a RejectingReceiver (no-recv-eth)

    RejectingReceiver internal rejectingPayer;
    RejectingReceiver internal rejectingPayee;

    // Local shadow accounting
    mapping(address => uint256) public trackedCredit;
    mapping(address => bool)    private _creditActorSeen;
    address[] internal _creditActors;
    uint256 public trackedTotalPaid;
    uint256 public trackedTotalRefunded;
    uint256 public trackedTotalWithdrawn;

    // Registered endpoints
    uint256[] public endpointIds;
    // payments: requestId => (paid, refunded, amount, payee)
    struct PayRec { bool paid; bool refunded; uint128 amount; address payee; uint64 endpointId; }
    mapping(bytes32 => PayRec) public payRecords;
    bytes32[] public paidRids;

    // Per-endpoint shadow
    mapping(uint64 => uint256) public epShadowPaid;
    mapping(uint64 => uint256) public epShadowRefunded;
    mapping(uint64 => uint256) public epShadowRefundCount;

    uint256 private _ridNonce;

    constructor(UsdcPayPerRequest _uwpr) {
        uwpr = _uwpr;

        // Providers
        providers[0] = makeAddr("handler-provider-0");
        providers[1] = makeAddr("handler-provider-1");

        // Normal payers
        payers[0] = makeAddr("handler-payer-0");
        payers[1] = makeAddr("handler-payer-1");

        // Rejecting receiver as payer[2]
        rejectingPayer = new RejectingReceiver();
        payers[2] = address(rejectingPayer);

        // Normal payee
        payees[0] = makeAddr("handler-payee-0");

        // Rejecting receiver as payee[1]
        rejectingPayee = new RejectingReceiver();
        payees[1] = address(rejectingPayee);

        // Fund everyone
        vm.deal(providers[0], 1_000_000 ether);
        vm.deal(providers[1], 1_000_000 ether);
        vm.deal(payers[0],    1_000_000 ether);
        vm.deal(payers[1],    1_000_000 ether);
        vm.deal(address(rejectingPayer), 1_000_000 ether);
        vm.deal(payees[0],    1_000_000 ether);

        // Track credit actors (deduplicated)
        _trackCreditActor(payees[0]);
        _trackCreditActor(payees[1]);

        // Pre-approve providers for both payees
        for (uint256 i = 0; i < 2; i++) {
            for (uint256 j = 0; j < 2; j++) {
                // payees[0] can be pranked; payees[1] is a contract with no code — skip direct prank
                if (i == 0) {
                    vm.prank(payees[i]);
                    uwpr.approveProvider(providers[j], true);
                }
                // For payee[1] (RejectingReceiver), it has no code to approve — skip
                // providers can register with payee==provider (self) anyway
            }
        }
    }

    // ─── internal helpers ─────────────────────────────────────────────────

    function _trackCreditActor(address a) internal {
        if (!_creditActorSeen[a]) {
            _creditActorSeen[a] = true;
            _creditActors.push(a);
        }
    }

    // ─── approveProvider ──────────────────────────────────────────────────

    function approveProvider(uint8 payeeIdx, uint8 provIdx, bool approved) external {
        payeeIdx = uint8(bound(payeeIdx, 0, 0)); // only payees[0] can prank
        provIdx  = uint8(bound(provIdx,  0, 1));
        vm.prank(payees[payeeIdx]);
        uwpr.approveProvider(providers[provIdx], approved);
    }

    // ─── registerEndpoint ─────────────────────────────────────────────────

    function registerEndpoint(uint8 provIdx, uint8 payeeIdx, uint128 price, uint8 nameIdx) external {
        provIdx  = uint8(bound(provIdx,  0, 1));
        payeeIdx = uint8(bound(payeeIdx, 0, 1));
        price    = uint128(bound(price, 1, 100 ether));

        address prov   = providers[provIdx];
        address payeeA = payees[payeeIdx];

        // If payee is the rejecting receiver, provider must equal payee (they can't approve)
        // Actually payees[1] is RejectingReceiver (no code to call approveProvider from).
        // Use provider as payee instead in that case.
        if (payeeIdx == 1) {
            payeeA = prov; // self as payee avoids approval requirement
        }

        string[4] memory names = ["alpha","beta","gamma","delta"];
        string memory name = names[nameIdx % 4];

        vm.prank(prov);
        try uwpr.registerEndpoint(price, payeeA, name) returns (uint256 id) {
            endpointIds.push(id);
            _trackCreditActor(payeeA);
        } catch {}
    }

    // ─── setPrice ──────────────────────────────────────────────────────────

    function setPrice(uint8 epIdx, uint128 newPrice) external {
        if (endpointIds.length == 0) return;
        epIdx    = uint8(bound(epIdx, 0, endpointIds.length - 1));
        newPrice = uint128(bound(newPrice, 1, 100 ether));
        uint256 id = endpointIds[epIdx];
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(id);
        vm.prank(ep.provider);
        try uwpr.setPrice(id, newPrice) {} catch {}
    }

    // ─── setActive ──────────────────────────────────────────────────────────

    function setActive(uint8 epIdx, bool active) external {
        if (endpointIds.length == 0) return;
        epIdx = uint8(bound(epIdx, 0, endpointIds.length - 1));
        uint256 id = endpointIds[epIdx];
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(id);
        vm.prank(ep.provider);
        try uwpr.setActive(id, active) {} catch {}
    }

    // ─── pay ─────────────────────────────────────────────────────────────

    function pay(uint8 epIdx, uint8 payerIdx) external {
        if (endpointIds.length == 0) return;
        epIdx    = uint8(bound(epIdx,    0, endpointIds.length - 1));
        payerIdx = uint8(bound(payerIdx, 0, 2));

        uint256 id = endpointIds[epIdx];
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(id);
        if (!ep.active) return;

        address p = payers[payerIdx];
        bytes32 rid = keccak256(abi.encode("pay", _ridNonce++, p, id));
        // Unbound (zero top-20 bytes variant via keccak will have arbitrary top bytes —
        // bind it to payer explicitly to avoid RequestNotForPayer)
        // Use a low-entropy rid with zero top bytes for simplicity
        rid = bytes32(uint256(rid) & type(uint96).max);
        if (rid == bytes32(0)) rid = bytes32(uint256(1));

        uint256 price = ep.price;
        if (address(p).balance < price) vm.deal(p, price + 1 ether);

        vm.prank(p);
        try uwpr.pay{value: price}(id, rid) {
            payRecords[rid] = PayRec({
                paid:       true,
                refunded:   false,
                amount:     uint128(price),
                payee:      ep.payee,
                endpointId: uint64(id)
            });
            paidRids.push(rid);
            trackedCredit[ep.payee]  += price;
            trackedTotalPaid         += price;
            epShadowPaid[uint64(id)] += price;
        } catch {}
    }

    // ─── refund ──────────────────────────────────────────────────────────

    function refund(uint8 ridIdx) external {
        if (paidRids.length == 0) return;
        ridIdx = uint8(bound(ridIdx, 0, paidRids.length - 1));
        bytes32 rid = paidRids[ridIdx];
        PayRec storage rec = payRecords[rid];
        if (!rec.paid || rec.refunded) return;

        // Find the provider
        UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(rec.endpointId);
        address prov = ep.provider;

        // Check credit covers it (local shadow)
        if (trackedCredit[rec.payee] < rec.amount) return;
        // If payee is rejectingPayer (a RejectingReceiver acting as payer in refund path)
        // skip — that tests a specific scenario handled in unit tests
        UsdcPayPerRequest.Payment memory pm = uwpr.getPayment(rid);
        if (pm.payer == address(rejectingPayer)) return; // would revert TransferFailed

        vm.prank(prov);
        try uwpr.refund(rid) {
            rec.refunded = true;
            trackedCredit[rec.payee]        -= rec.amount;
            trackedTotalRefunded            += rec.amount;
            epShadowRefunded[rec.endpointId]+= rec.amount;
            epShadowRefundCount[rec.endpointId]++;
        } catch {}
    }

    // ─── withdraw ────────────────────────────────────────────────────────

    function withdraw(uint8 payeeIdx, uint8 toIdx, uint256 amount) external {
        payeeIdx = uint8(bound(payeeIdx, 0, 0)); // only payees[0] can withdraw (has receive)
        toIdx    = uint8(bound(toIdx,    0, 1)); // to: any regular address

        address from = payees[payeeIdx];
        address to   = toIdx == 0 ? payees[0] : makeAddr("withdraw-to");

        uint256 bal = uwpr.credit(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);

        vm.prank(from);
        try uwpr.withdraw(to, amount) {
            trackedCredit[from]   -= amount;
            trackedTotalWithdrawn += amount;
        } catch {}
    }

    // ─── warp ────────────────────────────────────────────────────────────

    function warp(uint32 delta) external {
        vm.warp(block.timestamp + bound(delta, 1, 7 days));
    }

    // ─── helpers for invariant checks ────────────────────────────────────

    function creditActors() external view returns (address[] memory) {
        return _creditActors;
    }

    function paidRidsLength() external view returns (uint256) {
        return paidRids.length;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant test contract
// ─────────────────────────────────────────────────────────────────────────────
contract UsdcPayPerRequestInvariants is Test {
    UsdcPayPerRequest        internal uwpr;
    UsdcPayPerRequestHandler internal handler;

    function setUp() public {
        uwpr    = new UsdcPayPerRequest();
        handler = new UsdcPayPerRequestHandler(uwpr);

        targetContract(address(handler));
    }

    // 1. Contract balance == totalCredits
    function invariant_BalanceEqualsTotalCredits() public view {
        assertEq(
            address(uwpr).balance,
            uwpr.totalCredits(),
            "INV1: balance != totalCredits"
        );
    }

    // 2. totalCredits == sum of creditOf for all known actors
    function invariant_TotalCreditsEqualsSumOfCreditOf() public view {
        address[] memory actors = handler.creditActors();
        uint256 sum;
        for (uint256 i = 0; i < actors.length; i++) {
            sum += uwpr.creditOf(actors[i]);
        }
        assertEq(uwpr.totalCredits(), sum, "INV2: totalCredits != sum(creditOf)");
    }

    // 3. totalCredits + totalWithdrawn == totalPaid - totalRefunded
    function invariant_AccountingEquation() public view {
        assertEq(
            uwpr.totalCredits() + uwpr.totalWithdrawn(),
            uwpr.totalPaid()    - uwpr.totalRefunded(),
            "INV3: accounting equation violated"
        );
    }

    // 4 & 5 & 6. Per-endpoint: totalPaid, totalRefunded, refundCount match shadow
    function invariant_PerEndpointCounters() public view {
        uint256 count = uwpr.endpointCount();
        for (uint256 i = 1; i <= count; i++) {
            UsdcPayPerRequest.Endpoint memory ep = uwpr.getEndpoint(i);
            assertEq(
                ep.totalPaid,
                handler.epShadowPaid(uint64(i)),
                "INV4: ep.totalPaid mismatch"
            );
            assertEq(
                ep.totalRefunded,
                handler.epShadowRefunded(uint64(i)),
                "INV5: ep.totalRefunded mismatch"
            );
            assertEq(
                ep.refundCount,
                handler.epShadowRefundCount(uint64(i)),
                "INV6: ep.refundCount mismatch"
            );
        }
    }

    // 7. Every payment amount stored equals the price at time of payment (exactness)
    function invariant_PaymentAmountsExact() public view {
        uint256 nRids = handler.paidRidsLength();
        for (uint256 i = 0; i < nRids && i < 50; i++) {
            bytes32 rid = handler.paidRids(i);
            (bool paid, , uint128 recAmount, , ) = handler.payRecords(rid);
            if (!paid) continue;
            UsdcPayPerRequest.Payment memory pm = uwpr.getPayment(rid);
            assertEq(pm.amount, recAmount, "INV7: payment amount mismatch");
        }
    }
}
