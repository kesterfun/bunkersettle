// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RoleGuard} from "./base/RoleGuard.sol";
import {IPaymentEscrow} from "./interfaces/IPaymentEscrow.sol";
import {
    ROLE_ADMIN,
    OnlyModule,
    AlreadyWired,
    InvalidParameter,
    InsufficientEscrow
} from "./interfaces/BunkerTypes.sol";

/// @title PaymentEscrow
/// @notice Holds MockSGD per order. Callable only by BunkerOrder (and DisputeManager for split).
contract PaymentEscrow is IPaymentEscrow, RoleGuard, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public orderContract;
    address public disputeManager;

    mapping(uint256 => uint256) private _balances;

    event OrderContractSet(address indexed orderContract);
    event DisputeManagerSet(address indexed disputeManager);
    event Deposited(uint256 indexed id, address indexed from, uint256 amount);
    event Released(uint256 indexed id, address indexed to, uint256 amount);
    event Refunded(uint256 indexed id, address indexed to, uint256 amount);
    event Split(uint256 indexed id, address supplier, uint256 supplierAmount, address bank, uint256 bankAmount);

    constructor(address registry_, address token_) RoleGuard(registry_) {
        if (token_ == address(0)) revert InvalidParameter("token");
        token = IERC20(token_);
    }

    modifier onlyOrder() {
        if (msg.sender != orderContract) revert OnlyModule(msg.sender);
        _;
    }

    /// @notice Wire the BunkerOrder contract. ADMIN only, once.
    /// @param order_ BunkerOrder address.
    function setOrderContract(address order_) external {
        _requireRole(ROLE_ADMIN, msg.sender);
        if (orderContract != address(0)) revert AlreadyWired();
        if (order_ == address(0)) revert InvalidParameter("orderContract");
        orderContract = order_;
        emit OrderContractSet(order_);
    }

    /// @notice Wire the DisputeManager contract. ADMIN only, once.
    /// @param dispute_ DisputeManager address.
    function setDisputeManager(address dispute_) external {
        _requireRole(ROLE_ADMIN, msg.sender);
        if (disputeManager != address(0)) revert AlreadyWired();
        if (dispute_ == address(0)) revert InvalidParameter("disputeManager");
        disputeManager = dispute_;
        emit DisputeManagerSet(dispute_);
    }

    /// @notice Pull tokens from `from` into escrow for an order. BunkerOrder only.
    /// @param id Order id.
    /// @param from Payer (must have approved this contract).
    /// @param amount Token amount.
    function deposit(uint256 id, address from, uint256 amount) external override onlyOrder nonReentrant {
        _balances[id] += amount;
        token.safeTransferFrom(from, address(this), amount);
        emit Deposited(id, from, amount);
    }

    /// @notice Pay `amount` to `to` from the order's escrow. BunkerOrder only.
    /// @param id Order id.
    /// @param to Recipient.
    /// @param amount Token amount.
    function release(uint256 id, address to, uint256 amount) external override onlyOrder nonReentrant {
        _debit(id, amount);
        token.safeTransfer(to, amount);
        emit Released(id, to, amount);
    }

    /// @notice Return `amount` to `to` (the bank) from the order's escrow. BunkerOrder only.
    /// @param id Order id.
    /// @param to Recipient.
    /// @param amount Token amount.
    function refund(uint256 id, address to, uint256 amount) external override onlyOrder nonReentrant {
        _debit(id, amount);
        token.safeTransfer(to, amount);
        emit Refunded(id, to, amount);
    }

    /// @notice Pay out a dispute resolution to supplier and bank. DisputeManager only.
    /// @param id Order id.
    /// @param supplier Supplier address.
    /// @param supplierAmt Amount for the supplier.
    /// @param bank Bank address.
    /// @param bankAmt Amount for the bank.
    function split(uint256 id, address supplier, uint256 supplierAmt, address bank, uint256 bankAmt)
        external
        override
        nonReentrant
    {
        if (msg.sender != disputeManager) revert OnlyModule(msg.sender);
        _debit(id, supplierAmt + bankAmt);
        if (supplierAmt > 0) token.safeTransfer(supplier, supplierAmt);
        if (bankAmt > 0) token.safeTransfer(bank, bankAmt);
        emit Split(id, supplier, supplierAmt, bank, bankAmt);
    }

    /// @notice Token balance currently escrowed for an order.
    /// @param id Order id.
    function balanceOf(uint256 id) external view override returns (uint256) {
        return _balances[id];
    }

    function _debit(uint256 id, uint256 amount) private {
        uint256 bal = _balances[id];
        if (amount > bal) revert InsufficientEscrow(id, amount, bal);
        _balances[id] = bal - amount;
    }
}
