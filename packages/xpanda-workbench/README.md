# xpanda Workbench

Independent, read-only browser UI powered by `xpanda-core`. The existing
`packages/xpanda-web` application is not imported or modified. Workbench runs on
its own port and keeps its own UI preferences.

## Run

From the monorepo root:

```sh
npm run workbench
```

Open **http://127.0.0.1:5174/**. The original Web application retains port 5173.
Use **Open example** to load the repository's real `class.abc` fixture, or open
an ABC / HAP file. Archive import reads all contained ABC entries and preserves
`module.json` in Record information. Files are processed locally in the browser.
If dependencies are missing, install them with the repository's usual
`yarn install` first, then use `yarn workspace xpanda-workbench dev`.

## Reading and navigation

- Nested directory tree and path filtering; actual JS declarations in a separate outline.
- Multiple document tabs; back/forward restores view, selection and scroll position.
- Readable JS, unoptimized JS, method-level bytecode and record metadata.
- **F12** or **Ctrl/Cmd click**: local JS declaration, or an explicit method-candidate picker.
- **Shift+F12**: references for the caret's symbol in a persistent bottom dock.
- **Ctrl/Cmd+F**: find in the displayed document.
- **Ctrl/Cmd+Shift+F**: global source/path search; navigating a result retains the search field and results.
- Reference path: match the expression in the caller's displayed JS.
- Reference **PC**: open the caller's bytecode method at the exact instruction.
- Copy/download current output; adjustable navigation and reference panels; light/dark themes.

## Reference semantics and limits

References are indexed within the selected ABC, not across different ABC entries.
The dock stays anchored to its original file and symbol when a caller is opened.
It separates name-based call candidates, the current method's registration,
other same-name registrations, and other operand uses. Dynamic receiver types
are not resolved. A shared string operand is not proof of method identity.

JS locations are AST expression/declaration matches in the displayed output;
there is no PC-to-optimized-JS source map. Ambiguous matches remain selectable
candidates. Exact PC positioning is available in bytecode. The calls group
currently recognizes a named property load immediately followed by a call in
the same basic block, so it is conservative and is not a complete call graph.

The Worker owns parsed files and the full index. Only the current output and
bounded reference pages (100 rows) cross the Worker boundary. One ABC's reference
index is retained at a time; changing ABC may rebuild it. Documents use a bounded
Worker cache. Large ABCs can still need substantial browser memory. Resetting
the workspace terminates the Worker and releases its analysis state. Importing
new files and switching output are read-only; refreshing does not persist files.

## Checks and production build

```sh
npm run typecheck --workspace=xpanda-workbench
npm run test --workspace=xpanda-workbench
npm run build --workspace=xpanda-workbench
npm run preview --workspace=xpanda-workbench
```

Preview uses port 4174. Type checking first generates local declarations using
core's existing compiler settings, then checks the new UI with strict TypeScript.
Those generated declarations are only a checking boundary; Vite bundles the real
`xpanda-core` package at runtime. No generated declarations are committed.

The small bundled fixture comes from `xpanda-core/test/resources/class.abc` and
is covered by the repository's license. Navigation/index helpers were adapted
into this package so their UI evolution does not affect the original Web app.

## Call-target analysis

The same-name call candidates tab has an explicit analysis action, status filters
and per-call provenance/evidence. Small workloads run serially; larger workloads
use at most two compact subworkers. This is a bounded, conservative value-flow
analysis, not a complete interprocedural call graph. Its actual Baidu validation
has 54 unresolved candidates and zero proven targets; do not interpret that as
zero real callers. See [CALL-ANALYSIS.md](docs/CALL-ANALYSIS.md) for scope,
reproducible accuracy checks, limitations and serial/parallel measurements.

## Reference index construction

The first reference query builds a reusable index for the selected ABC, covering
all methods. Subsequent method queries and pagination reuse it. At 2,000 coded
methods or more, two decoder subworkers process batches of at most 256 methods
and 128 KiB of bytecode. Smaller inputs run serially. Entity resolution and the
full index stay in the owning analysis Worker; subworkers receive neither a
PandaFile object graph nor a full ABC copy. Decoded rows return as transferred
numeric buffers, and batches merge in original order. Decoder failures use the
original CFG scanner. Unsupported or oversized methods also use that scanner.
Workers terminate after construction. Concurrent requests share the build.
The status bar reports the construction mode and original build duration.

The Baidu validation compares every ordered method, target and site against the
original scanner with SHA-256, as well as the three known reference queries.
Run the three modes in separate processes to avoid retaining multiple full
indexes in memory (Node timings are not a browser performance guarantee):

```sh
node --max-old-space-size=8192 --import tsx packages/xpanda-workbench/scripts/validate-xref-index.mjs /path/to/file.abc legacy
node --max-old-space-size=8192 --import tsx packages/xpanda-workbench/scripts/validate-xref-index.mjs /path/to/file.abc serial
node --max-old-space-size=8192 --import tsx packages/xpanda-workbench/scripts/validate-xref-index.mjs /path/to/file.abc parallel
```

See [xref-index-validation.json](docs/xref-index-validation.json) for measured
results. The development-only `/test/browser-xrefs.html` page validates the real
analysis Worker and two browser subworkers using the bundled HAP fixture.
