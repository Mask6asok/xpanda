# Validation, 2026-11-06

## Automated and real-input checks

- Strict UI type checking passes (core declarations are generated under core's own settings).
- Production Vite build passes; no runtime imports from `xpanda-web`.
- Three navigation/paging regression tests pass. Each was also run against a temporary
  behavioral mutation and failed for the expected reason; production files were restored.
- Actual `class.abc`: the `test` property call matches displayed JS line 15, excluding
  its same-name declaration. Caller bytecode resolves method 375 and PC 80.
- Actual `zhihupp0.59.hap`: one ABC, 276 records, directory paths and module metadata
  retained in record details.
- Actual Baidu ABC (78,219,428 bytes): 13,251 records; reference index scanned 233,522
  methods and 3,567,581 sites, with zero failed methods. This large-input check ran
  through the same analysis engine in Node, not through browser file upload.
- `performWithBlock`: 1 name-based call candidate, 1 current registration, 0 other
  same-name registrations. Caller is AFServiceCenter; JS expression line 86; call PC 665.
- `purgeVariableDependenciesOnElmtId` in CaptchaViewManager: 1 current registration,
  1969 other same-name registrations. Two 100-row pages contain no repeated sites.
  The first page's serialized response was approximately 51 KB.
- All 31 original `xpanda-web` files match the SHA-256 baseline taken before this task.

## Browser self-review

The real bundled ABC was opened through the application UI, exercising the actual
browser Worker in both the development app and production build.

Verified: readable and unoptimized output, record details, JS outline, Shift+F12,
reference grouping, JS-expression matching, exact bytecode PC navigation, back
navigation restoring selection/scroll, file search and the mobile navigator overlay.
Desktop (1440 x 900) and narrow (390 x 844) light/dark layouts were inspected. Page
bounds matched viewport bounds; code scrolling stayed inside the native editor.
The old application was not used as a runtime dependency or a target of UI edits.

## Manual acceptance path

1. Run `npm run workbench` from the monorepo root; open port 5174.
2. Open the bundled example, choose `Test.test` in the outline and place the caret
   inside its name. Press Shift+F12.
3. Choose the call row: the editor selects `new Test().test()` at line 15.
4. Choose its PC action: the caller's bytecode opens on `callthis0` at PC 0x50.
5. For a larger file, use the path filter to locate AFServiceTask or CaptchaViewManager;
   use the current registration and other same-name tabs to compare their counts.

## Known limits

Reference indexing is per ABC. Property-call candidates use names, without resolving
receiver types; the adjacency rule is conservative and does not form a complete
call graph. JS navigation is an AST match, not a PC source map. Ambiguity is exposed
as selectable line candidates; bytecode provides exact PC positioning. Browser
large-file memory remains dependent on core parsing/index size. A reset terminates
the analysis Worker. Files and reference indexes are not persisted across reloads.


## Call-target analysis follow-up

See `docs/CALL-ANALYSIS.md` and its raw validation JSON. Type checking, production
build and 16 regression tests pass. Five behavior mutations were rejected.
Browser checks on the production build exercised the new analysis action,
completed status, empty/resolved and unresolved filters, provenance disclosure,
bytecode PC navigation, query-switch isolation, close/reset behavior and a dark
390 x 844 layout. The latter had page bounds 390 x 844 and independent code and
reference scrollers. No browser console errors were recorded. The real Baidu
analysis used Node, not browser upload. Its 54 candidates remain unresolved;
this is not a claim of recovered actual callers or perfect precision/recall.
