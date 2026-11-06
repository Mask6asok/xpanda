import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GlobalSearch } from "../src/analysis/global-search.ts";
import { AnalysisEngine } from "../src/analysis/engine.ts";

const record = (id) => ({ id: `s:${id}`, sourceId: "s", offset: id, name: `Lfile${id};`, path: `dir/file${id}&1.0.0.js` });
const request = (extra = {}) => ({ sessionId: "first", query: "foo", kind: "code", matchCase: true, offset: 0, advance: true, ...extra });
function finish(search, input, records) { let page; do { page = search.search(input, () => records); } while (!page.complete && !page.stopped); return page; }

test("literal code matches preserve exact source line, column and highlight range", () => {
    const search = new GlobalSearch(() => "header\n  foo(); foo();\n  FOO();", () => "sample.abc");
    const page = finish(search, request(), [record(1)]);
    assert.deepEqual(page.rows.map(hit => [hit.line, hit.column, hit.length]), [[2, 3, 3], [2, 10, 3]]);
    assert.ok(page.rows.every(hit => hit.preview.slice(hit.highlightStart, hit.highlightStart + hit.highlightLength) === "foo"));
    const folded = finish(search, request({ sessionId: "second", matchCase: false }), [record(1)]);
    assert.equal(folded.count, 3);
});

test("punctuation is literal and Unicode case matching does not shift source columns", () => {
    const search = new GlobalSearch(() => "İ .* [x] target", () => "sample.abc");
    assert.equal(finish(search, request({ query: ".*" }), [record(1)]).count, 1);
    const page = finish(search, request({ sessionId: "second", query: "TARGET", matchCase: false }), [record(1)]);
    assert.equal(page.rows[0].column, 10);
});

test("metadata path search returns the record identity without decompiling code", () => {
    const search = new GlobalSearch(() => { throw new Error("Unexpected decompilation"); }, () => "sample.abc");
    const page = finish(search, request({ query: "file2", kind: "path" }), [record(1), record(2)]);
    assert.equal(page.count, 1); assert.equal(page.failed, 0); assert.equal(page.rows[0].recordId, "s:2");
});

test("result pagination retains a completed search instead of rescanning documents", () => {
    let reads = 0;
    const search = new GlobalSearch(() => { reads++; return "foo\n".repeat(205); }, () => "sample.abc");
    const first = finish(search, request(), [record(1)]);
    const second = search.search(request({ advance: false, offset: 100 }), () => { throw new Error("Search snapshot should be retained"); });
    const last = search.search(request({ advance: false, offset: 200 }), () => []);
    assert.deepEqual([first.rows.length, second.rows.length, last.rows.length], [100, 100, 5]);
    assert.deepEqual([first.rows[0].line, second.rows[0].line, last.rows[0].line], [1, 101, 201]);
    assert.equal(last.count, 205); assert.equal(reads, 1);
});

test("incremental search stops without losing matches and stale cancellation cannot stop a new query", () => {
    const search = new GlobalSearch(() => "foo bar", () => "sample.abc");
    const records = Array.from({ length: 9 }, (_, i) => record(i));
    const first = search.search(request(), () => records);
    assert.equal(first.complete, false); assert.ok(first.scanned > 0 && first.scanned <= 3);
    search.cancel("first");
    const stopped = search.search(request(), () => records);
    assert.equal(stopped.scanned, first.scanned); assert.equal(stopped.count, first.count); assert.equal(stopped.stopped, true);
    const next = request({ sessionId: "second", query: "bar" });
    search.search(next, () => records); search.cancel("first");
    const done = finish(search, next, records);
    assert.equal(done.stopped, false); assert.equal(done.count, 9); assert.equal(done.query, "bar");
});

test("large result sets are capped and failed files stay explicit", () => {
    const search = new GlobalSearch(entry => { if (entry.offset === 2) throw new Error("Bad record"); return "foo\n".repeat(6000); }, () => "sample.abc");
    const failed = finish(search, request(), [record(2)]);
    assert.equal(failed.failed, 1); assert.equal(failed.count, 0); assert.match(failed.errors[0], /Bad record/);
    const capped = finish(search, request({ sessionId: "capped" }), [record(1)]);
    assert.equal(capped.count, 5000); assert.equal(capped.truncated, true); assert.equal(capped.rows.length, 100);
});

test("real ABC global results retain source identity and match the displayed readable JS", () => {
    const engine = new AnalysisEngine();
    const bytes = readFileSync(new URL("../public/samples/class.abc", import.meta.url));
    const sources = [1, 2].flatMap(() => engine.load({ name: "class.abc", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), lenient: false }, () => {}));
    let page;
    do { page = engine.search(request({ query: "console.log" })); } while (!page.complete);
    assert.equal(page.count, 2);
    assert.deepEqual(page.rows.map(hit => hit.recordId), sources.flatMap(source => source.records.map(record => record.id)));
    assert.deepEqual(page.rows.map(hit => [hit.line, hit.column, hit.length]), [[12, 5, 11], [12, 5, 11]]);
    for (const hit of page.rows) {
        const doc = engine.open({ recordId: hit.recordId, view: "readable" });
        assert.equal(doc.text.split("\n")[hit.line - 1].slice(hit.column - 1, hit.column - 1 + hit.length), "console.log");
    }
});
