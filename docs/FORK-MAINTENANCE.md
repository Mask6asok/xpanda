# Maintaining the persistent-index fork

Upstream: `https://github.com/asmjmp0/xpanda.git`.
Intended fork: `https://github.com/Mask6asok/xpanda`.
Patch base: `98ba0261cbffb29567837f48e3cfe464baafc3ae` (core 2.42.0).
The index feature adds `packages/xpanda-index`, four browser-safe public core exports,
workspace scripts, documentation and a core/root minor-version bump to 2.43.0.

Keep `main` as the upstream mirror and maintain additions on `persistent-code-index`.
The feature branch can be merged with upstream without modifying or replacing the parser,
optimizer, original CLI or original live MCP server. No app dumps or analysis sessions belong here.

After cloning the fork:

```sh
git remote add upstream https://github.com/asmjmp0/xpanda.git
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch persistent-code-index
git merge main
```

Start with a clean working tree. Resolve conflicts on the feature branch, particularly
workspace/package versions and core public exports. Normal merges preserve published
history; no force push or automatic rebase is required.

Install dependencies, then run the tests in
[xpanda-index/README.md](../packages/xpanda-index/README.md#tests) and the original repository
tests relevant to any upstream parser/optimizer changes. Existing package managers can also
use the root `test:index` script. Tests are intentionally separate from the original Node 18
default test command because the optional index requires `node:sqlite`.

Inspect representative method/string references after an upstream upgrade. Opcode kinds,
operand object types, CFG block structure and literal arrays are the compatibility boundary.
Unexpected resolved operand types stop publication; disassembly failures are recorded in
method diagnostics and counts. New dynamic call kinds require an explicit classification
update and a test. Preserve unresolved results instead of guessing targets from names.

Rebuild indexes to use a newer core. Database metadata records `xpanda_version`,
`indexer_version`, schema version and input/inventory hashes. Source text in session mode
comes from the existing inventory; regenerate the session when new high-level decompilation
is needed. Old v1/v2 databases remain readable and are not silently rewritten.

Before committing, follow `AGENTS.md` version rules. Keep SQLite/Node imports inside the
index workspace, use only `xpanda-core` public imports, and leave generated opcodes untouched.

## Browser and MCP entry points

`packages/xpanda-index/src/unified-mcp.mjs` exposes 20 tools: the original ten
live decompiler tools plus the ten persistent `code_index_*` queries. Its
`--read-only` mode exposes only the index queries. The analyzer integration's
`hap_prepare` and `hap_prepare_status` belong to the separate
`Harmony_Hap_Analyzer` project and are not bundled by this repository.

`packages/xpanda-workbench` is an independent browser application, registered
with the root `workbench` script on port 5174. It imports the core package rather
than the original Web application. The earlier original-Web reference/navigation
work remains in `packages/xpanda-web` on port 5173. Neither application deploys
a hosted site when its source is pushed.

Workbench validation includes global-search/navigation regressions, real worker
threads, a full Baidu index digest comparison, and conservative call-analysis
fixtures. See its README and `docs/` validation records. Build artifacts, generated
core declarations, local databases and application dumps must remain untracked.
