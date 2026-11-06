import "./process-shim";
import { PandaFile } from "xpanda-core";
import { buildXrefIndex, lookupXrefSymbol, querySymbolReferences, queryXrefIndex, type XrefIndex } from "../xrefs";
import type { XrefRequestMessage, XrefWorkerMessage } from "./messages";

interface WorkerScope {
    onmessage: ((event: MessageEvent<XrefRequestMessage>) => void) | null;
    postMessage(message: XrefWorkerMessage): void;
}

const scope = self as unknown as WorkerScope;
let index: XrefIndex | null = null;

scope.onmessage = (event) => {
    try {
        const request = event.data;
        switch (request.type) {
            case "build": {
                index = buildXrefIndex(new PandaFile(request.bytes), (done, total) => scope.postMessage({ type: "progress", done, total }));
                scope.postMessage({ type: "result", summary: {
                    targetCount: index.targets.length,
                    siteCount: index.sites.length,
                    scannedMethods: index.scannedMethods,
                    failedMethods: index.failedMethods,
                } });
                break;
            }
            case "query":
                if (index === null) throw new Error("Reference index is not ready");
                scope.postMessage({ type: "query-result", id: request.id, page: queryXrefIndex(index, request.query) });
                break;
            case "lookup":
                if (index === null) throw new Error("Reference index is not ready");
                scope.postMessage({ type: "lookup-result", id: request.id, matches: lookupXrefSymbol(index, request.symbol, request.classOffset) });
                break;
            case "references":
                if (index === null) throw new Error("Reference index is not ready");
                scope.postMessage({ type: "references-result", id: request.id, references: querySymbolReferences(index, request.symbol, request.classOffset) });
                break;
        }
    } catch (e) {
        scope.postMessage({ type: "error", error: e instanceof Error ? e.message : String(e) });
    }
};
