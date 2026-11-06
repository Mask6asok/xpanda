import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AnalysisClient } from "./client";
import type { CallAnalysisPage, CallFilter } from "./model";
import type { ReferenceQuery } from "./components/ReferenceDock";

export function useCallAnalysis(client: MutableRefObject<AnalysisClient | null>, query: ReferenceQuery | null, onStatus: (message: string) => void) {
    const [page, setPage] = useState<CallAnalysisPage | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<CallFilter>("all");
    const sequence = useRef(0);
    const cancel = () => {
        ++sequence.current; setBusy(false);
        if (busy) onStatus("调用目标分析已取消");
        const worker = client.current;
        if (worker) void worker.request("cancelCalls", { release: false }).catch((failure: unknown) => {
            if (worker === client.current) setError(failure instanceof Error ? failure.message : String(failure));
        });
    };
    useEffect(() => {
        cancel(); setPage(null); setFilter("all"); setError(null);
    }, [query?.record.id, query?.symbol]);
    const run = async (status: CallFilter = "all", offset = 0) => {
        const worker = client.current;
        if (!query || !worker) return;
        const id = ++sequence.current;
        setBusy(true); setError(null); setFilter(status);
        try {
            const result = await worker.request("analyzeCalls", { recordId: query.record.id, symbol: query.symbol, status, offset });
            if (id === sequence.current) { setPage(result); onStatus(`调用目标分析完成 · ${result.candidateCount} 条候选 · ${result.execution.mode === "parallel" ? "并行" : "串行"}`); }
        } catch (failure) {
            if (id === sequence.current) { setError(failure instanceof Error ? failure.message : String(failure)); onStatus("调用目标分析失败"); }
        } finally { if (id === sequence.current) setBusy(false); }
    };
    return { page, busy, error, filter, run, cancel };
}
export type CallAnalysisState = ReturnType<typeof useCallAnalysis>;
