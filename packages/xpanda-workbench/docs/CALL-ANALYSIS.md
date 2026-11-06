# Bounded call-target analysis

The references dock now labels its original list **same-name call candidates**.
The explicit analysis action examines those candidate sites and exposes target
identities, receiver provenance, reasons, modeling assumptions and four result
categories. Exact instruction PCs remain separate from JS expression matching.

## What the result means

- `resolved`: one complete function-identity value matches a selected method ID,
  within this bounded model. This does not prove the call executes at runtime.
- `possible`: a selected method ID is present, but alternatives or unknowns remain.
- `unresolved`: evidence is insufficient to decide membership in the selected targets.
- `excluded`: a complete set of known function identities excludes the selected IDs.

Unknown is independent of the finite candidate set. A singleton partial set is
never resolved. Class tables, inferred `this` ownership, module imports and
constructor-field summaries supply weak candidate provenance only. They cannot
remove Unknown. In particular, a native module's name does not prove function
identity when API effects and mutation are unmodeled.

## Implementation and scope

Analysis consumes plain instruction/CFG units prepared directly from ABC, before
JS simplification. It tracks accumulator/register function aliases, CFG merges,
local class definitions and bounded inheritance hints. Module entry records also
supply class ownership and constructor-field candidate hints. Function `.call`
and `.apply` preserve hints with uncertainty about prototype replacement.

The implementation is intraprocedural. It does not implement a complete
interprocedural points-to analysis, lexical-context reconstruction, heap
write analysis or SDK return/effect models. Constructors, overridden properties,
opaque returns and effects remain uncertain. Methods with exception handlers,
missing CFG jumps or exhausted budgets cannot produce complete target claims.

Crucially, the UI analyzes the existing adjacent named-property/call candidate
set. It is **not a complete call graph**: detached-function aliases and other
indirect calls outside that set may be missing even when the interpreter could
analyze them if supplied. A zero resolved count does not mean zero real callers.

## Parallel execution and memory

The analysis Worker retains the PandaFile and full reference index. Subworkers
receive only compact per-method DTOs, with at most two units in flight. No ABC
bytes, Panda objects or full index are cloned to those workers. Cached results
are keyed by source identity, selected method IDs, symbol and analysis revision;
source changes release the analysis pool/cache. Pages are capped at 100 rows.

Small jobs (under 20,000 prepared instructions, or one method) use serial analysis
because worker startup and messaging can cost more than interpretation. Larger
jobs use at most two reusable subworkers. Worker failure falls back to the same
interpreter, and cancellation rejects stale results. The Node benchmark forces
both execution modes on identical prepared units and compares every output.

## Validation on 2026-11-06

`npm run test --workspace=xpanda-workbench` passes 16 tests. They include real SDK
ABC fixtures for homonyms, aliases, overrides, parameters, returns, closures,
method replacement, opaque effects, exception paths, and declaring-class hints;
also Unknown propagation, target-set/instruction budgets, actual two-thread
execution, fallback and cancellation. Five deliberate behavioral mutations were
rejected by assertions; production files were restored. Receipts are in
`call-analysis-mutation-proof.json`.

Real Baidu adapters#setData validation:

| Measurement | Result |
|---|---:|
| Same-name call candidates | 54 |
| Caller methods analyzed | 49 |
| Prepared instructions | 6,282 |
| Total serialized method payload | 523,158 bytes |
| Resolved / possible / unresolved / excluded | 0 / 0 / 54 / 0 |
| Preparation issues retained as Unknown | 19 |

**This has not reached accurate caller recovery for this real target.** It
correctly avoids claiming all 54 name matches are calls to DataSourceAdapter.
Clipboard examples retain pasteboard provenance; IconOnlyActionBar retains its
own method-table candidate. The remaining lack of cross-method heap, closure,
constructor and API-effect models prevents stronger conclusions. Passing the
fixture suite is not evidence of 100% real-application precision or recall.

One Node measurement (not a browser-wide performance guarantee): parse/index
8,680 ms, preparation 58.5 ms, serial interpretation 20.4 ms, cold two-worker
interpretation 44.3 ms, warm two-worker interpretation 10.6 ms. Serial and both
parallel runs produce identical ordered outcomes. The UI automatically uses
serial execution for this 6,282-instruction workload. Index construction is still
the main cost; parallel call interpretation does not accelerate that phase.

Raw measurements and independently checked counterexamples are in
`baidu-call-analysis-validation.json`. Reproduce from the monorepo root:

```sh
node --max-old-space-size=8192 --import tsx \
  packages/xpanda-workbench/scripts/validate-call-analysis.mjs /path/to/baidu.abc
```

The small JS/ABC fixtures live under `test/fixtures/`; source comments document
the SDK compiler commands. Fixture method offsets are intentionally tied to the
committed binaries. Recompiling with another SDK requires rechecking identities.
