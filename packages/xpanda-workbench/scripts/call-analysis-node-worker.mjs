import { parentPort } from "node:worker_threads";
import { analyzeCallUnit } from "../src/analysis/call-resolution/interpreter.ts";
parentPort.on("message", ({ id, unit }) => {
    try { parentPort.postMessage({ id, result: analyzeCallUnit(unit) }); }
    catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
