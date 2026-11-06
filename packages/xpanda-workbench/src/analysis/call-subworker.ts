import { analyzeCallUnit } from "./call-resolution/interpreter";
import type { CallTaskRequest, CallTaskResponse } from "./call-pool";

self.onmessage = (event: MessageEvent<CallTaskRequest>): void => {
    const { id, unit } = event.data;
    let response: CallTaskResponse;
    try { response = { id, result: analyzeCallUnit(unit) }; }
    catch (failure) { response = { id, error: failure instanceof Error ? failure.message : String(failure) }; }
    self.postMessage(response);
};
