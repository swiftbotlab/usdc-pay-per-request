// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Rejects all ETH transfers (no receive, no fallback).
contract RejectingReceiver {
    // Intentionally no receive() or fallback() — any ETH transfer reverts.
}

/// @dev On receive, first re-enters refund() (which should be guarded) then reverts
///      to simulate a TransferFailed scenario.
contract RejectOnRefundReceiver {
    address public target;
    bytes32 public lastRequestId;

    constructor(address _target) {
        target = _target;
    }

    function setRequestId(bytes32 rid) external {
        lastRequestId = rid;
    }

    receive() external payable {
        // Plain revert to simulate TransferFailed
        revert("RejectOnRefundReceiver: reject");
    }
}

/// @dev A payee that cannot receive ETH — credits accumulate but ETH pushes fail.
///      Supports withdraw to a separate address via the contract's withdraw function.
contract RejectOnWithdrawPayee {
    // No receive() — ETH pushes to this address revert.
    // The test calls uwpr.withdraw(to, amount) from this contract's address
    // via vm.prank, so the ETH goes to `to`, not here.
}

/// @dev On receiving ETH from a refund, tries to re-enter pay() on the target.
///      The reentrancy guard should block the inner pay.
contract ReentrantPayReceiver {
    address public target;
    uint256 public endpointId;
    bytes32 public requestId2; // second, distinct requestId to attempt on re-entry
    uint128 public price;
    bool public reentryAttempted;
    bool public reentryReverted;

    constructor(address _target) {
        target = _target;
    }

    function setup(uint256 _endpointId, bytes32 _requestId2, uint128 _price) external {
        endpointId = _endpointId;
        requestId2 = _requestId2;
        price = _price;
    }

    receive() external payable {
        reentryAttempted = true;
        // Try to re-enter pay on the target; the nonReentrant modifier should block this.
        (bool ok,) = target.call{value: price}(
            abi.encodeWithSignature("pay(uint256,bytes32)", endpointId, requestId2)
        );
        if (!ok) reentryReverted = true;
    }
}

/// @dev On receiving ETH from withdraw, tries to re-enter withdraw() on the target.
///      Catches the revert so the outer withdraw still completes (or itself reverts).
contract ReentrantWithdrawPayee {
    address public target;
    bool public reentryAttempted;
    bool public reentryReverted;

    constructor(address _target) {
        target = _target;
    }

    receive() external payable {
        reentryAttempted = true;
        // Try to re-enter withdraw; the nonReentrant guard should block this.
        (bool ok,) = target.call(
            abi.encodeWithSignature("withdraw(address,uint256)", address(this), msg.value)
        );
        if (!ok) reentryReverted = true;
    }
}
