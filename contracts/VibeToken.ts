import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    DeployableOP_20,
    encodeSelector,
    NetEvent,              // FIX #3: was missing from imports
    OP20InitParameters,
    Selector,
    ADDRESS_BYTE_LENGTH,
    U256_BYTE_LENGTH,
} from '@btc-vision/btc-runtime/runtime';
import { u256 } from 'as-bignum/assembly';

// ─────────────────────────────────────────────────────────────────────────────
// Token configuration
// Primitive constants are safe at module scope. u256 objects are NOT —
// they must be constructed inside a function (see onDeployment).
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_NAME: string   = 'VIBE';
const TOKEN_SYMBOL: string = 'VIBE';
const TOKEN_DECIMALS: u8   = 18;

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted on every successful token transfer (including mint on deployment).
 * Encodes: from (Address) | to (Address) | amount (u256)
 */
class TransferEvent extends NetEvent {
    constructor(from: Address, to: Address, amount: u256) {
        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH);
        writer.writeAddress(from);
        writer.writeAddress(to);
        writer.writeU256(amount);
        super('Transfer', writer);
    }
}

/**
 * Emitted on every successful approve() call.
 * Encodes: owner (Address) | spender (Address) | amount (u256)
 */
class ApprovalEvent extends NetEvent {
    constructor(owner: Address, spender: Address, amount: u256) {
        const writer = new BytesWriter(ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH);
        writer.writeAddress(owner);
        writer.writeAddress(spender);
        writer.writeU256(amount);
        super('Approval', writer);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VIBE Token Contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @title  VibeToken v2
 * @notice Fixed-supply OP_20 token on Bitcoin via OPNet.
 *
 * Security properties:
 *  - Non-mintable: entire supply is minted to the deployer once at deployment.
 *    No public mint() entry-point exists.
 *  - No burn function: totalSupply is permanently fixed after deployment.
 *  - No owner privilege post-deployment: deployer address is not stored.
 *  - Standard allowance model: approve/transferFrom follow the OP_20 spec.
 *    Allowances are exact values (not incremental), so callers should reset
 *    to 0 before setting a new non-zero allowance to avoid the race condition.
 *
 * NOTE: The OPNet constructor runs on EVERY interaction, not just deployment.
 *       All one-time state writes belong in onDeployment() only.
 */
@final
export class VibeToken extends DeployableOP_20 {

    // ── Lifecycle ──────────────────────────────────────────────────────────

    public constructor() {
        super();
        // DO NOT place any state-writing logic here.
        // This function runs every time the contract is called, not just once.
    }

    /**
     * Called exactly once when the contract is first deployed to the chain.
     * Mints the full fixed supply to the deployer's address.
     *
     * FIX #2: u256 object constructed here (inside a function), not at
     * module scope, which is unsafe in AssemblyScript/WASM.
     */
    public override onDeployment(_calldata: Calldata): void {
        // 21,000,000 tokens × 10^18 (18 decimals)
        const maxSupply: u256 = u256.fromString('21000000000000000000000000');

        this.instantiate(new OP20InitParameters(
            maxSupply,
            TOKEN_DECIMALS,
            TOKEN_NAME,
            TOKEN_SYMBOL,
        ));

        // Mint the entire supply to the deployer — no further minting is possible.
        const deployer: Address = Blockchain.sender;
        this._mint(deployer, maxSupply);

        // Emit a Transfer from the zero address to signal the mint.
        this.emitEvent(new TransferEvent(Address.dead(), deployer, maxSupply));
    }

    // ── OP_20 Standard Entry-Points ────────────────────────────────────────

    /**
     * Transfer `amount` tokens from the caller to `to`.
     *
     * Reverts if:
     *  - `to` is the zero address
     *  - caller balance < amount
     */
    public override transfer(to: Address, amount: u256): bool {
        this.revertIfZeroAddress(to);

        const from: Address = Blockchain.sender;
        this._transfer(from, to, amount);
        this.emitEvent(new TransferEvent(from, to, amount));

        return true;
    }

    /**
     * Approve `spender` to spend up to `amount` on behalf of the caller.
     *
     * ⚠ Race-condition: to change a non-zero allowance, first set it to 0,
     *   then set the new value in a second transaction.
     *
     * Reverts if:
     *  - `spender` is the zero address
     */
    public override approve(spender: Address, amount: u256): bool {
        this.revertIfZeroAddress(spender);

        const owner: Address = Blockchain.sender;
        this._approve(owner, spender, amount);
        this.emitEvent(new ApprovalEvent(owner, spender, amount));

        return true;
    }

    /**
     * Transfer `amount` tokens from `from` to `to` using the caller's allowance.
     *
     * Reverts if:
     *  - `from` or `to` is the zero address
     *  - caller allowance for `from` < amount
     *  - `from` balance < amount
     */
    public override transferFrom(from: Address, to: Address, amount: u256): bool {
        this.revertIfZeroAddress(from);
        this.revertIfZeroAddress(to);

        const spender: Address = Blockchain.sender;
        this._spendAllowance(from, spender, amount);
        this._transfer(from, to, amount);
        this.emitEvent(new TransferEvent(from, to, amount));

        return true;
    }

    // ── Selector Routing ───────────────────────────────────────────────────

    /**
     * OPNet dispatches all external calls through callMethod().
     *
     * FIX #1: The method is `callMethod`, NOT `execute`. Overriding the
     * wrong name means all external calls fall through to the base class
     * and are silently dropped or rejected.
     *
     * Selectors use the same keccak256 ABI encoding convention as Solidity.
     */
    public override callMethod(method: Selector, calldata: Calldata): BytesWriter {
        switch (method) {
            // ─ Write ────────────────────────────────────────────────────────
            case encodeSelector('transfer(address,uint256)'): {
                const to: Address  = calldata.readAddress();
                const amount: u256 = calldata.readU256();
                return this.writeBoolean(this.transfer(to, amount));
            }

            case encodeSelector('approve(address,uint256)'): {
                const spender: Address = calldata.readAddress();
                const amount: u256     = calldata.readU256();
                return this.writeBoolean(this.approve(spender, amount));
            }

            case encodeSelector('transferFrom(address,address,uint256)'): {
                const from: Address = calldata.readAddress();
                const to: Address   = calldata.readAddress();
                const amount: u256  = calldata.readU256();
                return this.writeBoolean(this.transferFrom(from, to, amount));
            }

            // ─ Read ─────────────────────────────────────────────────────────
            case encodeSelector('balanceOf(address)'): {
                const owner: Address = calldata.readAddress();
                const balance: u256  = this.balanceOf(owner);
                const out = new BytesWriter(U256_BYTE_LENGTH);
                out.writeU256(balance);
                return out;
            }

            case encodeSelector('allowance(address,address)'): {
                const owner: Address   = calldata.readAddress();
                const spender: Address = calldata.readAddress();
                const allowed: u256    = this.allowance(owner, spender);
                const out = new BytesWriter(U256_BYTE_LENGTH);
                out.writeU256(allowed);
                return out;
            }

            case encodeSelector('totalSupply()'): {
                const out = new BytesWriter(U256_BYTE_LENGTH);
                out.writeU256(this.totalSupply);
                return out;
            }

            case encodeSelector('name()'): {
                return this.writeString(this.name);
            }

            case encodeSelector('symbol()'): {
                return this.writeString(this.symbol);
            }

            case encodeSelector('decimals()'): {
                const out = new BytesWriter(1);
                out.writeU8(this.decimals);
                return out;
            }

            // ─ Fallback ─────────────────────────────────────────────────────
            default:
                return super.callMethod(method, calldata); // FIX #1: was super.execute()
        }
    }

    // ── Private Helpers ────────────────────────────────────────────────────

    private writeBoolean(value: bool): BytesWriter {
        const out = new BytesWriter(1);
        out.writeBoolean(value);
        return out;
    }

    private writeString(value: string): BytesWriter {
        const encoded = String.UTF8.encode(value);
        const out = new BytesWriter(4 + encoded.byteLength);
        out.writeU32(<u32>encoded.byteLength);
        out.writeBytes(Uint8Array.wrap(encoded));
        return out;
    }

    /**
     * Reverts if the given address is the zero address (all bytes are 0x00).
     *
     * FIX #4: Previously used Address.dead() (0x000...dEaD) which is a burn
     * address, not the zero address. These are different values. Using .dead()
     * as the sentinel would allow transfers to the true zero address (accidental
     * burns) while incorrectly blocking valid transfers to 0x...dEaD.
     *
     * If the OPNet runtime exposes Address.isZero() or Address.zero(), prefer
     * that over a manual byte loop.
     */
    private revertIfZeroAddress(addr: Address): void {
        const bytes = addr.toBytes();
        for (let i: i32 = 0; i < bytes.length; i++) {
            if (bytes[i] != 0) return; // at least one non-zero byte → not zero address
        }
        throw new Error('VIBE: zero address');
    }
}
