import "./process-shim";
import { decodeXrefUnit } from "./xref-decode";
import type { XrefDecodeRequest, XrefDecodeResponse } from "./xref-pool";

self.onmessage = (event: MessageEvent<XrefDecodeRequest>): void => {
    const result = event.data.units.map(decodeXrefUnit);
    const response: XrefDecodeResponse = { id: event.data.id, result };
    self.postMessage(response, { transfer: result.map(method => method.rows.buffer) });
};
