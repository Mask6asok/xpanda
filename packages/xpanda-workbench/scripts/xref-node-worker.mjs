import { parentPort } from "node:worker_threads";
import { decodeXrefUnit } from "../src/analysis/xref-decode.ts";
parentPort.on("message", ({ id, units }) => {
    const result = units.map(decodeXrefUnit);
    parentPort.postMessage({ id, result }, result.map(method => method.rows.buffer));
});
