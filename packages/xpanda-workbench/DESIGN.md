# xpanda Workbench

Independent UI; the existing xpanda-web source and configuration are protected from edits.
Reference: the local ArkReverse design analysis, used for IDE structure and honest precision labels,
not a pixel clone or a claim that all six reference views have been implemented.

## Task and content

Primary action: open a record, read its implementation, and follow a symbol.
Priorities: file/class/method identity; readable code and its current position; reference evidence.
Required: ABC/HAP loading, real nested directories, JS class/function outline, multiple tabs,
back/forward with selections and scroll, readable/raw JS, method bytecode, entity details,
scoped reference groups with paging, precision/status, copy/download, theme and pane resizing.
Avoid decorative dashboards, fabricated call graphs, unsupported view tabs, or simulated results.

## Layout

Layout: adjustable sidebar + editor with a bottom references dock. The file tree and method outline
have separate named scroll regions; the native readonly editor owns code scrolling; the reference
list owns its dock scroll. Toolbar, breadcrumbs, view tabs and status bar stay outside scrollers.
Below 800px the file navigator becomes a dismissible overlay and toolbar controls condense.

## Visual system

Quiet desktop tool: cool neutral surfaces, blue focus and selection, one SVG stroke icon family.
Light and dark themes; system is the initial preference. UI 13px, code 13px/21px; native browser zoom remains available.
Spacing 4/8/12/16/24px; control radius 4px, floating panel radius 8px, neutral 1px borders.
A view communicates two separate facts: relation certainty and location precision.

## Analysis contract

Only xpanda-core is shared at runtime. Browser adapters are an independent snapshot of the
existing scanner/navigation helpers so this package does not import or change xpanda-web internals.
All heavy analysis runs in a Worker. ABC bytes are transferred, and full reference indexes never
cross the worker boundary. Reference results are paged; same-name registrations are separate.
JS jumps are expression/declaration matches. Only the bytecode view promises an exact PC row.
A bundled tiny ABC example comes from the repository test fixture and is labeled as an example.
