import { useEffect, useRef, useState } from "react";
import type { AbcSource } from "../decompiler";
import type { CodeDeclaration, CodeNavigate, CodeReferenceLocation } from "../code-navigation";
import type { XrefWorkerClient } from "../parallel/XrefWorker";
import { SymbolReferenceResults } from "./SymbolReferenceResults";
import { methodSymbol, type XrefSite, type XrefSymbolMatches, type XrefSymbolReferences } from "../xrefs";

interface CodeNavigationDialogProps {
    readonly action: "definition" | "references";
    readonly symbol: string;
    readonly source: AbcSource;
    readonly classOffset: number;
    readonly declarations: readonly CodeDeclaration[];
    readonly getIndex: (source: AbcSource) => Promise<XrefWorkerClient>;
    readonly progress: { readonly done: number; readonly total: number } | null;
    readonly onNavigate: CodeNavigate;
    readonly locations?: readonly CodeReferenceLocation[];
    readonly locationNote?: string;
    readonly onClose: () => void;
}

export function CodeNavigationDialog({ action, symbol, source, classOffset, declarations, getIndex, progress, onNavigate, onClose, locations, locationNote }: CodeNavigationDialogProps) {
    const dialog = useRef<HTMLDialogElement | null>(null);
    const [matches, setMatches] = useState<XrefSymbolMatches | null>(null);
    const [references, setReferences] = useState<XrefSymbolReferences | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const definitions = matches?.targets.filter((item) => item.kind === "method") ?? [];
    const localOnly = locations !== undefined || (action === "definition" && declarations.length > 0);

    useEffect(() => {
        dialog.current?.showModal();
    }, []);

    useEffect(() => {
        Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>(".code-navigation-row") ?? []).find((row) => row.getClientRects().length > 0)?.focus();
    }, [matches, references, localOnly]);

    useEffect(() => {
        if (localOnly) return;
        let active = true;
        setBusy(true);
        void getIndex(source).then(async (client) => {
            if (action === "references") {
                const result = await client.references(symbol, classOffset);
                if (active) setReferences(result);
            } else {
                const result = await client.lookup(symbol, classOffset);
                if (active) setMatches(result);
            }
        }).catch((e) => {
            if (active) setError(e instanceof Error ? e.message : String(e));
        }).finally(() => { if (active) setBusy(false); });
        return () => { active = false; };
    }, [source, symbol, classOffset, getIndex, localOnly, action]);

    const navigate = (offset: number, name: string, line?: number, reference?: XrefSite): void => {
        onNavigate(source.id, offset, name, line, reference);
        onClose();
    };

    return (
        <dialog ref={dialog} className="code-navigation-dialog" aria-labelledby="code-navigation-title" onClose={onClose}>
            <header className="code-navigation-header">
                <h2 id="code-navigation-title">{locations ? "Reference lines" : action === "definition" ? "Definitions" : "References"}: {symbol}</h2>
                <button onClick={onClose} aria-label="Close navigation window">Close <kbd>Esc</kbd></button>
            </header>
            <p className="code-navigation-note">
                {locations ? locationNote : localOnly ? "Declarations with this name in the displayed JavaScript. Choose the matching declaration."
                    : action === "references" ? "调用位置按属性名匹配，运行时接收者类型尚未确定，可能包含其他类的同名方法。"
                    : "Choose the matching method definition. Names can refer to methods in different records."}
            </p>
            <div className="code-navigation-body" aria-busy={busy}>
                {error && <p className="reference-error" role="alert">{error}</p>}
                {busy && <p role="status">{progress ? `Building reference index: ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} methods…` : "Searching references…"}</p>}
                {locations && locations.map((location) => (
                    <button className="code-navigation-row" key={location.line} onClick={() => navigate(classOffset, location.name, location.line)}>
                        <strong>{location.label}</strong><span>{location.snippet}</span>
                    </button>
                ))}
                {localOnly && !locations && declarations.map((declaration) => (
                    <button className="code-navigation-row" key={`${declaration.line}:${declaration.name}`}
                        onClick={() => navigate(classOffset, declaration.name, declaration.line)}>
                        <strong>{declaration.label}</strong><span>JS declaration · line {declaration.line}</span>
                    </button>
                ))}
                {!localOnly && matches && (
                    <>
                        <p className="code-navigation-count">方法定义候选（{definitions.length.toLocaleString()}）{matches.total > matches.targets.length && " · 仅显示部分实体，请缩小符号范围"}</p>
                        {definitions.map((item) => (
                            <button className="code-navigation-row" key={item.key} onClick={() => {
                                if (action === "definition" && item.classOffset !== null) navigate(item.classOffset, methodSymbol(item.name));
                            }}>
                                <strong>{item.name}</strong>
                                <span>方法定义 · @0x{item.offset.toString(16)}{item.classOffset === classOffset ? " · current record" : ""}</span>
                                {item.record && <span>{item.record}</span>}
                            </button>
                        ))}
                        {definitions.length === 0 && (
                            <p>No matching {action === "definition" ? "method definitions" : "ABC entities"} in this ABC. Select a method name or use the References panel for broader searches.</p>
                        )}
                    </>
                )}
                {!localOnly && references && <SymbolReferenceResults references={references}
                    onOpen={(site) => navigate(site.sourceClassOffset, methodSymbol(site.sourceMethod), undefined, site)} />}

            </div>
        </dialog>
    );
}
