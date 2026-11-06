import { analyzeCallUnit } from "./call-resolution/interpreter";
import type { CallAnalysisUnit, CallSiteOutcome } from "./call-resolution/types";

export interface CallTaskRequest { readonly id: number; readonly unit: CallAnalysisUnit }
export type CallTaskResponse = { readonly id: number; readonly result: readonly CallSiteOutcome[] } | { readonly id: number; readonly error: string };
export interface CallWorker {
    onmessage: ((event: MessageEvent<CallTaskResponse>) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
    onmessageerror: ((event: MessageEvent) => void) | null;
    postMessage(message: CallTaskRequest): void;
    terminate(): void;
}
export class CallAnalysisCancelled extends Error {
    constructor() { super("Call analysis cancelled."); this.name = "CallAnalysisCancelled"; }
}
interface Lane { readonly worker: CallWorker; reject: ((reason: Error) => void) | null }
const createWorker = (): CallWorker => new Worker(new URL("./call-subworker.ts", import.meta.url), { type: "module" });

/** A bounded queue keeps at most two compact method units in subworker flight. */
export class CallAnalysisPool {
    private lanes: Lane[] = [];
    private generation = 0;
    private sequence = 0;
    lastExecution: { mode: "serial" | "parallel" | "fallback"; workers: number } = { mode: "serial", workers: 0 };
    constructor(private readonly workerFactory: (() => CallWorker) | null = typeof Worker === "undefined" ? null : createWorker, private readonly concurrency = 2, private readonly minParallelInstructions = 20_000) {}

    cancel(): void {
        this.generation++;
        for (const lane of this.lanes) { lane.reject?.(new CallAnalysisCancelled()); lane.worker.terminate(); }
        this.lanes = [];
    }
    dispose(): void { this.cancel(); }

    async run(units: readonly CallAnalysisUnit[], progress: (done: number, total: number) => void = () => {}): Promise<readonly CallSiteOutcome[]> {
        // A newer run cancels an older queue, while completed lanes remain reusable.
        if (this.lanes.some((lane) => lane.reject !== null)) this.cancel();
        const generation = this.generation;
        const output: (readonly CallSiteOutcome[])[] = new Array(units.length);
        let next = 0;
        let done = 0;
        const instructionCount = units.reduce((total, unit) => total + unit.blocks.reduce((count, block) => count + block.instructions.length, 0), 0);
        const parallel = this.workerFactory !== null && units.length > 1 && instructionCount >= this.minParallelInstructions;
        const count = parallel ? Math.min(units.length, Math.max(1, Math.min(2, Math.floor(this.concurrency) || 1))) : Math.min(1, units.length);
        this.lastExecution = { mode: parallel ? "parallel" : "serial", workers: parallel ? count : 0 };
        const runLane = async (laneIndex: number): Promise<void> => {
            let lane: Lane | undefined = parallel ? this.lanes[laneIndex] : undefined;
            if (!lane && parallel && this.workerFactory) {
                try { lane = { worker: this.workerFactory(), reject: null }; this.lanes[laneIndex] = lane; }
                catch (failure) { if (!(failure instanceof Error)) throw failure; this.lastExecution = { mode: "fallback", workers: 0 }; }
            }
            while (next < units.length) {
                if (generation !== this.generation) throw new CallAnalysisCancelled();
                const index = next++;
                const unit = units[index];
                if (!unit) continue;
                try { output[index] = lane ? await this.dispatch(lane, unit) : analyzeCallUnit(unit); }
                catch (failure) {
                    if (failure instanceof CallAnalysisCancelled) throw failure;
                    if (!(failure instanceof Error)) throw failure;
                    // Transport failures never increase certainty; recompute with the identical interpreter.
                    this.lastExecution = { mode: "fallback", workers: 0 };
                    lane?.worker.terminate();
                    if (lane) this.lanes = this.lanes.filter((candidate) => candidate !== lane);
                    lane = undefined;
                    output[index] = analyzeCallUnit(unit);
                }
                if (generation !== this.generation) throw new CallAnalysisCancelled();
                progress(++done, units.length);
                // Give the owning analysis Worker a chance to process cancellation and normal navigation.
                if (!lane && done % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
        };
        await Promise.all(Array.from({ length: count }, (_, index) => runLane(index)));
        return output.flat();
    }

    private dispatch(lane: Lane, unit: CallAnalysisUnit): Promise<readonly CallSiteOutcome[]> {
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const finish = (): void => { clearTimeout(timeout); lane.reject = null; lane.worker.onmessage = null; lane.worker.onerror = null; lane.worker.onmessageerror = null; };
            const fail = (error: Error): void => { finish(); reject(error); };
            const timeout = setTimeout(() => fail(new Error("Call analysis subworker timed out.")), 30_000);
            lane.reject = fail;
            lane.worker.onmessage = (event) => {
                if (event.data.id !== id) return;
                finish();
                if ("error" in event.data) reject(new Error(event.data.error));
                else resolve(event.data.result);
            };
            lane.worker.onerror = () => fail(new Error("Call analysis subworker stopped."));
            lane.worker.onmessageerror = () => fail(new Error("Call analysis subworker response could not be cloned."));
            try { lane.worker.postMessage({ id, unit }); }
            catch (failure) { fail(failure instanceof Error ? failure : new Error(String(failure))); }
        });
    }
}
