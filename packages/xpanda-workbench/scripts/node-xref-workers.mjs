import { Worker } from "node:worker_threads";
export function nodeXrefWorkers() {
    const stats = { created: 0, posted: 0, received: 0, inFlight: 0, maxInFlight: 0, maxInputBytes: 0, errors: [] };
    const factory = () => {
        stats.created++;
        const worker = new Worker(new URL("./xref-node-worker.mjs", import.meta.url), { execArgv: ["--import", "tsx"] });
        const bridge = {
            onmessage: null, onerror: null, onmessageerror: null,
            postMessage(message, transfer) {
                stats.posted++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
                stats.maxInputBytes = Math.max(stats.maxInputBytes, message.units.reduce((n, unit) => n + unit.code.byteLength, 0));
                worker.postMessage(message, transfer);
            },
            terminate() { void worker.terminate(); },
        };
        worker.on("message", data => { stats.received++; stats.inFlight--; bridge.onmessage?.({ data }); });
        worker.on("error", error => { stats.errors.push(error.message); bridge.onerror?.(error); });
        worker.on("messageerror", error => { stats.errors.push(error.message); bridge.onmessageerror?.(error); });
        return bridge;
    };
    return { factory, stats };
}
