import { useEffect, useState } from "react";
import type { AbcSource } from "../decompiler";
import type { CodeNavigate } from "../code-navigation";
import { XREF_ENTITY_KINDS, methodSymbol, type XrefDirection, type XrefEntityKind, type XrefPage, type XrefMethod, type XrefSite, type XrefTarget } from "../xrefs";
import type { XrefWorkerClient } from "../parallel/XrefWorker";

const MAX_LIST_ITEMS = 300;

interface ReferencePaneProps {
    sources: AbcSource[];
    sourceId: string | null;
    onSourceChange: (sourceId: string) => void;
    index: XrefWorkerClient | undefined;
    building: boolean;
    progress: { done: number; total: number };
    error: string | null;
    onBuild: (source: AbcSource) => void;
    onOpenClass: CodeNavigate;
    onBack?: () => void;
}

function sourceLabel(source: AbcSource): string {
    return source.image.kind === "hap"
        ? `${source.image.fileName} · ${source.name}`
        : source.name;
}

function itemLabel(item: XrefTarget | XrefMethod): string {
    return "kind" in item ? `${item.record ? item.record + " · " : ""}${item.name}` : `${item.record} · ${item.name}`;
}

function siteKey(site: XrefSite): string {
    return site.id;
}

function renderPC(pc: number): string {
    return `0x${pc.toString(16)}`;
}

export function ReferencePane({
    sources,
    sourceId,
    onSourceChange,
    index,
    building,
    progress,
    error,
    onBuild,
    onOpenClass,
    onBack,
}: ReferencePaneProps) {
    const [direction, setDirection] = useState<XrefDirection>("incoming");
    const [kind, setKind] = useState<XrefEntityKind | "all">("method");
    const [query, setQuery] = useState("");
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [result, setResult] = useState<{ owner: XrefWorkerClient; page: XrefPage } | null>(null);
    const [queryError, setQueryError] = useState<string | null>(null);
    const [querying, setQuerying] = useState(false);

    const source = sources.find((candidate) => candidate.id === sourceId) ?? sources[0] ?? null;
    useEffect(() => {
        if (!index) return;
        let active = true;
        setQuerying(true);
        setQueryError(null);
        setResult(null);
        // Debounce text edits so a large index isn't scanned for every keystroke.
        const timer = window.setTimeout(() => {
            void index.query({ direction, kind, query, selectedKey }).then((page) => {
                if (active) setResult({ owner: index, page });
            }).catch((e) => {
                if (active) setQueryError(e instanceof Error ? e.message : String(e));
            }).finally(() => {
                if (active) setQuerying(false);
            });
        }, 150);
        return () => { active = false; window.clearTimeout(timer); };
    }, [index, direction, kind, query, selectedKey]);

    const page = result?.owner === index ? result?.page : undefined;
    const visibleItems = page?.items ?? [];
    const visibleSites = page?.sites ?? [];
    const itemCount = page?.itemCount ?? 0;
    const siteCount = page?.siteCount ?? 0;
    const selectedItemKey = page?.selected?.key;
    const heading = page?.selected ? itemLabel(page.selected) : undefined;

    return (
        <section className="referencepane" aria-label="ABC cross references">
            <div className="reference-toolbar">
                {onBack && (
                    <button className="reference-back" onClick={onBack} title="Back to class list" aria-label="Back to class list">
                        ‹
                    </button>
                )}
                <strong>ABC References</strong>
                {source && (
                    <select
                        className="reference-source"
                        value={source.id}
                        onChange={(event) => onSourceChange(event.target.value)}
                        aria-label="ABC source"
                    >
                        {sources.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{sourceLabel(candidate)}</option>
                        ))}
                    </select>
                )}
                {source && (
                    <button className="btn-accent" onClick={() => onBuild(source)} disabled={building}>
                        {building ? "Indexing…" : index ? "Rebuild index" : "Build index"}
                    </button>
                )}
            </div>

            {source === null ? (
                <div className="reference-empty">Open an ABC or HAP file to build references.</div>
            ) : (
                <>
                    {building && (
                        <div className="reference-status">
                            Indexing methods {progress.done.toLocaleString()} / {progress.total.toLocaleString()}…
                        </div>
                    )}
                    {index && !building && (
                        <div className="reference-status">
                            {index.summary.targetCount.toLocaleString()} entities · {index.summary.siteCount.toLocaleString()} reference sites
                            {index.summary.failedMethods > 0 && ` · ${index.summary.failedMethods.toLocaleString()} methods skipped`}
                        </div>
                    )}
                    {error && <div className="reference-error">{error}</div>}
                    {queryError && <div className="reference-error">{queryError}</div>}
                    {!index && !building ? (
                        <div className="reference-empty">
                            Build an in-memory index for <code>{source.name}</code> to search exact ABC operand references.
                        </div>
                    ) : index && (
                        <>
                            <div className="reference-controls">
                                <div className="segmented" role="group" aria-label="Reference direction">
                                    <button className={direction === "incoming" ? "active" : ""} aria-pressed={direction === "incoming"} onClick={() => setDirection("incoming")}>
                                        Incoming
                                    </button>
                                    <button className={direction === "outgoing" ? "active" : ""} aria-pressed={direction === "outgoing"} onClick={() => setDirection("outgoing")}>
                                        Uses
                                    </button>
                                </div>
                                <select
                                    value={kind}
                                    onChange={(event) => setKind(event.target.value as XrefEntityKind | "all")}
                                    aria-label="Entity kind"
                                >
                                    <option value="all">All kinds</option>
                                    {XREF_ENTITY_KINDS.map((entityKind) => <option key={entityKind} value={entityKind}>{entityKind.replace("_", " ")}</option>)}
                                </select>
                                <input
                                    value={query}
                                    onChange={(event) => setQuery(event.target.value)}
                                    placeholder={direction === "incoming" ? "Search methods / strings…" : "Search source methods…"}
                                    spellCheck={false}
                                />
                            </div>

                            <div className="reference-content">
                                <div className="reference-list" aria-label={direction === "incoming" ? "Reference targets" : "Source methods"}>
                                    <div className="reference-list-count">
                                        {querying ? "Searching…" : `${itemCount.toLocaleString()} ${direction === "incoming" ? "targets" : "methods"}`}
                                        {itemCount > MAX_LIST_ITEMS && ` · showing first ${MAX_LIST_ITEMS}`}
                                    </div>
                                    {visibleItems.slice(0, MAX_LIST_ITEMS).map((item) => {
                                        const key = item.key;
                                        return (
                                            <button
                                                key={key}
                                                className={"reference-item" + (key === selectedItemKey ? " active" : "")}
                                                onClick={() => setSelectedKey(key)}
                                                title={itemLabel(item)}
                                            >
                                                <span className="reference-item-title">{itemLabel(item)}</span>
                                                <span className="reference-item-meta">
                                                    {"kind" in item ? `${item.kind} · @0x${item.offset.toString(16)}` : `method · @0x${item.methodOffset.toString(16)}`}
                                                </span>
                                            </button>
                                        );
                                    })}
                                    {visibleItems.length === 0 && <div className="reference-empty compact">No matching entries.</div>}
                                </div>

                                <div className="reference-detail">
                                    <div className="reference-detail-head">
                                        <strong title={heading}>{heading ?? "Select an entry"}</strong>
                                        <span>{siteCount.toLocaleString()} sites</span>
                                    </div>
                                    <div className="reference-sites">
                                        {visibleSites.length === 0 ? (
                                            <div className="reference-empty compact">
                                                {selectedItemKey ? "No reference sites for this entry." : "Select an entry to inspect its sites."}
                                            </div>
                                        ) : visibleSites.slice(0, 1000).map((site) => (
                                            <div className="reference-site" key={siteKey(site)}>
                                                <div className="reference-site-main">
                                                    <span className="reference-site-title">
                                                        {direction === "incoming"
                                                            ? `${site.sourceRecord} · ${site.sourceMethod}`
                                                        : site.targetName ?? site.relation.replace(/_/g, " ")}
                                                    </span>
                                                    <span className="reference-site-meta">
                                                        {site.opcode} · {renderPC(site.pc)} · {site.relation.replace(/_/g, " ")}
                                                        {site.resolution !== "exact_operand" && ` · ${site.resolution.replace(/_/g, " ")}`}
                                                    </span>
                                                </div>
                                                <button
                                                    className="reference-open-class"
                                                    onClick={() => onOpenClass(source.id, site.sourceClassOffset, methodSymbol(site.sourceMethod), undefined, site)}
                                                    title="Locate this reference in the displayed code"
                                                >
                                                    Open reference
                                                </button>
                                            </div>
                                        ))}
                                        {siteCount > 1000 && <div className="reference-list-count">Showing first 1,000 sites.</div>}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </>
            )}
        </section>
    );
}
