import type { XrefPage, XrefQuery, XrefSummary, XrefSymbolMatches, XrefSymbolReferences } from "../xrefs";
import type { XrefBuildRequestMessage, XrefWorkerMessage } from "./messages";

export interface XrefWorkerClient {
    readonly summary: XrefSummary;
    query(request: XrefQuery): Promise<XrefPage>;
    lookup(symbol: string, classOffset: number): Promise<XrefSymbolMatches>;
    references(symbol: string, classOffset: number): Promise<XrefSymbolReferences>;
    dispose(): void;
}

/** The worker owns the index until disposal; the UI receives counts and bounded query pages. */
export function buildXrefsInWorker(
    bytes: Uint8Array,
    onProgress: (done: number, total: number) => void,
): Promise<XrefWorkerClient> {
    const worker = new Worker(new URL("./xref-worker.ts", import.meta.url), {
        type: "module",
        name: "xpanda-xrefs",
    });

    return new Promise<XrefWorkerClient>((resolve, reject) => {
        let disposed = false;
        let sequence = 0;
        const pending = new Map<number, { resolve: (page: XrefPage) => void; reject: (error: Error) => void }>();
        const lookups = new Map<number, { resolve: (matches: XrefSymbolMatches) => void; reject: (error: Error) => void }>();
        const references = new Map<number, { resolve: (result: XrefSymbolReferences) => void; reject: (error: Error) => void }>();
        const dispose = (error: Error): void => {
            if (disposed) return;
            disposed = true;
            worker.terminate();
            reject(error);
            for (const request of pending.values()) request.reject(error);
            pending.clear();
            for (const request of lookups.values()) request.reject(error);
            lookups.clear();
            for (const request of references.values()) request.reject(error);
            references.clear();
        };

        worker.onmessage = (event: MessageEvent<XrefWorkerMessage>) => {
            const message = event.data;
            switch (message.type) {
                case "progress":
                    onProgress(message.done, message.total);
                    break;
                case "result":
                    resolve({
                        summary: message.summary,
                        references: (symbol, classOffset) => new Promise<XrefSymbolReferences>((resolveReferences, rejectReferences) => {
                            if (disposed) { rejectReferences(new Error("Reference worker is closed; rebuild the index")); return; }
                            const id = sequence++;
                            references.set(id, { resolve: resolveReferences, reject: rejectReferences });
                            try { worker.postMessage({ type: "references", id, symbol, classOffset }); }
                            catch (e) { dispose(e instanceof Error ? e : new Error(String(e))); }
                        }),
                        lookup: (symbol, classOffset) => new Promise<XrefSymbolMatches>((resolveMatches, rejectMatches) => {
                            if (disposed) { rejectMatches(new Error("Reference worker is closed; rebuild the index")); return; }
                            const id = sequence++;
                            lookups.set(id, { resolve: resolveMatches, reject: rejectMatches });
                            try { worker.postMessage({ type: "lookup", id, symbol, classOffset }); }
                            catch (e) { dispose(e instanceof Error ? e : new Error(String(e))); }
                        }),
                        query: (query) => new Promise<XrefPage>((resolvePage, rejectPage) => {
                            if (disposed) {
                                rejectPage(new Error("Reference worker is closed; rebuild the index"));
                                return;
                            }
                            const id = sequence++;
                            pending.set(id, { resolve: resolvePage, reject: rejectPage });
                            try {
                                worker.postMessage({ type: "query", id, query });
                            } catch (e) {
                                dispose(e instanceof Error ? e : new Error(String(e)));
                            }
                        }),
                        dispose: () => dispose(new Error("Reference worker closed")),
                    });
                    break;
                case "query-result": {
                    const request = pending.get(message.id);
                    pending.delete(message.id);
                    request?.resolve(message.page);
                    break;
                }
                case "lookup-result": {
                    const request = lookups.get(message.id);
                    lookups.delete(message.id);
                    request?.resolve(message.matches);
                    break;
                }
                case "references-result": {
                    const request = references.get(message.id);
                    references.delete(message.id);
                    request?.resolve(message.references);
                    break;
                }
                case "error":
                    dispose(new Error(message.error));
                    break;
            }
        };
        worker.onerror = (event) => dispose(new Error(event.message || "reference worker crashed"));
        worker.onmessageerror = () => dispose(new Error("reference worker message could not be deserialized"));

        try {
            // Copy only this ABC's bytes, then transfer ownership of the copy to avoid a second clone.
            const copy = new Uint8Array(bytes);
            const request: XrefBuildRequestMessage = { type: "build", bytes: copy };
            worker.postMessage(request, [copy.buffer]);
        } catch (e) {
            dispose(e instanceof Error ? e : new Error(String(e)));
        }
    });
}
