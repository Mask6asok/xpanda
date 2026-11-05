# xpanda-index

Persistent SQLite navigation for HarmonyOS ABC/HAP files, with exact operand cross references
and a read-only stdio MCP server. This workspace consumes the public `xpanda-core` entry;
SQLite and filesystem operations stay outside the browser-safe core.

The original `xpanda-mcp` server remains available for live decompilation. This server queries
persisted indexes and keeps its ten `code_index_*` tool names stable for existing clients.
For one connection containing both original live tools and index tools, use:

```sh
node packages/xpanda-index/src/unified-mcp.mjs --root /path/analysis-sessions
```

This exposes all twenty existing tools without renaming them. Pass `--read-only` to
expose only the ten index tools; no live loading, decompilation or export is registered.
`--database` and response budgets work as on the index-only server. Live `fileId`
sessions and persisted `index_id` values have separate identities. Exporting JS does
not automatically rebuild a database. The Harmony HAP Analyzer wrapper additionally
registers its existing preparation/indexing workflow when a writable root is configured.

## Runtime and installation

Use Node with `node:sqlite` and FTS5 (Node 22.13+; tested with Node 26.11.0).
The existing core/CLI/web paths retain their own runtime requirements. Index tests are a
separate command, and database tests skip when `node:sqlite` is unavailable.

```sh
yarn install
yarn test:index
```

Direct Node commands also work after installing the repository dependencies. No global
TypeScript runner is needed: the CLI resolves this package's declared `tsx` dependency
only when starting an index build. Query-only processes do not import `xpanda-core`.

## Standalone ABC or HAP

From the xpanda repository:

```sh
node packages/xpanda-index/src/code-index.mjs build app.hap --database /path/app.db
node packages/xpanda-index/src/code-index.mjs stats /path/app.db
node packages/xpanda-index/src/code-index.mjs methods /path/app.db onCreate --limit 5
node packages/xpanda-index/src/code-index.mjs strings /path/app.db https --limit 5
```

ABC, HAP and HSP inputs are supported. Without `--database`, a standalone build writes
`INPUT.index.db` beside the input file. The input is read as a frozen byte buffer and
its SHA-256 and individual ABC hashes are stored in the database.

A standalone build indexes bytecode, strings and references; it does not run the high-level
decompiler. Source tables remain empty and metadata reports `source_mode=not_provided`.

## Existing analysis sessions

```sh
node packages/xpanda-index/src/code-index.mjs build /path/SESSION
node packages/xpanda-index/src/code-index.mjs search /path/SESSION startAbility
```

The session adapter accepts the existing Harmony HAP Analyzer layout: `inventory.json`,
`input/app.abc` or `input/app.hap`, and inventoried source files. It verifies input, ABC,
source and final inventory hashes before publishing `SESSION/indexes/code-index.db`.
Source `files` carry `file`, `record`, `sha256`, optional `diagnostics` and method line ranges;
`abcEntries` carry `entry` and `sha256`. Source paths must resolve inside the session.

Rebuilding uses a transaction and temporary database, closes it, then atomically replaces
the published file. A failed build preserves the last successful database. Session staging
stays under `runtime`, outside snapshot inputs. Staging and destination must share a filesystem.

Upgrading xpanda does not regenerate old JS files. Re-run the original preparation/decompilation
step when updated source text is required; `build` refreshes disassembly using the current core.

## Cross references and method navigation

Use `methods` or `strings` to obtain an ABC `entry` and entity `offset`:

```sh
node packages/xpanda-index/src/code-index.mjs xrefs /path/app.db method TARGET_OFFSET --entry ets/modules.abc
node packages/xpanda-index/src/code-index.mjs xrefs /path/app.db string TARGET_OFFSET --entry ets/modules.abc
node packages/xpanda-index/src/code-index.mjs uses /path/app.db --entry ets/modules.abc \
  --class-offset CLASS_OFFSET --method-offset METHOD_OFFSET
```

`xrefs` lists incoming reference sites. `uses` lists a method's outgoing operands and
unresolved dynamic call sites. Names are search labels; identity is ABC entry, entity kind
and original byte offset. Distinct sites are preserved even when they share a target.

Results include source class/method identity, method-relative byte `pc`, `opcode`, block,
`operand_path`, relation, resolution, target identity and ABC SHA-256. Read the source method
with `method RECORD NAME --entry ENTRY --class-offset CLASS --method-offset METHOD`, setting
pagination `--offset` to the reference's `instruction_index` for the matching instruction.
PC is relative to the instruction area; the CodeItem header offset cannot simply be added to PC.

| Relation | Meaning |
| --- | --- |
| `function_definition` | Function/method definition operand |
| `class_constructor` | Constructor operand of a class definition |
| `method_reference` | Other method-ID operand |
| `string_operand`, `field_operand`, `type_operand` | Corresponding instruction ID |
| `literal_array_operand`, `nested_literal_array` | Literal object graph references |
| `literal_method`, `literal_string`, `literal_field` | Entities reached through literal objects |
| `dynamic_call` | Dynamic call/supercall/new site; target unresolved |
| `runtime_intrinsic` | Runtime intrinsic operation |

`exact_operand` proves an entity reference, not a runtime dispatch target. Definitions are
not calls; property-name strings are not matched to same-named methods. Dynamic calls use
`unresolved_dynamic` and a null target. Unresolved IDs use `unresolved_operand`. TYPE IDs
currently inherit the core parser's unresolved-type limitation.

Coverage is limited to successfully disassembled instructions and reachable literal objects.
Each literal array is expanded once per top-level operand to terminate cycles. Register/lexical
dataflow, cross-ABC linking, reflection, dynamic import targets, class inheritance and annotation
dependency graphs are not analyzed. `call_graph=not_built`; zero hits do not prove absence.
Source method ranges are candidates, not exact bytecode-to-JS mappings.

The approach follows JADX's structured operand scan and forward/reverse usage sets:
[UsageInfoVisitor](https://github.com/skylot/jadx/blob/master/jadx-core/src/main/java/jadx/core/dex/visitors/usage/UsageInfoVisitor.java)
and [UsageInfo](https://github.com/skylot/jadx/blob/master/jadx-core/src/main/java/jadx/core/dex/visitors/usage/UsageInfo.java).

## Read-only MCP

```json
{
  "mcpServers": {
    "xpanda-index": {
      "command": "node",
      "args": [
        "/path/xpanda/packages/xpanda-index/src/code-index-mcp.mjs",
        "--database", "/path/app.db"
      ]
    }
  }
}
```

Repeat `--database` to allow multiple files, or pass `--root /path/analysis-sessions` to
scan immediate child `indexes/code-index.db` files. With no arguments, the root is
`.hap-sec-analysis` in the process working directory. Root scans exclude symlink escapes
and do not recurse into snapshots. Existing workbench wrappers preserve their former default root.

| Tool | Purpose |
| --- | --- |
| `code_index_list` | Allowed index IDs and freshness |
| `code_index_stats` | Counts, producer versions and analysis limits |
| `code_index_classes` / `code_index_methods` | Substring lookup |
| `code_index_strings` | Parsed string lookup |
| `code_index_search` | Literal FTS5 source phrase lookup |
| `code_index_method` | Paginated method disassembly |
| `code_index_source` | Stored source lines |
| `code_index_xrefs` / `code_index_uses` | Incoming/outgoing references |

Queries use allowlisted index IDs, parameterized SQL and read-only database connections.
There is no arbitrary SQL, shell, filesystem-read or build tool. The service serializes
requests around its four-connection LRU cache and reopens atomically replaced databases.
Session inventory hashes are checked; offline standalone databases are labeled `offline`.
The producer version is recorded, but changing the installed core does not automatically
invalidate/rebuild an existing database.

Pages default to 30 items, maximum 200. `offset` is a zero-based pagination position;
`target_offset` and `method_offset` are entity byte offsets. Use returned `next_offset`;
`--max-output-chars` controls the JSON response budget (default 65,536). Errors remain
recoverable within the same connection. v1 databases retain old queries; xrefs/uses require v2.

## Tests

```sh
node --import tsx --test packages/xpanda-index/test/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit -p packages/xpanda-core/tsconfig.json
node --import tsx packages/xpanda-core/test/decompile.test.ts
node --import tsx packages/xpanda-core/test/assembler.test.ts
```

Tests use repository fixtures and synthetic SQLite data, including real SDK stdio clients.
They cover standalone ABC/HAP builds, source/inventory integrity, atomic failure recovery,
exact references, dynamic-call limits, cyclic literals, old schemas, pagination, response
budgets, connection replacement and concurrent requests beyond the LRU capacity.
