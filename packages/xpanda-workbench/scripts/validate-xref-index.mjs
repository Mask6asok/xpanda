import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PandaFile } from "xpanda-core";
import { buildXrefIndex } from "../src/analysis/xref-builder.ts";
import { buildParallelXrefIndex } from "../src/analysis/xref-pool.ts";
import { querySymbolReferences } from "../src/analysis/xrefs.ts";
import { nodeXrefWorkers } from "./node-xref-workers.mjs";
const [path, mode = "parallel"] = process.argv.slice(2);
if (!path || !["legacy", "serial", "parallel"].includes(mode)) throw new Error("Usage: node --import tsx scripts/validate-xref-index.mjs file.abc [legacy|serial|parallel]");
const t = performance.now();
const file = new PandaFile(new Uint8Array(readFileSync(path)));
const parsed = performance.now();
const { factory, stats } = nodeXrefWorkers();
const index = mode === "legacy" ? buildXrefIndex(file, () => {}) : await buildParallelXrefIndex(file, () => {}, { workerFactory: mode === "parallel" ? factory : null, minParallelMethods: 0 });
const indexMs = performance.now() - parsed;
function digest(rows) { const hash = createHash("sha256"); for (const row of rows) hash.update(JSON.stringify(row) + "\n"); return hash.digest("hex"); }
const queryStart = performance.now();
const queries = [["setData", "@bdbase-feed/toolkit/src/main/ets/component/adapters&"], ["performWithBlock", "/AFServiceTask&"], ["purgeVariableDependenciesOnElmtId", "/captcha/CaptchaViewManager&"]].flatMap(([symbol, path]) => {
    const record = file.getAllClasses().find(record => record.name.content.includes(path));
    if (!record) return [];
    const result = querySymbolReferences(index, { symbol, classOffset: record.getOffset() });
    return [{ symbol, calls: result.calls.count, definitions: result.definitions.count, sameName: result.sameNameDefinitions.count, other: result.other.count, hash: digest(Object.values(result).flatMap(group => group?.sites ?? [])) }];
});
const queryMs = performance.now() - queryStart;
console.log(JSON.stringify({ mode, parseMs: parsed - t, indexMs, queryMs, methods: index.scannedMethods, targets: index.targets.length, sites: index.sites.length, failed: index.failedMethods, execution: index.execution, hashes: { methods: digest(index.methods), targets: digest(index.targets), sites: digest(index.sites) }, queries, workers: stats, rssMiB: process.memoryUsage().rss / 1048576 }, null, 2));
