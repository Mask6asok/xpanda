import type { CodeDeclaration, CodeReferenceLocation } from "./analysis/code-navigation";
import type { CallSiteOutcome } from "./analysis/call-resolution";
import type { XrefSite, XrefSymbolReferences, XrefSummary } from "./analysis/xrefs";

export type View = "readable" | "raw" | "bytecode" | "details";
export type ReferenceGroup = "calls" | "definitions" | "sameNameDefinitions" | "other";
export interface RecordInfo { id: string; sourceId: string; offset: number; name: string; path: string }
export interface SourceInfo { id: string; name: string; bytes: number; records: RecordInfo[]; metadata: string | null; checksumWarning: boolean }
export interface MethodInfo { offset: number; name: string; symbol: string; hasCode: boolean }
export interface DocumentInfo {
    record: RecordInfo; view: View; methodOffset?: number; text: string;
    declarations: readonly CodeDeclaration[]; outlineError: string | null;
    methods: MethodInfo[]; pcLines: { pc: number; line: number }[];
}
export interface LocationInfo { locations: readonly CodeReferenceLocation[]; scope: "method" | "record"; error: string | null }
export interface ReferencePage { references: XrefSymbolReferences; summary: XrefSummary; offset: number }
export type CallStatus = CallSiteOutcome["relation"];
export type CallFilter = "all" | CallStatus;
export interface CallAnalysisRequest { readonly recordId: string; readonly symbol: string; readonly status: CallFilter; readonly offset: number }
export interface CallAnalysisRow { readonly site: XrefSite; readonly outcome: CallSiteOutcome }
export interface CallAnalysisPage {
    readonly rows: readonly CallAnalysisRow[];
    readonly counts: Readonly<Record<CallStatus, number>>;
    readonly count: number;
    readonly offset: number;
    readonly candidateCount: number;
    readonly selectedMethodOffsets: readonly number[];
    readonly assumptions: readonly string[];
    readonly issues: readonly string[];
    readonly elapsedMs: number;
    readonly analyzedMethods: number;
    readonly execution: { readonly mode: "serial" | "parallel" | "fallback"; readonly workers: number };
}
export interface OpenRequest { recordId: string; view: View; methodOffset?: number }
export interface ReferenceRequest { recordId: string; symbol: string; group: ReferenceGroup; offset: number }
export type SearchKind = "code" | "path";
export interface GlobalSearchRequest { readonly sessionId: string; readonly query: string; readonly kind: SearchKind; readonly matchCase: boolean; readonly offset: number; readonly advance: boolean }
export interface SearchHit { readonly recordId: string; readonly path: string; readonly sourceName: string; readonly line: number; readonly column: number; readonly length: number; readonly preview: string; readonly highlightStart: number; readonly highlightLength: number }
export interface GlobalSearchPage { readonly sessionId: string; readonly query: string; readonly kind: SearchKind; readonly matchCase: boolean; readonly rows: readonly SearchHit[]; readonly offset: number; readonly count: number; readonly scanned: number; readonly total: number; readonly complete: boolean; readonly stopped: boolean; readonly truncated: boolean; readonly failed: number; readonly errors: readonly string[] }
export interface Rpc {
    search: { input: GlobalSearchRequest; output: GlobalSearchPage };
    cancelSearch: { input: { readonly sessionId: string | null }; output: null };
    load: { input: { name: string; bytes: ArrayBuffer; lenient: boolean }; output: SourceInfo[] };
    open: { input: OpenRequest; output: DocumentInfo };
    references: { input: ReferenceRequest; output: ReferencePage };
    analyzeCalls: { input: CallAnalysisRequest; output: CallAnalysisPage };
    cancelCalls: { input: { readonly release: boolean }; output: null };
    locate: { input: { recordId: string; view: "readable" | "raw"; site: XrefSite }; output: LocationInfo };
}
export type Request = { [K in keyof Rpc]: { id: number; type: K; input: Rpc[K]["input"] } }[keyof Rpc];
export type Response = { id: number; type: "result"; result: Rpc[keyof Rpc]["output"] }
    | { id: number; type: "error"; error: string }
    | { id: number; type: "progress"; message: string; done?: number; total?: number };
export interface EditorFrame { start: number; end: number; top: number; left: number }
export interface NavigationPoint extends OpenRequest { frame?: EditorFrame; line?: number; column?: number; selectionLength?: number; pc?: number; reference?: XrefSite }
export { type XrefSite };
