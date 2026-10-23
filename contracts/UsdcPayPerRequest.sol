// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title UsdcPayPerRequest
/// @notice HTTP-402 paywall settled on Arc, where the native gas token is USDC (18 decimals).
/// @dev Providers register priced API endpoints. Clients pay exactly one endpoint price per request
///      via `pay(endpointId, requestId)` using `msg.value` (18-decimal native USDC). An API server can
///      verify payment by reading `Paid` events or `getPayment(requestId)`.
///
///      Accounting invariants:
///      - Contract balance == totalCredits == sum of all `credit[account]`
///      - totalCredits + totalWithdrawn == totalPaid - totalRefunded
///      - Each requestId can be paid at most once and refunded at most once
///
///      Rules summary:
///      - No admin/owner, protocol fees, global pause, upgrade hooks, receive(), or fallback()
///      - All state-changing functions are `nonReentrant`
///      - Checks-effects-events-interaction ordering is followed throughout
///      - Endpoint ids start at 1
///      - requestId top-20-byte payer binding protects against front-running payment hijacks
contract UsdcPayPerRequest is ReentrancyGuard {
    struct Endpoint {
        address provider;
        bool active;
        uint64 createdAt;
        address payee;
        uint64 paidCount;
        uint128 price;
        uint128 totalPaid;
        uint128 totalRefunded;
        uint64 refundCount;
    }

    struct Payment {
        address payer;
        uint64 endpointId;
        bool refunded;
        uint128 amount;
        uint64 paidAt;
        uint64 paidBlock;
    }
    // payer == 0 means not paid
    // paidAt = block.timestamp, paidBlock = block.number

    mapping(uint256 => Endpoint) private _endpoints;
    mapping(uint256 => string) private _names;
    mapping(address => uint256[]) private _providerEndpoints;
    mapping(bytes32 => Payment) private _payments;
    mapping(address => uint256) public credit;
    mapping(address => mapping(address => bool)) private _approvals;

    uint256 public endpointCount;
    uint256 public totalCredits;
    uint256 public totalPaid;
    uint256 public totalRefunded;
    uint256 public totalWithdrawn;
    uint256 public constant MAX_NAME = 64;

    error ZeroAddress();
    error ZeroAmount();
    error InvalidPrice();
    error InvalidName();
    error InvalidPayee();
    error PayeeNotApproved(address payee);
    error UnknownEndpoint(uint256 id);
    error EndpointInactive(uint256 id);
    error NotProvider();
    error ZeroRequestId();
    error RequestNotForPayer(address boundPayer);
    error AlreadyPaid(bytes32 requestId);
    error WrongAmount(uint256 sent, uint256 price);
    error UnknownPayment(bytes32 requestId);
    error AlreadyRefunded(bytes32 requestId);
    error InsufficientCredit(uint256 amount, uint256 credit);
    error TransferFailed();

    /// @notice Emitted when a provider registers a new endpoint.
    /// @param id Endpoint id.
    /// @param provider Provider address.
    /// @param payee Payee address that accrues credits.
    /// @param price Endpoint price in native USDC wei (18 decimals).
    /// @param name Endpoint name.
    event EndpointRegistered(
        uint256 indexed id,
        address indexed provider,
        address indexed payee,
        uint256 price,
        string name
    );

    /// @notice Emitted when an endpoint price is updated.
    /// @param id Endpoint id.
    /// @param oldPrice Previous price.
    /// @param newPrice New price.
    event PriceChanged(uint256 indexed id, uint256 oldPrice, uint256 newPrice);

    /// @notice Emitted when an endpoint active state is updated.
    /// @param id Endpoint id.
    /// @param active New active flag.
    event ActiveSet(uint256 indexed id, bool active);

    /// @notice Emitted when a request is paid.
    /// @param endpointId Endpoint id.
    /// @param requestId Request identifier.
    /// @param payer Payer address.
    /// @param payee Endpoint payee address.
    /// @param amount Paid amount.
    event Paid(
        uint256 indexed endpointId,
        bytes32 indexed requestId,
        address indexed payer,
        address payee,
        uint256 amount
    );

    /// @notice Emitted when a request payment is refunded.
    /// @param endpointId Endpoint id.
    /// @param requestId Request identifier.
    /// @param payer Original payer.
    /// @param amount Refunded amount.
    event Refunded(
        uint256 indexed endpointId,
        bytes32 indexed requestId,
        address indexed payer,
        uint256 amount
    );

    /// @notice Emitted when an account withdraws its accrued credit.
    /// @param account Credit owner.
    /// @param to Recipient address.
    /// @param amount Withdrawn amount.
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    /// @notice Emitted when a payee approves or revokes a provider for future endpoint registrations.
    /// @param payee Payee account granting approval.
    /// @param provider Provider account approved/revoked.
    /// @param approved Approval status.
    event ProviderApproval(address indexed payee, address indexed provider, bool approved);

    /// @notice Builds a payer-bound request id from payer and digest.
    /// @param payer Bound payer (top 20 bytes).
    /// @param digest Low 12-byte payload source (only low 96 bits are kept).
    /// @return Request id bound to payer.
    function requestIdFor(address payer, bytes32 digest) public pure returns (bytes32) {
        return bytes32((uint256(uint160(payer)) << 96) | (uint256(digest) & type(uint96).max));
    }

    /// @notice Extracts the payer binding from a request id.
    /// @param requestId Request identifier.
    /// @return Bound payer address, or zero address if unbound.
    function payerOf(bytes32 requestId) public pure returns (address) {
        return address(uint160(uint256(requestId) >> 96));
    }

    /// @notice Approves or revokes a provider to create future endpoints paying to the caller.
    /// @param provider Provider to approve/revoke.
    /// @param approved True to approve, false to revoke.
    function approveProvider(address provider, bool approved) external nonReentrant {
        if (provider == address(0)) revert ZeroAddress();

        _approvals[msg.sender][provider] = approved;

        emit ProviderApproval(msg.sender, provider, approved);
    }

    /// @notice Registers a new endpoint with fixed payee and price.
    /// @param price Endpoint price in native USDC wei (18 decimals).
    /// @param payee Recipient credited for successful payments.
    /// @param name Endpoint name (1..64 bytes).
    /// @return id Newly registered endpoint id.
    function registerEndpoint(uint128 price, address payee, string calldata name) external nonReentrant returns (uint256 id) {
        if (payee == address(0)) revert ZeroAddress();
        if (payee == address(this)) revert InvalidPayee();
        if (payee != msg.sender && !_approvals[payee][msg.sender]) revert PayeeNotApproved(payee);
        if (price == 0) revert InvalidPrice();

        uint256 nameLength = bytes(name).length;
        if (nameLength == 0 || nameLength > MAX_NAME) revert InvalidName();

        endpointCount++;
        id = endpointCount;

        _endpoints[id] = Endpoint({
            provider: msg.sender,
            active: true,
            createdAt: uint64(block.timestamp),
            payee: payee,
            paidCount: 0,
            price: price,
            totalPaid: 0,
            totalRefunded: 0,
            refundCount: 0
        });

        _names[id] = name;
        _providerEndpoints[msg.sender].push(id);

        emit EndpointRegistered(id, msg.sender, payee, price, name);
    }

    /// @notice Updates endpoint price.
    /// @param id Endpoint id.
    /// @param newPrice New price in native USDC wei.
    function setPrice(uint256 id, uint128 newPrice) external nonReentrant {
        if (id == 0 || id > endpointCount) revert UnknownEndpoint(id);

        Endpoint storage endpoint = _endpoints[id];
        if (msg.sender != endpoint.provider) revert NotProvider();
        if (newPrice == 0) revert InvalidPrice();

        uint256 oldPrice = endpoint.price;
        endpoint.price = newPrice;

        emit PriceChanged(id, oldPrice, newPrice);
    }

    /// @notice Sets endpoint active/inactive state.
    /// @param id Endpoint id.
    /// @param active New active flag.
    function setActive(uint256 id, bool active) external nonReentrant {
        if (id == 0 || id > endpointCount) revert UnknownEndpoint(id);

        Endpoint storage endpoint = _endpoints[id];
        if (msg.sender != endpoint.provider) revert NotProvider();

        endpoint.active = active;

        emit ActiveSet(id, active);
    }

    function _checkPay(uint256 endpointId, bytes32 requestId, address payer, uint256 amount) private view {
        if (endpointId == 0 || endpointId > endpointCount) revert UnknownEndpoint(endpointId);

        Endpoint storage endpoint = _endpoints[endpointId];
        if (!endpoint.active) revert EndpointInactive(endpointId);
        if (requestId == bytes32(0)) revert ZeroRequestId();

        address boundPayer = payerOf(requestId);
        if (boundPayer != address(0) && boundPayer != payer) revert RequestNotForPayer(boundPayer);
        if (_payments[requestId].payer != address(0)) revert AlreadyPaid(requestId);
        if (amount != endpoint.price) revert WrongAmount(amount, endpoint.price);
    }

    /// @notice Pays exactly one endpoint request.
    /// @param endpointId Endpoint id.
    /// @param requestId Unique request identifier.
    function pay(uint256 endpointId, bytes32 requestId) external payable nonReentrant {
        _checkPay(endpointId, requestId, msg.sender, msg.value);

        Endpoint storage endpoint = _endpoints[endpointId];

        _payments[requestId] = Payment({
            payer: msg.sender,
            endpointId: uint64(endpointId),
            refunded: false,
            amount: uint128(endpoint.price),
            paidAt: uint64(block.timestamp),
            paidBlock: uint64(block.number)
        });

        endpoint.paidCount++;
        endpoint.totalPaid += uint128(msg.value);
        credit[endpoint.payee] += msg.value;
        totalCredits += msg.value;
        totalPaid += msg.value;

        emit Paid(endpointId, requestId, msg.sender, endpoint.payee, msg.value);
    }

    /// @notice Refunds a previously paid request.
    /// @param requestId Request identifier.
    function refund(bytes32 requestId) external nonReentrant {
        Payment storage payment = _payments[requestId];
        if (payment.payer == address(0)) revert UnknownPayment(requestId);

        Endpoint storage endpoint = _endpoints[uint256(payment.endpointId)];
        if (msg.sender != endpoint.provider) revert NotProvider();
        if (payment.refunded) revert AlreadyRefunded(requestId);

        uint256 amount = payment.amount;
        address payee = endpoint.payee;

        uint256 payeeCredit = credit[payee];
        if (payeeCredit < amount) revert InsufficientCredit(amount, payeeCredit);

        payment.refunded = true;
        endpoint.totalRefunded += uint128(amount);
        endpoint.refundCount++;
        credit[payee] = payeeCredit - amount;
        totalCredits -= amount;
        totalRefunded += amount;

        emit Refunded(uint256(payment.endpointId), requestId, payment.payer, amount);

        (bool ok,) = payment.payer.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Withdraws accrued credit to a chosen recipient.
    /// @param to Recipient address.
    /// @param amount Amount to withdraw.
    function withdraw(address to, uint256 amount) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 senderCredit = credit[msg.sender];
        if (amount > senderCredit) revert InsufficientCredit(amount, senderCredit);

        credit[msg.sender] = senderCredit - amount;
        totalCredits -= amount;
        totalWithdrawn += amount;

        emit Withdrawn(msg.sender, to, amount);

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Returns endpoint data for an id, or a zero-value struct if unknown.
    /// @param id Endpoint id.
    /// @return Endpoint struct.
    function getEndpoint(uint256 id) external view returns (Endpoint memory) {
        return _endpoints[id];
    }

    /// @notice Returns endpoint name for an id, or empty string if unknown.
    /// @param id Endpoint id.
    /// @return Endpoint name.
    function nameOf(uint256 id) external view returns (string memory) {
        return _names[id];
    }

    /// @notice Returns endpoint ids registered by a provider.
    /// @param provider Provider address.
    /// @return Endpoint id array.
    function endpointsOf(address provider) external view returns (uint256[] memory) {
        return _providerEndpoints[provider];
    }

    /// @notice Returns payment data for a request id, or zero-value struct if unknown.
    /// @param requestId Request identifier.
    /// @return Payment struct.
    function getPayment(bytes32 requestId) external view returns (Payment memory) {
        return _payments[requestId];
    }

    /// @notice Returns true if request id has been paid at least once.
    /// @param requestId Request identifier.
    /// @return True if paid.
    function isPaid(bytes32 requestId) external view returns (bool) {
        return _payments[requestId].payer != address(0);
    }

    /// @notice Returns available credit for an account.
    /// @param account Account address.
    /// @return Credit amount.
    function creditOf(address account) external view returns (uint256) {
        return credit[account];
    }

    /// @notice Returns whether a provider is approved by a payee for future endpoint registration.
    /// @param payee Payee address.
    /// @param provider Provider address.
    /// @return True if approved.
    function isProviderApproved(address payee, address provider) public view returns (bool) {
        return payee == provider || _approvals[payee][provider];
    }

    /// @notice Simulates whether `pay` would succeed without reverting.
    /// @param endpointId Endpoint id.
    /// @param requestId Request identifier.
    /// @param payer Candidate payer address.
    /// @param amount Candidate amount.
    /// @return ok True when payable under current state.
    /// @return reason Reason code: 0 OK, 1 UnknownEndpoint, 2 EndpointInactive, 3 ZeroRequestId,
    ///         4 RequestNotForPayer, 5 AlreadyPaid, 6 WrongAmount.
    function canPay(uint256 endpointId, bytes32 requestId, address payer, uint256 amount)
        external
        view
        returns (bool ok, uint8 reason)
    {
        if (endpointId == 0 || endpointId > endpointCount) return (false, 1);

        Endpoint storage endpoint = _endpoints[endpointId];
        if (!endpoint.active) return (false, 2);
        if (requestId == bytes32(0)) return (false, 3);

        address boundPayer = payerOf(requestId);
        if (boundPayer != address(0) && boundPayer != payer) return (false, 4);
        if (_payments[requestId].payer != address(0)) return (false, 5);
        if (amount != endpoint.price) return (false, 6);

        return (true, 0);
    }
}
