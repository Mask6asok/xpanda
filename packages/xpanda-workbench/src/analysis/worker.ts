import "./process-shim";
import { AnalysisEngine } from "./engine";
import type { Request, Response } from "../model";

const engine = new AnalysisEngine();
const send = (message: Response): void => self.postMessage(message);
self.onmessage = async (event: MessageEvent<Request>) => {
    const request = event.data;
    const progress = (message: string, done?: number, total?: number) => send({ id: request.id, type: "progress", message, done, total });
    try {
        let result: Response & { type: "result" };
        switch (request.type) {
            case "search": result = { id: request.id, type: "result", result: engine.search(request.input) }; break;
            case "cancelSearch": result = { id: request.id, type: "result", result: engine.cancelSearch(request.input.sessionId) }; break;
            case "load": result = { id: request.id, type: "result", result: engine.load(request.input, progress) }; break;
            case "open": result = { id: request.id, type: "result", result: engine.open(request.input) }; break;
            case "references": result = { id: request.id, type: "result", result: await engine.references(request.input, progress) }; break;
            case "analyzeCalls": result = { id: request.id, type: "result", result: await engine.analyzeCalls(request.input, progress) }; break;
            case "cancelCalls": result = { id: request.id, type: "result", result: engine.cancelCalls(request.input.release) }; break;
            case "locate": result = { id: request.id, type: "result", result: engine.locate(request.input) }; break;
        }
        send(result);
    } catch (error) {
        send({ id: request.id, type: "error", error: error instanceof Error ? error.message : String(error) });
    }
};
