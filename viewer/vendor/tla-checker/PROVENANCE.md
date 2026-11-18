# Browser TLA+ engine provenance

This directory contains **tla-rs / tla-checker 0.24.11**, compiled from the official
[upstream repository](https://github.com/fabracht/tla-rs) at commit
`9438572f8278df75427460597ca48b0e0026684c` (release tag `v0.24.11`).

The upstream code is licensed under **MIT OR Apache-2.0**. Both license texts
are distributed here as `LICENSE-MIT` and `LICENSE-APACHE`.

## Browser adaptation

The tracked patch `vendor/tla-rs/browser-modules.patch` adds
`check_spec_with_modules(root_module, sources_json, options_json)`.
It passes selected module sources through a scoped in-memory map to the existing
Rust AST module resolver. It does not concatenate TLA+ source text, implement an
alternate JavaScript evaluator, contact a remote checker, or use a filesystem
on the WASM target.

The patch enables the upstream native `EXTENDS` / `INSTANCE` and cfg-override
preparation paths on WASM, emits exact initial-state identifiers in full graph
exports, validates module dependencies and runtime limits, and rejects cfg
directives that upstream would otherwise warn about and ignore. Unbounded
`Nat`/`Int` remain symbolic; enumeration fails rather than silently using
upstream's finite approximation. The checker and liveness algorithms are the
upstream implementations.

The same in-memory preparation also backs
`explore_init_with_modules(root_module, sources_json, options_json)` and
`explore_next_with_modules(root_module, sources_json, options_json, state_json)`.
These generate genuine configured Init/Next choices using upstream state
evaluation, apply state constraints, and report configured invariants at each
state. Opaque state tokens use explicit value tags and decimal integer strings,
so JavaScript cannot round large integers or confuse tuples, sets, functions,
records, and model values. Tokens include a model/configuration identifier and
are rejected after source/configuration changes. Interactive results are chosen
finite traces, not complete verification of PROPERTY, liveness, or fairness.
VIEW and SYMMETRY search reductions are not applied to concrete interactive
steps. Run-dependent TLCGet, RandomElement, and time operators are rejected,
and excessive initial/action fanout returns an explicit limit error.

Next-step results also include local action diagnostics. Configured Next branches
and finite existential parameter instances are inspected against the exact
current state with the upstream evaluator and successor generator. State-only
conjuncts are reported as true, false, or unknown; evaluator errors are never
reported as false. Generated outcomes excluded by CONSTRAINT are distinguished
from guards that block an action. Alternative branches of one action instance
are grouped so a branch with successors makes that action available. Printed
guards are AST renderings, not exact source slices. Explanations that cannot
isolate a failing guard remain explicit, and a 1,000-instance / 48-level
diagnostic bound emits a truncation warning without truncating the enabled
Next choices. Interactive results remain finite-trace observations.


The application initializes this engine from bundled bytes in a dedicated Web
Worker. Its browser policy disables network connections. These assets contain
no user specifications.

## Rebuild

Rust with the `wasm32-unknown-unknown` target, Git, Node.js 22+, and
`wasm-bindgen-cli 0.2.130` are required. From the application checkout:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --root .cache/wasm-tools
node scripts/build-wasm.mjs
npm run build
```

The script verifies the pinned upstream commit, applies the tracked patch,
uses the tracked `vendor/tla-rs/Cargo.lock`, builds the WASM library, and
generates browser bindings. It performs no user-source analysis. See
`build-info.json` for compiler/tool versions and SHA-256 hashes of this build.

This engine supports a practical subset of TLA+. Consult upstream's
[syntax coverage and known differences](https://github.com/fabracht/tla-rs/blob/v0.24.11/SYNTAX_STATUS.md)
before treating a model-checker result as equivalent to Java TLC.
