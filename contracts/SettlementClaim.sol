// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RoleGuard} from "./base/RoleGuard.sol";
import {IBunkerOrder} from "./interfaces/IBunkerOrder.sol";
import {IDeliveryRecord} from "./interfaces/IDeliveryRecord.sol";
import {ISettlementClaim} from "./interfaces/ISettlementClaim.sol";
import {
    Order,
    Status,
    ROLE_FINANCIER,
    InvalidParameter,
    OnlyModule,
    NotClaimHolder,
    OfferNotActive,
    PriceMismatch,
    ClaimLocked,
    ClaimExpired
} from "./interfaces/BunkerTypes.sol";

interface IPausableOrder {
    function paused() external view returns (bool);
}

/// @title SettlementClaim
/// @notice ERC-721 whose token id is an order id. The holder receives every escrow payout that would
///         otherwise go to the order's supplier. The supplier may sell it to a registered FINANCIER at a
///         discount; the financier carries delivery and quality risk (no recourse).
contract SettlementClaim is ERC721, ISettlementClaim, RoleGuard, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Offer {
        address seller;
        uint256 price;
    }

    IBunkerOrder public immutable order;
    IERC20 public immutable token;

    mapping(uint256 => Offer) private _offers;

    event ClaimOffered(uint256 indexed orderId, address indexed seller, uint256 price, uint256 outstanding);
    event OfferCancelled(uint256 indexed orderId, address indexed seller);
    event ClaimSold(
        uint256 indexed orderId, address indexed seller, address indexed buyer, uint256 price, uint256 outstanding
    );

    constructor(address registry_, address order_, address token_)
        ERC721("BunkerSettle Settlement Claim", "BSCLAIM")
        RoleGuard(registry_)
    {
        if (order_ == address(0)) revert InvalidParameter("order");
        if (token_ == address(0)) revert InvalidParameter("token");
        order = IBunkerOrder(order_);
        token = IERC20(token_);
    }

    modifier onlyOrder() {
        if (msg.sender != address(order)) revert OnlyModule(msg.sender);
        _;
    }

    // ------------------------------------------------------------ order hooks

    /// @notice Mint the claim for a newly funded order to its supplier. BunkerOrder only.
    /// @param orderId Order id (also the token id).
    /// @param supplier The order's supplier.
    function mint(uint256 orderId, address supplier) external override onlyOrder {
        _mint(supplier, orderId);
    }

    /// @notice Burn the claim of a cancelled order. BunkerOrder only.
    /// @param orderId Order id (also the token id).
    function burn(uint256 orderId) external override onlyOrder {
        _burn(orderId);
    }

    // ---------------------------------------------------------------- trading

    /// @notice Offer the claim for sale at a fixed price in the order's payment token. Overwrites any prior offer.
    /// @param orderId Order id (token id). Caller must hold the claim.
    /// @param price Asking price in MockSGD (18 decimals); must be above zero.
    function offer(uint256 orderId, uint256 price) external {
        if (ownerOf(orderId) != msg.sender) revert NotClaimHolder(orderId, msg.sender);
        if (price == 0) revert InvalidParameter("price");
        _requireTradable(orderId);
        _offers[orderId] = Offer(msg.sender, price);
        emit ClaimOffered(orderId, msg.sender, price, outstanding(orderId));
    }

    /// @notice Withdraw an open offer.
    /// @param orderId Order id (token id). Caller must hold the claim.
    function cancelOffer(uint256 orderId) external {
        if (ownerOf(orderId) != msg.sender) revert NotClaimHolder(orderId, msg.sender);
        if (_offers[orderId].seller == address(0)) revert OfferNotActive(orderId);
        delete _offers[orderId];
        emit OfferCancelled(orderId, msg.sender);
    }

    /// @notice Buy an offered claim. FINANCIER only. Pays the seller and receives the token atomically.
    ///         The buyer must have approved this contract for `price` of the payment token.
    /// @param orderId Order id (token id).
    /// @param price Price the buyer expects; must equal the current offer (guards against a changed offer).
    function buy(uint256 orderId, uint256 price) external nonReentrant {
        _requireRole(ROLE_FINANCIER, msg.sender);
        Offer memory o = _offers[orderId];
        address seller = _ownerOf(orderId);
        if (o.seller == address(0) || o.seller != seller) revert OfferNotActive(orderId);
        if (price != o.price) revert PriceMismatch(orderId, o.price, price);
        if (msg.sender == seller) revert InvalidParameter("buyer");
        _requireTradable(orderId);
        delete _offers[orderId];
        token.safeTransferFrom(msg.sender, seller, price);
        _transfer(seller, msg.sender, orderId);
        emit ClaimSold(orderId, seller, msg.sender, price, outstanding(orderId));
    }

    // ------------------------------------------------------------------ views

    /// @notice Current holder, i.e. where escrow payouts for the order go. Zero if the claim was burned.
    /// @param orderId Order id.
    function payeeOf(uint256 orderId) external view override returns (address) {
        return _ownerOf(orderId);
    }

    /// @notice Amount the holder can still expect from escrow: nominal order value while `Funded`,
    ///         retention still unpaid while `QuantityApproved`, otherwise zero.
    /// @param orderId Order id.
    function outstanding(uint256 orderId) public view returns (uint256) {
        Order memory o = order.getOrder(orderId);
        if (o.status == Status.Funded) {
            uint256 nominal = o.qtyKg * o.pricePerTonne / 1000;
            return nominal > o.fundedAmount ? o.fundedAmount : nominal;
        }
        if (o.status == Status.QuantityApproved) return o.payableAmount - o.releasedAmount;
        return 0;
    }

    /// @notice Open offer for a claim (seller is the zero address if none).
    /// @param orderId Order id.
    function getOffer(uint256 orderId) external view returns (Offer memory) {
        return _offers[orderId];
    }

    // -------------------------------------------------------------- internals

    /// @dev Reverts unless the claim may change hands now: order not paused, still awaiting payout, and not expired.
    function _requireTradable(uint256 orderId) private view {
        if (IPausableOrder(address(order)).paused()) revert Pausable.EnforcedPause();
        Order memory o = order.getOrder(orderId);
        if (o.status != Status.Funded && o.status != Status.QuantityApproved) revert ClaimLocked(orderId, o.status);
        if (
            o.status == Status.Funded && block.timestamp > o.deliveryDeadline
                && !IDeliveryRecord(order.deliveryRecord()).hasEvidence(orderId)
        ) revert ClaimExpired(orderId);
    }

    /// @dev Transfers (not mint/burn) need a tradable claim and a FINANCIER receiver; offers die with any move.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0)) {
            if (to != address(0)) {
                _requireTradable(tokenId);
                _requireRole(ROLE_FINANCIER, to);
            }
            delete _offers[tokenId];
        }
        return super._update(to, tokenId, auth);
    }
}
