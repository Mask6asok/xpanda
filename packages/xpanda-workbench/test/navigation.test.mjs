import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AnalysisEngine } from "../src/analysis/engine.ts";
import { querySymbolReferences } from "../src/analysis/xrefs.ts";

function example() {
    const engine = new AnalysisEngine();
    const bytes = readFileSync(new URL("../public/samples/class.abc", import.meta.url));
    const [source] = engine.load({ name: "class.abc", bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), lenient: false }, () => {});
    return { engine, record: source.records[0] };
}

test("property-call navigation selects the call expression instead of the same-name method declaration", async () => {
    const { engine, record } = example();
    const page = await engine.references({ recordId: record.id, symbol: "test", group: "calls", offset: 0 }, () => {});
    assert.equal(page.references.calls.count, 1);
    const result = engine.locate({ recordId: record.id, view: "readable", site: page.references.calls.sites[0] });
    assert.deepEqual(result.locations.map((location) => location.line), [15]);
});

test("bytecode navigation resolves the actual caller method and instruction PC", async () => {
    const { engine, record } = example();
    const page = await engine.references({ recordId: record.id, symbol: "test", group: "calls", offset: 0 }, () => {});
    const call = page.references.calls.sites[0];
    const document = engine.open({ recordId: record.id, view: "bytecode", methodOffset: call.sourceMethodOffset });
    assert.equal(document.methodOffset, 375);
    const row = document.pcLines.find((line) => line.pc === 80);
    assert.ok(row);
    assert.match(document.text.split("\n")[row.line - 1], /^0x000050\s+callthis0/);
});

test("same-name registrations page independently from the selected method's registration", () => {
    const methods = Array.from({ length: 206 }, (_, index) => ({ key: `m${index}`, name: "purge", record: `Lrecord${index};`, classOffset: 10 + index, methodOffset: 1000 + index }));
    const sites = methods.flatMap((method, index) => {
        const base = { sourceClassOffset: method.classOffset, sourceRecord: method.record, sourceMethodOffset: 3000 + index, sourceMethod: "func_main_0", instructionIndex: 0, pc: 0, block: "entry", opcode: "defineclasswithbuffer", resolution: "exact_operand", targetName: "purge" };
        return [
            { ...base, id: `method${index}`, relation: "literal_method", operandPath: "literal[1]", targetKind: "method", targetOffset: method.methodOffset },
            { ...base, id: `string${index}`, relation: "literal_string", operandPath: "literal[0]", targetKind: "string", targetOffset: 900 },
        ];
    });
    const index = { methods, sites, targets: [{ key: "string:900", kind: "string", name: "purge", offset: 900, record: null, classOffset: null }], scannedMethods: 206, failedMethods: 0 };
    const pages = [0, 100, 200].map((offset) => querySymbolReferences(index, { symbol: "purge", classOffset: 10, page: { group: "sameNameDefinitions", offset, limit: 100 } }));
    assert.deepEqual(pages.map((page) => page.sameNameDefinitions.sites.length), [100, 100, 5]);
    assert.deepEqual(pages.flatMap((page) => page.sameNameDefinitions.sites.map((site) => site.sourceClassOffset)), Array.from({ length: 205 }, (_, i) => 11 + i));
    assert.ok(pages.every((page) => page.definitions.count === 1 && page.sameNameDefinitions.count === 205 && page.definitions.sites.length === 0));
});
