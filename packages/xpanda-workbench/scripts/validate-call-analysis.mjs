import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { PandaFile } from "xpanda-core";
import { buildXrefIndex } from "../src/analysis/xref-builder.ts";
import { querySymbolReferences } from "../src/analysis/xrefs.ts";
import { prepareCallAnalysis } from "../src/analysis/call-resolution/prepare.ts";
import { analyzeCallUnit } from "../src/analysis/call-resolution/interpreter.ts";
import { nodeCallPool } from "./node-call-pool.mjs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node --import tsx scripts/validate-call-analysis.mjs /path/to/baidu.abc");
const t0 = performance.now();
const file = new PandaFile(new Uint8Array(readFileSync(path)));
const record = file.getAllClasses().find(record => record.name.content.includes("@bdbase-feed/toolkit/src/main/ets/component/adapters&"));
assert.ok(record, "Expected Baidu adapters record");
const index = buildXrefIndex(file, () => {});
const references = querySymbolReferences(index, { symbol: "setData", classOffset: record.getOffset() });
const sites = references.calls.sites;
assert.equal(references.calls.count, 54);
const methodIds = references.entities.targets.filter(target => target.kind === "method").map(target => target.offset);
const indexedMs = performance.now() - t0;
const prepStart = performance.now();
const plan = prepareCallAnalysis(file, sites, methodIds);
const prepareMs = performance.now() - prepStart;
const serialStart = performance.now();
const serial = plan.units.flatMap(analyzeCallUnit);
const serialMs = performance.now() - serialStart;
const { pool, stats } = nodeCallPool();
let parallel, parallelMs, warmMs;
try {
    const parallelStart = performance.now(); parallel = await pool.run(plan.units); parallelMs = performance.now() - parallelStart;
    const warmStart = performance.now(); const warm = await pool.run(plan.units); warmMs = performance.now() - warmStart;
    assert.deepEqual(parallel, serial); assert.deepEqual(warm, serial);
    assert.equal(stats.received, plan.units.length * 2); assert.deepEqual(stats.errors, []); assert.ok(stats.maxInFlight <= 2);
} finally { pool.dispose(); }
const counts = Object.fromEntries(["resolved", "possible", "unresolved", "excluded"].map(status => [status, serial.filter(row => row.relation === status).length]));
assert.equal(serial.length, 54);
const evidence = [];
for (const fragment of ["BasicInfoPanelItem&", "SysUtilsPlugin&", "HistoryListComp&", "IconOnlyActionBar&"]) {
    const site = sites.find(site => site.sourceRecord.includes(fragment)); assert.ok(site, fragment);
    const outcome = serial.find(row => row.siteId === site.id); assert.ok(outcome, fragment);
    assert.notEqual(outcome.relation, "resolved");
    if (fragment === "IconOnlyActionBar&") {
        const owner = file.getAllClasses().find(record => record.getOffset() === site.sourceClassOffset);
        const ownTargets = [...owner.pandaMethods.values()].filter(method => method.name.content.endsWith("#setData")).map(method => method.getOffset());
        assert.ok(ownTargets.length);
        assert.ok(outcome.possibleMethodIds.some(id => ownTargets.includes(id)), "Owning-class table should preserve its own setData candidate");
        assert.equal(outcome.hasUnknown, true, "this rebinding must remain possible");
    }
    evidence.push({ source: site.sourceRecord, method: site.sourceMethod, pc: outcome.pc, relation: outcome.relation, possibleMethodIds: outcome.possibleMethodIds, receiverOrigin: outcome.receiverOrigin, reasons: outcome.reasons });
}
console.log(JSON.stringify({ candidateCount: sites.length, methods: plan.units.length, instructions: plan.units.reduce((sum,unit)=>sum+unit.blocks.reduce((n,block)=>n+block.instructions.length,0),0), payloadBytes: Buffer.byteLength(JSON.stringify(plan.units)), counts, indexedMs, prepareMs, serialMs, parallelColdMs: parallelMs, parallelWarmMs: warmMs, parallelStats: stats, preparationIssueCount: plan.preparationIssues.length, evidence }, null, 2));
