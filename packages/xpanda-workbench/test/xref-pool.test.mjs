import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PandaFile, HapFile } from "xpanda-core";
import { buildXrefIndex } from "../src/analysis/xref-builder.ts";
import { buildParallelXrefIndex } from "../src/analysis/xref-pool.ts";
import { nodeXrefWorkers } from "../scripts/node-xref-workers.mjs";
import { AnalysisEngine } from "../src/analysis/engine.ts";
const fixture = name => new PandaFile(new Uint8Array(readFileSync(new URL(`../../xpanda-core/test/resources/${name}.abc`, import.meta.url))));
const comparable = ({ execution, ...index }) => index;

test("index-only decoding preserves every field of the original CFG index on real ABC and HAP fixtures", async () => {
    const hap = new HapFile(new Uint8Array(readFileSync(new URL("../../xpanda-core/test/resources/zhihupp0.59.hap", import.meta.url))));
    const files = [fixture("class"), fixture("md5"), fixture("aes"), ...hap.getAbcEntries().map(entry => new PandaFile(hap.zip.readEntry(entry)))];
    for (const file of files) {
        const baseline = buildXrefIndex(file, () => {});
        const result = await buildParallelXrefIndex(file, () => {}, { workerFactory: null });
        assert.deepEqual(comparable(result), baseline);
    }
});

test("actual decoder threads return deterministic indexes and transfer only bounded bytecode batches", async () => {
    const hap = new HapFile(new Uint8Array(readFileSync(new URL("../../xpanda-core/test/resources/zhihupp0.59.hap", import.meta.url))));
    const file = new PandaFile(hap.zip.readEntry(hap.getAbcEntries()[0]));
    const originalBytes = file.data.slice();
    const baseline = buildXrefIndex(file, () => {});
    const { factory, stats } = nodeXrefWorkers();
    const progress = [];
    const result = await buildParallelXrefIndex(file, (done, total) => progress.push([done, total]), { workerFactory: factory, minParallelMethods: 0 });
    assert.deepEqual(comparable(result), baseline);
    assert.deepEqual(file.data, originalBytes, "The owning ABC buffer must not be detached or changed");
    assert.equal(stats.created, 2);
    assert.equal(stats.maxInFlight, 2);
    assert.ok(stats.maxInputBytes <= 128 * 1024);
    assert.deepEqual(stats.errors, []);
    assert.deepEqual(progress.at(-1), [baseline.scannedMethods, baseline.scannedMethods]);
    assert.equal(result.execution.mode, "parallel");
});

test("decoder startup and transport failures fall back without losing or inventing sites", async () => {
    for (const factory of [() => { throw new Error("startup blocked"); }, () => ({ onmessage: null, onerror: null, onmessageerror: null, postMessage() { throw new Error("cannot clone"); }, terminate() {} })]) {
        const file = fixture("class");
        const result = await buildParallelXrefIndex(file, () => {}, { workerFactory: factory, minParallelMethods: 0 });
        assert.deepEqual(comparable(result), buildXrefIndex(file, () => {}));
        assert.equal(result.execution.mode, "fallback");
    }
});

test("malformed method decoding uses the original scanner's failure result", async () => {
    const file = fixture("class");
    const method = file.getAllClasses().flatMap(clazz => [...clazz.pandaMethods.values()]).find(method => method.methodCode);
    method.methodCode.instructions = new Uint8Array([0xff]);
    const result = await buildParallelXrefIndex(file, () => {}, { workerFactory: null });
    assert.deepEqual(comparable(result), buildXrefIndex(file, () => {}));
    assert.ok(result.execution.fallbackMethods > 0);
    assert.ok(result.failedMethods > 0);
});

test("simultaneous reference queries share one build and later queries reuse the same index", async () => {
    const engine = new AnalysisEngine();
    const bytes = readFileSync(new URL("../public/samples/class.abc", import.meta.url));
    const [source] = engine.load({ name: "class.abc", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), lenient: false }, () => {});
    const request = { recordId: source.records[0].id, symbol: "test", group: "calls", offset: 0 };
    let progress = 0;
    const [a, b] = await Promise.all([engine.references(request, () => progress++), engine.references(request, () => progress++)]);
    assert.equal(progress, 1);
    assert.deepEqual(a, b);
    assert.equal(a.references.calls.count, 1);
    await engine.references(request, () => { throw new Error("Index was rebuilt"); });
});


test("interleaved ABC requests never start duplicate builds or return a displaced source's index", async () => {
    const engine = new AnalysisEngine();
    const bytes = readFileSync(new URL("../public/samples/class.abc", import.meta.url));
    const load = () => engine.load({ name: "class.abc", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), lenient: false }, () => {})[0];
    const [a, b] = [load(), load()];
    let builds = 0;
    const request = source => engine.references({ recordId: source.records[0].id, symbol: "test", group: "calls", offset: 0 }, () => builds++);
    const pages = await Promise.all([request(a), request(b), request(a)]);
    assert.equal(builds, 2);
    assert.ok(pages.every(page => page.references.calls.count === 1));
});
