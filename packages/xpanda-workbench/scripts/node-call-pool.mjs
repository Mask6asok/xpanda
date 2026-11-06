import { Worker } from "node:worker_threads";
import { CallAnalysisPool } from "../src/analysis/call-pool.ts";

export function nodeCallPool() {
    const stats = { created: 0, posted: 0, received: 0, inFlight: 0, maxInFlight: 0, errors: [] };
    const factory = () => {
        stats.created++;
        const worker = new Worker(new URL("./call-analysis-node-worker.mjs", import.meta.url), { execArgv: ["--import", "tsx"] });
        const bridge = {
            onmessage: null, onerror: null, onmessageerror: null,
            postMessage(message) { stats.posted++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight); worker.postMessage(message); },
            terminate() { void worker.terminate(); },
        };
        worker.on("message", (data) => { stats.received++; stats.inFlight--; bridge.onmessage?.({ data }); });
        worker.on("error", (error) => { stats.errors.push(error.message); bridge.onerror?.(error); });
        worker.on("messageerror", (error) => { stats.errors.push(error.message); bridge.onmessageerror?.(error); });
        return bridge;
    };
    return { pool: new CallAnalysisPool(factory, 2, 0), stats };
}
