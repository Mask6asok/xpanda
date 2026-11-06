import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeCallPool } from "../scripts/node-call-pool.mjs";
import { CallAnalysisCancelled, CallAnalysisPool } from "../src/analysis/call-pool.ts";
import { analyzeCallUnit } from "../src/analysis/call-resolution/interpreter.ts";
const units = Array.from({ length: 12 }, (_, index) => ({ sourceMethodOffset: index, selectedMethodOffsets: [42], sites: [{ siteId: String(index), pc: 1 }], classes: [], issues: [], maxSteps: 100, blocks: [{ id: 0, successors: [], instructions: [{ pc: 0, opcode: "definefunc", op: "function", methodId: index === 0 ? 42 : 100 + index }, { pc: 1, opcode: "callarg0", op: "call" }] }] }));

test("two actual worker threads return the same ordered outcomes as serial interpretation", async () => {
    const { pool, stats } = nodeCallPool();
    try {
        const result = await pool.run(units);
        assert.deepEqual(result, units.flatMap(analyzeCallUnit));
        assert.equal(stats.created, 2); assert.equal(stats.received, 12); assert.equal(stats.posted, 12);
        assert.equal(stats.maxInFlight, 2); assert.deepEqual(stats.errors, []);
        assert.deepEqual(pool.lastExecution, { mode: "parallel", workers: 2 });
    } finally { pool.dispose(); }
});

test("small workloads avoid worker startup while preserving call-target results", async () => {
    let created = 0;
    const pool = new CallAnalysisPool(() => { created++; throw new Error("Worker should not be needed"); });
    try { assert.deepEqual(await pool.run(units), units.flatMap(analyzeCallUnit)); assert.equal(created, 0); assert.equal(pool.lastExecution.mode, "serial"); }
    finally { pool.dispose(); }
});

test("a worker startup failure falls back to the identical interpreter", async () => {
    const pool = new CallAnalysisPool(() => { throw new Error("CSP blocks worker"); }, 2, 0);
    try { assert.deepEqual(await pool.run(units), units.flatMap(analyzeCallUnit)); assert.equal(pool.lastExecution.mode, "fallback"); }
    finally { pool.dispose(); }
});

test("cancelling in-flight real workers rejects the old analysis without delivering stale outcomes", async () => {
    const { pool } = nodeCallPool();
    try {
        const running = pool.run(units); pool.cancel();
        await assert.rejects(running, CallAnalysisCancelled);
    } finally { pool.dispose(); }
});
