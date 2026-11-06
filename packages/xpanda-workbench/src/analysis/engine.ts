import { ENTRY_FUNCTION_MAIN, HapFile, PandaDecompiler, PandaFile, ZipFile, type PandaClass } from "xpanda-core";
import { GlobalSearch } from "./global-search";
import { prepareCallAnalysis } from "./call-resolution";
import { CallAnalysisCancelled, CallAnalysisPool } from "./call-pool";
import type { CallSiteOutcome } from "./call-resolution";
import type { CallAnalysisPage, CallAnalysisRequest, CallAnalysisRow } from "../model";
import { buildParallelXrefIndex } from "./xref-pool";
import type { BuiltXrefIndex } from "./xref-pool";
import { codeDeclarations, codeReferenceLocations } from "./code-navigation";
import { methodSymbol, querySymbolReferences } from "./xrefs";
import type { DocumentInfo, OpenRequest, RecordInfo, ReferenceRequest, Rpc, SourceInfo } from "../model";

interface Source { info: SourceInfo; file: PandaFile; classes: Map<number, PandaClass> }
export class AnalysisEngine {
    private readonly sources = new Map<string, Source>();
    private readonly records = new Map<string, RecordInfo>();
    private readonly documents = new Map<string, DocumentInfo>();
    private index: { sourceId: string; value: BuiltXrefIndex } | null = null;
    private indexBuild: Promise<{ sourceId: string; value: BuiltXrefIndex }> | null = null;
    private sequence = 0;
    private readonly globalSearch = new GlobalSearch(record => this.open({ recordId: record.id, view: "readable" }).text, sourceId => this.sources.get(sourceId)?.info.name ?? sourceId);
    search(input: Rpc["search"]["input"]): Rpc["search"]["output"] { return this.globalSearch.search(input, () => [...this.records.values()]); }
    cancelSearch(sessionId: string | null): null { return this.globalSearch.cancel(sessionId); }
    private readonly callPool = new CallAnalysisPool();
    private callGeneration = 0;
    private callSourceId: string | null = null;
    private readonly callCache = new Map<string, Omit<CallAnalysisPage, "rows" | "offset" | "count"> & { readonly rows: readonly CallAnalysisRow[] }>();

    cancelCalls(release: boolean): null {
        this.callGeneration++;
        this.callPool.cancel();
        if (release) { this.callCache.clear(); this.callSourceId = null; }
        return null;
    }
    private activateSource(sourceId: string): void {
        if (this.callSourceId !== sourceId) { this.cancelCalls(true); this.callSourceId = sourceId; }
    }

    load(input: Rpc["load"]["input"], progress: (message: string) => void): SourceInfo[] {
        const bytes = new Uint8Array(input.bytes);
        const pending: { name: string; bytes: Uint8Array; metadata: string | null }[] = [];
        if (ZipFile.isZip(bytes)) {
            const hap = new HapFile(bytes);
            const metadata = JSON.stringify(hap.getModuleJson(), null, 2);
            for (const entry of hap.getAbcEntries()) pending.push({ name: `${input.name} / ${entry.name}`, bytes: hap.zip.readEntry(entry), metadata });
            if (!pending.length) throw new Error("No ABC bytecode found in this archive.");
        } else pending.push({ name: input.name, bytes, metadata: null });
        // Publish only after all entries parse successfully.
        const parsed: Source[] = pending.map((entry) => {
            progress(`Parsing ${entry.name}`);
            const file = new PandaFile(entry.bytes, { lenientChecksum: input.lenient });
            const id = `source-${++this.sequence}`;
            const classes = new Map(file.getAllClasses().map((clazz) => [clazz.getOffset(), clazz]));
            const records: RecordInfo[] = [...classes.values()].filter((clazz) => clazz.pandaMethods.has(ENTRY_FUNCTION_MAIN)).map((clazz) => ({
                id: `${id}:${clazz.getOffset()}`, sourceId: id, offset: clazz.getOffset(), name: clazz.name.content,
                path: clazz.name.content.replace(/^L/, "").replace(/;$/, "") + ".js",
            })).sort((a, b) => a.path.localeCompare(b.path));
            const info: SourceInfo = { id, name: entry.name, bytes: entry.bytes.byteLength, records, metadata: entry.metadata, checksumWarning: file.checksumMismatch !== undefined };
            return { info, file, classes };
        });
        for (const source of parsed) {
            this.sources.set(source.info.id, source);
            for (const record of source.info.records) this.records.set(record.id, record);
        }
        return parsed.map((source) => source.info);
    }

    private resolve(recordId: string) {
        const record = this.records.get(recordId);
        const source = record && this.sources.get(record.sourceId);
        const clazz = source && source.classes.get(record.offset);
        if (!record || !source || !clazz) throw new Error("The requested record is no longer loaded.");
        return { record, source, clazz };
    }

    open(input: OpenRequest): DocumentInfo {
        const key = JSON.stringify(input);
        const cached = this.documents.get(key);
        if (cached) { this.documents.delete(key); this.documents.set(key, cached); return cached; }
        const { record, source, clazz } = this.resolve(input.recordId);
        this.activateSource(source.info.id);
        const methods = [...new Map([...clazz.pandaMethods.values()].map((method) => [method.getOffset(), method])).values()];
        const methodInfo = methods.map((method) => ({ offset: method.getOffset(), name: method.name.content, symbol: methodSymbol(method.name.content), hasCode: method.methodCode !== null }));
        let text: string;
        const pcLines: DocumentInfo["pcLines"] = [];
        let methodOffset = input.methodOffset;
        if (input.view === "bytecode") {
            const method = methods.find((candidate) => candidate.getOffset() === methodOffset) ?? (methodOffset === undefined ? methods.find((candidate) => candidate.name.content === ENTRY_FUNCTION_MAIN) : undefined);
            if (!method) throw new Error("The selected bytecode method is not in this record.");
            methodOffset = method.getOffset();
            const instructions = (method.disAssemble()?.pandaIRBasicBlocks ?? []).flatMap((block) => block.pandaInstructions);
            const unique = [...new Map(instructions.map((instruction) => [instruction.pc, instruction])).values()].sort((a, b) => a.pc - b.pc);
            const lines = [`// ${method.name.content} @0x${methodOffset.toString(16)}`, "// PC (hex)    instruction / operands"];
            for (const instruction of unique) {
                pcLines.push({ pc: instruction.pc, line: lines.length + 1 });
                lines.push(`0x${instruction.pc.toString(16).padStart(6, "0")}    ${instruction.toString().replace(/^\d+:/, "")}`);
            }
            if (!unique.length) lines.push("// No bytecode instructions.");
            text = lines.join("\n");
        } else if (input.view === "details") {
            text = JSON.stringify({ source: source.info.name, bytes: source.info.bytes, checksum: source.info.checksumWarning ? "mismatch (explicitly allowed)" : "valid", record: record.name, recordOffset: `0x${record.offset.toString(16)}`, methods: methodInfo, module: source.info.metadata ? JSON.parse(source.info.metadata) : null }, null, 2);
        } else {
            const decompiler = new PandaDecompiler();
            text = input.view === "raw" ? decompiler.decompileClassRaw(clazz) : decompiler.decompileClass(clazz);
        }
        const outline = input.view === "raw" || input.view === "readable" ? codeDeclarations(text) : { declarations: [], error: null };
        const result: DocumentInfo = { record, view: input.view, methodOffset, text, declarations: outline.declarations, outlineError: outline.error, methods: methodInfo, pcLines };
        this.documents.set(key, result);
        let size = [...this.documents.values()].reduce((total, document) => total + document.text.length * 2, 0);
        while (this.documents.size > 24 || (size > 32 * 1024 * 1024 && this.documents.size > 1)) {
            const oldest = this.documents.keys().next().value;
            if (oldest === undefined) break;
            size -= (this.documents.get(oldest)?.text.length ?? 0) * 2;
            this.documents.delete(oldest);
        }
        return result;
    }

    private async referenceIndex(source: Source, progress: (message: string, done?: number, total?: number) => void): Promise<BuiltXrefIndex> {
        // Coalesce simultaneous requests and retain a single ABC's full index in memory.
        let index: BuiltXrefIndex;
        for (;;) {
            if (this.index?.sourceId === source.info.id) { index = this.index.value; break; }
            if (this.indexBuild) {
                const built = await this.indexBuild;
                if (built.sourceId === source.info.id) { index = built.value; break; }
                continue;
            }
            this.index = null;
            const pending = buildParallelXrefIndex(source.file, (done, total) => progress("Building reference index", done, total))
                .then(value => ({ sourceId: source.info.id, value }));
            this.indexBuild = pending;
            try { this.index = await pending; index = this.index.value; }
            finally { if (this.indexBuild === pending) this.indexBuild = null; }
            break;
        }
        return index;
    }

    async references(input: ReferenceRequest, progress: (message: string, done?: number, total?: number) => void): Promise<Rpc["references"]["output"]> {
        const { source, record } = this.resolve(input.recordId);
        this.activateSource(source.info.id);
        const index = await this.referenceIndex(source, progress);
        return {
            references: querySymbolReferences(index, { symbol: input.symbol, classOffset: record.offset, page: { group: input.group, offset: input.offset, limit: 100 } }),
            summary: { targetCount: index.targets.length, siteCount: index.sites.length, scannedMethods: index.scannedMethods, failedMethods: index.failedMethods, execution: index.execution },
            offset: input.offset,
        };
    }

    async analyzeCalls(input: CallAnalysisRequest, progress: (message: string, done?: number, total?: number) => void): Promise<CallAnalysisPage> {
        const { source, record } = this.resolve(input.recordId);
        this.activateSource(source.info.id);
        const index = { sourceId: source.info.id, value: await this.referenceIndex(source, progress) };
        if (this.callSourceId !== source.info.id) throw new CallAnalysisCancelled();
        const first = { references: querySymbolReferences(index.value, { symbol: input.symbol, classOffset: record.offset, page: { group: "calls", offset: 0, limit: 100 } }) };
        const selectedMethodOffsets = index.value.methods.filter((method) => method.classOffset === record.offset && (methodSymbol(method.name) === input.symbol || method.name === input.symbol)).map((method) => method.methodOffset).sort((a, b) => a - b);
        const key = JSON.stringify(["call-resolution-v1", source.info.id, selectedMethodOffsets, input.symbol]);
        let cached = this.callCache.get(key);
        if (!cached) {
            this.cancelCalls(false);
            const generation = this.callGeneration;
            const start = performance.now();
            const candidates = [...first.references.calls.sites];
            for (let offset = 100; offset < first.references.calls.count; offset += 100) candidates.push(...querySymbolReferences(index.value, { symbol: input.symbol, classOffset: record.offset, page: { group: "calls", offset, limit: 100 } }).calls.sites);
            progress("Preparing conservative call-target analysis");
            const plan = prepareCallAnalysis(source.file, candidates, selectedMethodOffsets);
            const outcomes = await this.callPool.run(plan.units, (done, total) => progress("Analyzing call targets", done, total));
            if (generation !== this.callGeneration) throw new CallAnalysisCancelled();
            const byId = new Map(outcomes.map((outcome) => [outcome.siteId, outcome]));
            const counts = { resolved: 0, possible: 0, unresolved: 0, excluded: 0 };
            const rows = candidates.map((site): CallAnalysisRow => {
                const outcome: CallSiteOutcome = byId.get(site.id) ?? { siteId: site.id, sourceMethodOffset: site.sourceMethodOffset, pc: site.callPc ?? site.pc, relation: "unresolved", possibleMethodIds: [], receiverOrigin: [], reasons: ["No completed analysis outcome for this candidate."], evidence: [], hasUnknown: true };
                counts[outcome.relation]++;
                return { site, outcome };
            });
            cached = { rows, counts, candidateCount: candidates.length, selectedMethodOffsets, assumptions: plan.assumptions, issues: plan.preparationIssues, elapsedMs: performance.now() - start, analyzedMethods: plan.units.length, execution: { ...this.callPool.lastExecution } };
            this.callCache.set(key, cached);
            // Results are compact, but still bounded; switching source releases them entirely.
            while (this.callCache.size > 4) { const oldest = this.callCache.keys().next().value; if (oldest === undefined) break; this.callCache.delete(oldest); }
        }
        const filtered = input.status === "all" ? cached.rows : cached.rows.filter((row) => row.outcome.relation === input.status);
        const offset = Math.max(0, input.offset);
        return { ...cached, rows: filtered.slice(offset, offset + 100), count: filtered.length, offset };
    }

    locate(input: Rpc["locate"]["input"]): Rpc["locate"]["output"] {
        return codeReferenceLocations(this.open({ recordId: input.recordId, view: input.view }).text, input.site);
    }
}
