import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PandaFile } from "xpanda-core";
import { analyzeCallUnit } from "../src/analysis/call-resolution/interpreter.ts";
import { prepareCallAnalysis } from "../src/analysis/call-resolution/prepare.ts";
import { methodSymbol } from "../src/analysis/xrefs.ts";

const instruction = (pc, op, extra = {}) => ({ pc, op, opcode: op, ...extra });
const block = (id, instructions, successors = []) => ({ id, instructions, successors });
const unit = (blocks, extra = {}) => ({ sourceMethodOffset: 1, selectedMethodOffsets: [42], sites: [{ siteId: "call", pc: 9 }], blocks, classes: [], issues: [], maxSteps: 1000, ...extra });

test("callee register aliases resolve identity and exclude a different selected method", () => {
    for (const [methodId, relation] of [[42, "resolved"], [7, "excluded"]]) {
        const result = analyzeCallUnit(unit([block(0, [instruction(0, "function", { methodId }), instruction(1, "copy", { src: "acc", dest: "v0" }), instruction(2, "constant"), instruction(3, "copy", { src: "v0", dest: "acc" }), instruction(9, "call")])]))[0];
        assert.equal(result.relation, relation);
        assert.deepEqual(result.possibleMethodIds, [methodId]);
        assert.equal(result.hasUnknown, false);
    }
});

test("a known function merged with an unknown branch never becomes a resolved singleton", () => {
    const result = analyzeCallUnit(unit([
        block(0, [], [1, 2]), block(1, [instruction(1, "function", { methodId: 42 })], [3]),
        block(2, [instruction(2, "unknown")], [3]), block(3, [instruction(9, "call")]),
    ]))[0];
    assert.equal(result.relation, "possible"); assert.equal(result.hasUnknown, true); assert.deepEqual(result.possibleMethodIds, [42]);
});

test("unsupported instructions, incomplete exception coverage and exhausted budgets retain unknown", () => {
    const start = [instruction(0, "function", { methodId: 42 }), instruction(9, "call")];
    const cases = [
        unit([block(0, [start[0], instruction(1, "unknown", { opcode: "future.opcode" }), start[1]])]),
        unit([block(0, start)], { issues: ["Exception paths unmodeled"] }),
        unit([block(0, start, [0])], { maxSteps: 2 }),
    ];
    for (const input of cases) { const result = analyzeCallUnit(input)[0]; assert.equal(result.hasUnknown, true); assert.notEqual(result.relation, "resolved"); assert.notEqual(result.relation, "excluded"); }
});

test("a truncated target set cannot claim a complete call target", () => {
    const branches = Array.from({ length: 40 }, (_, index) => block(index + 1, [instruction(index + 1, "function", { methodId: 100 + index })], [100]));
    const result = analyzeCallUnit(unit([block(0, [], branches.map(b => b.id)), ...branches, block(100, [instruction(9, "call")])], { selectedMethodOffsets: [100] }))[0];
    assert.equal(result.hasUnknown, true); assert.notEqual(result.relation, "resolved");
});

const file = new PandaFile(new Uint8Array(readFileSync(new URL("./fixtures/call-resolution.abc", import.meta.url))));
const methods = [...new Map(file.getAllClasses().flatMap(record => [...record.pandaMethods.values()].map(method => [method.getOffset(), method]))).values()];
function method(name) { const found = methods.find(value => methodSymbol(value.name.content) === name); assert.ok(found, name); return found; }
function callSites(caller) {
    return caller.disAssemble().pandaIRBasicBlocks.flatMap(b => b.pandaInstructions).filter(ins => ins.kind === "call").map(ins => ({ id: `${caller.getOffset()}:${ins.pc}`, sourceClassOffset: caller.getParent().getOffset(), sourceRecord: caller.getParent().name.content, sourceMethodOffset: caller.getOffset(), sourceMethod: caller.name.content, instructionIndex: 0, pc: ins.pc, callPc: ins.pc, block: "fixture", opcode: ins.opcode.name, operandPath: "$call", relation: "dynamic_call", resolution: "unresolved_dynamic", targetKind: null, targetOffset: null, targetName: null }));
}

test("real SDK bytecode distinguishes homonymous class methods without claiming mutable property certainty", () => {
    const caller = method("homonyms");
    const plan = prepareCallAnalysis(file, callSites(caller), [739]);
    const results = plan.units.flatMap(analyzeCallUnit);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(row => row.possibleMethodIds), [[739], [1381]]);
    assert.deepEqual(results.map(row => row.relation), ["possible", "unresolved"]);
});

test("real SDK fixtures keep indirect aliases and inheritance overrides as distinct candidates", () => {
    for (const [name, expected] of [["aliases", 1354], ["override", 1543]]) {
        const caller = method(name);
        const result = prepareCallAnalysis(file, callSites(caller), [expected]).units.flatMap(analyzeCallUnit);
        assert.equal(result.length, 1, name);
        assert.deepEqual(result[0].possibleMethodIds, [expected], name);
        assert.equal(result[0].relation, "possible", name);
    }
});

test("real parameter, return, closure, overwrite, side-effect and exception cases cannot claim exact targets", () => {
    const cases = [["parameter", 1], ["returned", 2], ["captured", 1], ["overwrite", 1], ["sideEffect", 2], ["exception", 1], ["mixedBranch", 1]];
    const targets = methods.filter(candidate => methodSymbol(candidate.name.content) === "hit").map(candidate => candidate.getOffset());
    for (const [name, count] of cases) {
        let caller = method(name);
        if (name === "captured") {
            const nested = caller.disAssemble().pandaIRBasicBlocks.flatMap(block => block.pandaInstructions).find(ins => ins.kind === "defineFunc")?.func;
            assert.ok(nested, "captured closure has a function definition");
            caller = nested;
        }
        const results = prepareCallAnalysis(file, callSites(caller), targets).units.flatMap(analyzeCallUnit);
        assert.equal(results.length, count, name);
        assert.ok(results.every(row => row.relation !== "resolved" && row.relation !== "excluded"), name);
    }
});

test("accumulator-only unknown values preserve independent function aliases, while accumulator-writing heap operations kill the old callee", () => {
    const saved = analyzeCallUnit(unit([block(0, [instruction(0, "function", { methodId: 42 }), instruction(1, "copy", { src: "acc", dest: "v0" }), instruction(2, "opaque"), instruction(3, "copy", { src: "v0", dest: "acc" }), instruction(9, "call")])]))[0];
    assert.equal(saved.relation, "resolved");
    const killed = analyzeCallUnit(unit([block(0, [instruction(0, "function", { methodId: 42 }), instruction(1, "write", { dest: "acc" }), instruction(9, "call")])]))[0];
    assert.equal(killed.relation, "unresolved"); assert.equal(killed.hasUnknown, true);
});

test("merged SDK module maps this-call to its declaring class while retaining rebinding uncertainty", () => {
    const ownerFile = new PandaFile(new Uint8Array(readFileSync(new URL("./fixtures/call-owner.abc", import.meta.url))));
    const caller = ownerFile.getAllClasses().flatMap(record => [...record.pandaMethods.values()]).find(candidate => candidate.getOffset() === 397);
    assert.ok(caller);
    for (const [selected, relation] of [[424, "possible"], [479, "unresolved"]]) {
        const results = prepareCallAnalysis(ownerFile, callSites(caller), [selected]).units.flatMap(analyzeCallUnit);
        assert.equal(results.length, 1);
        assert.deepEqual(results[0].possibleMethodIds, [424]);
        assert.equal(results[0].relation, relation);
        assert.equal(results[0].hasUnknown, true);
    }
});
