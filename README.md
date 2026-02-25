VIBE - OP_20 Token on Bitcoin

VIBE is a fixed-supply OP_20 token built natively on Bitcoin via OPNet.

Properties

21,000,000 fixed supply

18 decimals

Minted once in onDeployment()

No public mint

No admin privileges

Manual selector routing via callMethod

WASM-safe u256 initialization

Architecture

The contract explicitly overrides:

callMethod(method: Selector, calldata: Calldata)

Selectors are manually routed using encodeSelector.

Supply is initialized inside onDeployment() to avoid WASM module-scope heap allocation issues.

Security

Second-pass audit fixes applied:

Dispatcher override fix (execute → callMethod)

WASM initialization fix

Zero-address guard correction

Import corrections
