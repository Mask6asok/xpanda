import { OPCODE_BY_CODE, PandaInstructionID, type PandaFile } from "xpanda-core";
import { codedXrefMethods, scanXrefMethods } from "./xref-builder";
import type { XrefBlock, XrefInstruction, XrefMethodEntry } from "./xref-builder";
import { decodeXrefUnit, xrefInstructionKind, XREF_NONE, XREF_ROW_SIZE } from "./xref-decode";
import type { XrefDecoded, XrefDecodeUnit } from "./xref-decode";
import type { XrefIndex, XrefTarget } from "./xrefs";

export interface XrefDecodeRequest { readonly id: number; readonly units: readonly XrefDecodeUnit[] }
export interface XrefDecodeResponse { readonly id: number; readonly result: readonly XrefDecoded[] }
export interface XrefWorker {
    onmessage: ((event: MessageEvent<XrefDecodeResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
    postMessage(message: XrefDecodeRequest, transfer: Transferable[]): void;
    terminate(): void;
}
export interface XrefBuildOptions { readonly workerFactory?: (() => XrefWorker) | null; readonly concurrency?: number; readonly minParallelMethods?: number }
export interface XrefExecution { readonly mode: "serial" | "parallel" | "fallback"; readonly workers: number; readonly elapsedMs: number; readonly fallbackMethods: number }
export type BuiltXrefIndex = XrefIndex & { readonly execution: XrefExecution };
const createWorker = (): XrefWorker => new Worker(new URL("./xref-subworker.ts", import.meta.url), { type: "module" });
const BATCH_BYTES = 128 * 1024;
const BATCH_METHODS = 256;

function prepare(entry: XrefMethodEntry): XrefDecodeUnit {
    const code = entry.method.methodCode;
    if (!code) throw new Error("Method has no code");
    return {
        // Never transfer the owning ABC buffer. A batch copies only its method bytecode.
        code: code.instructions.length <= BATCH_BYTES ? code.instructions.slice() : new Uint8Array(),
        registers: code.numVregs + code.numArgs,
        hasModuleData: entry.method.getParent()?.pandaClassModuleData != null,
        namespaceCount: entry.method.getParent()?.pandaClassModuleData?.requestedModules?.length ?? 0,
        boundaries: (code.pandaMethodTryBlocks ?? []).flatMap(block => [block.startPC, block.startPC + block.length]),
        catches: (code.pandaMethodTryBlocks ?? []).flatMap(block => block.pandaMethodCatchBlocks.map(handler => ({ pc: handler.handlerPC, size: handler.codeSize }))),
    };
}

function materialize(entry: XrefMethodEntry, decoded: XrefDecoded): readonly XrefBlock[] {
    if (decoded.fallback) return entry.method.disAssemble()?.pandaIRBasicBlocks ?? [];
    const blocks: { name: string; pandaInstructions: XrefInstruction[] }[] = [];
    let previousPc = -1;
    let previousBlock = -1;
    let params: unknown[] = [];
    for (let at = 0; at < decoded.rows.length; at += XREF_ROW_SIZE) {
        const [pc, code, ordinal, block, callPc, paramIndex, id] = decoded.rows.subarray(at, at + XREF_ROW_SIZE);
        const opcode = OPCODE_BY_CODE.get(code);
        if (!opcode) throw new Error("Unknown decoded opcode");
        if (block !== previousBlock) { blocks.push({ name: block === 0 ? "entry" : `label_${block}`, pandaInstructions: [] }); previousBlock = block; }
        if (pc !== previousPc) {
            params = [];
            blocks[blocks.length - 1].pandaInstructions.push({ pc, opcode, ordinal, kind: xrefInstructionKind(opcode.name), params, ...(callPc === XREF_NONE ? {} : { callPc }) });
            previousPc = pc;
        }
        if (paramIndex !== XREF_NONE) params[paramIndex] = new PandaInstructionID(opcode, paramIndex, id, entry.method);
    }
    return blocks;
}

function dispatch(worker: XrefWorker, id: number, units: readonly XrefDecodeUnit[]): Promise<readonly XrefDecoded[]> {
    return new Promise((resolve, reject) => {
        const finish = (): void => { clearTimeout(timeout); worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; };
        const fail = (message: string): void => { finish(); reject(new Error(message)); };
        const timeout = setTimeout(() => fail("Reference decoder timed out"), 30_000);
        worker.onmessage = event => {
            if (event.data.id !== id) return;
            finish();
            if (event.data.result.length !== units.length) reject(new Error("Incomplete reference decoding batch"));
            else resolve(event.data.result);
        };
        worker.onerror = () => fail("Reference decoder stopped");
        worker.onmessageerror = () => fail("Reference decoder response could not be cloned");
        try { worker.postMessage({ id, units }, units.map(unit => unit.code.buffer)); }
        catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
}

/** Two bounded decoder lanes; entities and the full index stay in the owning analysis Worker. */
export async function buildParallelXrefIndex(file: PandaFile, progress: (done: number, total: number) => void, options: XrefBuildOptions = {}): Promise<BuiltXrefIndex> {
    const started = performance.now();
    const entries = codedXrefMethods(file);
    const factory = options.workerFactory === undefined ? typeof Worker === "undefined" ? null : createWorker : options.workerFactory;
    const parallel = factory !== null && entries.length >= (options.minParallelMethods ?? 2000);
    const workers: XrefWorker[] = [];
    let mode: XrefExecution["mode"] = parallel ? "parallel" : "serial";
    if (parallel) {
        try { for (let lane = 0; lane < Math.min(2, Math.max(1, Math.floor(options.concurrency ?? 2) || 1)); lane++) workers.push(factory()); }
        catch { workers.forEach(worker => worker.terminate()); workers.length = 0; mode = "fallback"; }
    }
    const workerCount = workers.length;
    const targets = new Map<string, XrefTarget>();
    const output: XrefIndex = { targets: [], methods: [], sites: [], scannedMethods: 0, failedMethods: 0 };
    let cursor = 0;
    let sequence = 0;
    let fallbackMethods = 0;
    interface Batch { entries: readonly XrefMethodEntry[]; result: Promise<readonly XrefDecoded[] | null>; worker: XrefWorker | null }
    const startBatch = (worker: XrefWorker | null): Batch | null => {
        if (cursor >= entries.length) return null;
        const start = cursor;
        let bytes = 0;
        do { bytes += entries[cursor++].method.methodCode?.instructions.length ?? 0; }
        while (cursor < entries.length && cursor - start < BATCH_METHODS && bytes + (entries[cursor].method.methodCode?.instructions.length ?? 0) <= BATCH_BYTES);
        const batchEntries = entries.slice(start, cursor);
        const units = batchEntries.map(prepare);
        // Attach rejection handling immediately: a later lane can fail before it is awaited.
        const result = worker ? dispatch(worker, ++sequence, units).catch(() => null) : Promise.resolve(units.map(decodeXrefUnit));
        return { entries: batchEntries, result, worker };
    };
    const queue: Batch[] = [];
    try {
        for (const worker of workers.length ? workers : [null]) { const batch = startBatch(worker); if (batch) queue.push(batch); }
        while (queue.length) {
            const batch = queue.shift();
            if (!batch) break;
            const decoded = await batch.result;
            let worker = batch.worker;
            if (decoded === null) { mode = "fallback"; worker?.terminate(); worker = null; }
            const chunk = scanXrefMethods(batch.entries, () => {}, (entry, index) => {
                const value = decoded?.[index];
                if (!value || value.fallback) { fallbackMethods++; return entry.method.disAssemble()?.pandaIRBasicBlocks ?? []; }
                try { return materialize(entry, value); }
                catch { fallbackMethods++; return entry.method.disAssemble()?.pandaIRBasicBlocks ?? []; }
            });
            for (const target of chunk.targets) targets.set(target.key, target);
            for (const method of chunk.methods) output.methods.push(method);
            for (const site of chunk.sites) output.sites.push(site);
            output.scannedMethods += chunk.scannedMethods;
            output.failedMethods += chunk.failedMethods;
            progress(output.scannedMethods, entries.length);
            const next = startBatch(worker);
            if (next) queue.push(next);
            // Navigation and cancellation messages can run between bounded batches.
            if (!worker) await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
    } finally { workers.forEach(worker => worker.terminate()); }
    if (!entries.length) progress(0, 0);
    output.targets = [...targets.values()];
    return { ...output, execution: { mode, workers: workerCount, elapsedMs: performance.now() - started, fallbackMethods } };
}
