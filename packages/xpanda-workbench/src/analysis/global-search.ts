import type { GlobalSearchPage, GlobalSearchRequest, RecordInfo, SearchHit } from "../model";

interface SearchJob {
    readonly request: GlobalSearchRequest;
    readonly records: readonly RecordInfo[];
    readonly pattern: RegExp;
    readonly hits: SearchHit[];
    readonly errors: string[];
    scanned: number;
    failed: number;
    stopped: boolean;
    truncated: boolean;
}
const LIMIT = 5000;
const PAGE = 100;

/** Keeps one bounded search session inside the analysis Worker; navigation does not own its state. */
export class GlobalSearch {
    private job: SearchJob | null = null;
    constructor(private readonly readCode: (record: RecordInfo) => string, private readonly sourceName: (id: string) => string) {}
    cancel(sessionId: string | null): null {
        if (sessionId === null) this.job = null;
        else if (this.job?.request.sessionId === sessionId) this.job.stopped = true;
        return null;
    }
    search(request: GlobalSearchRequest, records: () => readonly RecordInfo[]): GlobalSearchPage {
        if (!request.query.trim() || request.query.length > 512) throw new Error("Search text must contain 1–512 characters.");
        if (!this.job || this.job.request.sessionId !== request.sessionId) {
            if (!request.advance) throw new Error("This search session is no longer available. Start a new search.");
            const literal = request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            this.job = { request, records: [...records()], pattern: new RegExp(literal, request.matchCase ? "gu" : "giu"), hits: [], errors: [], scanned: 0, failed: 0, stopped: false, truncated: false };
        }
        const job = this.job;
        if (request.query !== job.request.query || request.kind !== job.request.kind || request.matchCase !== job.request.matchCase) throw new Error("Search options changed. Start a new search.");
        if (request.advance && !job.stopped && !job.truncated) {
            const start = performance.now();
            // One decompilation is indivisible; yield after it so queued navigation/cancellation can proceed.
            for (let count = 0; count < 3 && job.scanned < job.records.length; count++) {
                const record = job.records[job.scanned++];
                try {
                    if (request.kind === "path") this.matchPath(job, record);
                    else this.matchCode(job, record, this.readCode(record));
                } catch (error) {
                    if (!(error instanceof Error)) throw error;
                    job.failed++;
                    if (job.errors.length < 20) job.errors.push(`${record.path}: ${error.message}`);
                }
                if (job.truncated || performance.now() - start > 75) break;
            }
        }
        const offset = Number.isFinite(request.offset) ? Math.max(0, Math.floor(request.offset)) : 0;
        return { sessionId: request.sessionId, query: job.request.query, kind: job.request.kind, matchCase: job.request.matchCase, rows: job.hits.slice(offset, offset + PAGE), offset,
            count: job.hits.length, scanned: job.scanned, total: job.records.length, complete: job.scanned === job.records.length || job.truncated,
            stopped: job.stopped, truncated: job.truncated, failed: job.failed, errors: [...job.errors] };
    }
    private matchPath(job: SearchJob, record: RecordInfo): void {
        job.pattern.lastIndex = 0;
        const match = job.pattern.exec(record.path);
        if (match) this.add(job, record, 1, match.index + 1, match[0].length, record.path, match.index);
    }
    private matchCode(job: SearchJob, record: RecordInfo, code: string): void {
        const lines = code.split("\n");
        for (let index = 0; index < lines.length && !job.truncated; index++) {
            const line = lines[index]; job.pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = job.pattern.exec(line)) !== null) {
                this.add(job, record, index + 1, match.index + 1, match[0].length, line, match.index);
                if (job.truncated) break;
            }
        }
    }
    private add(job: SearchJob, record: RecordInfo, line: number, column: number, length: number, text: string, at: number): void {
        const start = Math.max(0, at - 45);
        const preview = text.slice(start, start + 240);
        job.hits.push({ recordId: record.id, path: record.path, sourceName: this.sourceName(record.sourceId), line, column, length,
            preview, highlightStart: at - start, highlightLength: Math.min(length, preview.length - (at - start)) });
        if (job.hits.length >= LIMIT) job.truncated = true;
    }
}
