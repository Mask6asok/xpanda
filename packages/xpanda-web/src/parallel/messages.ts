/**
 * 主线程 ↔ simplify worker 的消息协议。
 * AST JSON 自包含,可直接跨线程传递,worker 不需要重新解析 .abc。
 * @Author: jmp0
 */
export interface SimplifyTaskMessage {
    id: number;
    /** PandaDecompiler.decompileClassAst() 的输出 */
    ast: string;
}

export interface SimplifyResultMessage {
    id: number;
    text?: string;
    error?: string;
}

export interface XrefBuildRequestMessage {
    readonly type: "build";
    bytes: Uint8Array;
}

export type XrefRequestMessage = XrefBuildRequestMessage
    | { readonly type: "query"; readonly id: number; readonly query: import("../xrefs").XrefQuery }
    | { readonly type: "lookup"; readonly id: number; readonly symbol: string; readonly classOffset: number }
    | { readonly type: "references"; readonly id: number; readonly symbol: string; readonly classOffset: number };

export type XrefWorkerMessage =
    | { type: "progress"; done: number; total: number }
    | { type: "result"; summary: import("../xrefs").XrefSummary }
    | { type: "query-result"; id: number; page: import("../xrefs").XrefPage }
    | { type: "lookup-result"; id: number; matches: import("../xrefs").XrefSymbolMatches }
    | { type: "references-result"; id: number; references: import("../xrefs").XrefSymbolReferences }
    | { type: "error"; error: string };
