import { useEffect, useRef, useState, type MutableRefObject } from "react";
import type { AnalysisClient } from "./client";
import type { GlobalSearchPage, GlobalSearchRequest, SearchKind } from "./model";

export function useGlobalSearch(client: MutableRefObject<AnalysisClient | null>, sourceCount: number) {
    const [page, setPage] = useState<GlobalSearchPage | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const sequence = useRef(0);
    const current = useRef<GlobalSearchRequest | null>(null);
    const offset = useRef(0);
    function stop() {
        ++sequence.current; setBusy(false);
        const sessionId = current.current?.sessionId;
        const worker = client.current;
        if (worker && sessionId) void worker.request("cancelSearch", { sessionId }).then(result => {
            if (result === null) setPage(previous => previous?.sessionId === sessionId ? { ...previous, stopped: true } : previous);
        }).catch(failure => { if (worker === client.current) setError(failure instanceof Error ? failure.message : String(failure)); });
    }
    useEffect(() => { if (sourceCount === 0) { stop(); current.current = null; setPage(null); setError(null); } }, [sourceCount]);
    async function run(query: string, kind: SearchKind, matchCase: boolean) {
        const worker = client.current;
        if (!worker || !query.trim()) return;
        stop();
        const id = ++sequence.current;
        const request: GlobalSearchRequest = { sessionId: `search-${id}`, query, kind, matchCase, offset: 0, advance: true };
        current.current = request; offset.current = 0; setPage(null); setBusy(true); setError(null);
        try {
            while (id === sequence.current) {
                const result = await worker.request("search", { ...request, offset: offset.current });
                if (id !== sequence.current) return;
                setPage(result);
                if (result.complete || result.stopped) break;
            }
        } catch (failure) { if (id === sequence.current) setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { if (id === sequence.current) setBusy(false); }
    }
    async function turnPage(next: number) {
        const request = current.current, worker = client.current, id = sequence.current;
        if (!request || !worker) return;
        offset.current = Math.max(0, next);
        try { const result = await worker.request("search", { ...request, advance: false, offset: offset.current }); if (id === sequence.current) setPage(result); }
        catch (failure) { if (id === sequence.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    }
    return { page, busy, error, run, stop, turnPage };
}
export type GlobalSearchState = ReturnType<typeof useGlobalSearch>;
