import type { Response, Rpc } from "./model";

export class AnalysisClient {
    private worker = new Worker(new URL("./analysis/worker.ts", import.meta.url), { type: "module" });
    private sequence = 0;
    private pending = new Map<number, { resolve: (result: Rpc[keyof Rpc]["output"]) => void; reject: (error: Error) => void }>();
    constructor(private readonly onProgress: (message: string) => void, private readonly onFatal: (message: string) => void) {
        this.worker.onmessage = (event: MessageEvent<Response>) => {
            const message = event.data;
            if (message.type === "progress") { this.onProgress(`${message.message}${message.total ? ` · ${message.done}/${message.total}` : ""}`); return; }
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            if (message.type === "error") pending.reject(new Error(message.error));
            else pending.resolve(message.result);
        };
        this.worker.onerror = () => {
            const error = new Error("Analysis worker stopped. Reset the workspace to release memory and reopen the file.");
            this.rejectPending(error);
            this.onFatal(error.message);
        };
        this.worker.onmessageerror = () => {
            const error = new Error("Unable to receive the analysis result. Reset the workspace and retry.");
            this.rejectPending(error);
            this.onFatal(error.message);
        };
    }
    request(type: "search", input: Rpc["search"]["input"]): Promise<Rpc["search"]["output"]>;
    request(type: "cancelSearch", input: Rpc["cancelSearch"]["input"]): Promise<null>;
    request(type: "load", input: Rpc["load"]["input"], transfer?: Transferable[]): Promise<Rpc["load"]["output"]>;
    request(type: "open", input: Rpc["open"]["input"]): Promise<Rpc["open"]["output"]>;
    request(type: "references", input: Rpc["references"]["input"]): Promise<Rpc["references"]["output"]>;
    request(type: "analyzeCalls", input: Rpc["analyzeCalls"]["input"]): Promise<Rpc["analyzeCalls"]["output"]>;
    request(type: "cancelCalls", input: Rpc["cancelCalls"]["input"]): Promise<null>;
    request(type: "locate", input: Rpc["locate"]["input"]): Promise<Rpc["locate"]["output"]>;
    request(type: keyof Rpc, input: Rpc[keyof Rpc]["input"], transfer: Transferable[] = []): Promise<Rpc[keyof Rpc]["output"]> {
        const id = ++this.sequence;
        return new Promise<Rpc[keyof Rpc]["output"]>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { this.worker.postMessage({ id, type, input }, transfer); }
            catch (error) { this.pending.delete(id); reject(error); }
        });
    }
    private rejectPending(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
    dispose(): void { this.worker.terminate(); this.rejectPending(new Error("Workspace reset.")); }
}
