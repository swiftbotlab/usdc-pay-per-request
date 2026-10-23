// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UsdcPayPerRequest} from "../src/UsdcPayPerRequest.sol";

/// @dev An address that cannot receive native USDC.
contract RejectingReceiver {
    receive() external payable {
        revert("no thanks");
    }
}

/// @dev A payer that is a contract (an agent's smart account). Its receive() behaviour is configurable:
///      0 accept, 1 reject, 2 re-enter refund() (bubble), 3 re-enter refund() (swallow), 4 re-enter pay() (bubble).
contract PayerAccount {
    UsdcPayPerRequest public immutable c;
    uint8 public mode;
    bytes32 public lastRequest;
    uint256 public lastEndpoint;
    bool public innerFailed;
    uint256 public received;

    constructor(UsdcPayPerRequest c_) {
        c = c_;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function pay(uint256 endpointId, bytes32 requestId) external payable {
        lastRequest = requestId;
        lastEndpoint = endpointId;
        c.pay{value: msg.value}(endpointId, requestId);
    }

    receive() external payable {
        received += msg.value;
        if (mode == 1) revert("payer rejects");
        if (mode == 2) {
            c.refund(lastRequest);
        } else if (mode == 3) {
            try c.refund(lastRequest) {}
            catch {
                innerFailed = true;
            }
        } else if (mode == 4) {
            c.pay{value: msg.value}(lastEndpoint, bytes32(uint256(uint160(address(this))) << 96 | 0xbeef));
        }
    }
}

/// @dev A payee contract that cannot receive native USDC itself but can still withdraw its credit elsewhere.
contract NoReceivePayee {
    UsdcPayPerRequest public immutable c;

    constructor(UsdcPayPerRequest c_) {
        c = c_;
    }

    function pull(address to, uint256 amount) external {
        c.withdraw(to, amount);
    }
}

/// @dev A payee that tries to withdraw again while its first withdrawal is being paid out.
contract ReentrantPayee {
    UsdcPayPerRequest public immutable c;
    bool public swallow;
    bool public armed;
    bool public innerFailed;
    uint256 public received;

    constructor(UsdcPayPerRequest c_) {
        c = c_;
    }

    function arm(bool swallow_) external {
        armed = true;
        swallow = swallow_;
    }

    function withdrawAll() external {
        c.withdraw(address(this), c.creditOf(address(this)) / 2);
    }

    receive() external payable {
        received += msg.value;
        if (!armed) return;
        armed = false;
        uint256 rest = c.creditOf(address(this));
        if (swallow) {
            try c.withdraw(address(this), rest) {}
            catch {
                innerFailed = true;
            }
        } else {
            c.withdraw(address(this), rest);
        }
    }
}
