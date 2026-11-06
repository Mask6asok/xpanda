import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AbcSource, ClassRef, DecompileMode } from "../decompiler";
import { highlightLines, plainLines } from "../highlight";
import { copyText, downloadBlob, formatDuration } from "../format";
import { codeDeclarations, codeReferenceLocations, symbolAt, type CodeJump, type CodeNavigate, type CodeReferenceLocation } from "../code-navigation";
import type { XrefSite } from "../xrefs";
import type { XrefWorkerClient } from "../parallel/XrefWorker";
import { CodeNavigationDialog } from "./CodeNavigationDialog";

/**
 * 右侧代码视图:工具栏(类名 / 模式 / 复制 / 单类下载 / 重反编译)+ 行号 + 高亮代码。
 * @Author: jmp0
 */
interface CodePaneProps {
    selected: ClassRef | null;
    /** undefined = 尚未反编译;"" = 反编译完成但无输出 */
    code: string | undefined;
    /** 单类反编译耗时(毫秒);未反编译时为 undefined */
    elapsedMs: number | undefined;
    decompiling: boolean;
    mode: DecompileMode;
    onRedecompile: () => void;
    /** 窄屏返回类列表;宽屏不传(按钮不渲染) */
    onBack?: () => void;
    readonly jump: CodeJump | null;
    readonly onNavigate: CodeNavigate;
    readonly getReferenceIndex: (source: AbcSource) => Promise<XrefWorkerClient>;
    readonly referenceProgress: { readonly done: number; readonly total: number } | null;
}

export function CodePane({ selected, code, elapsedMs, decompiling, mode, onRedecompile, onBack, jump, onNavigate, getReferenceIndex, referenceProgress }: CodePaneProps) {
    const [copied, setCopied] = useState(false);
    const [lines, setLines] = useState<string[]>([]);
    const [activeSymbol, setActiveSymbol] = useState<string | null>(null);
    const [activeLine, setActiveLine] = useState(1);
    const [navigation, setNavigation] = useState<{ action: "definition" | "references"; symbol: string; locations?: readonly CodeReferenceLocation[]; locationNote?: string } | null>(null);
    const [navigationNote, setNavigationNote] = useState<string | null>(null);
    const viewer = useRef<HTMLDivElement | null>(null);
    const consumedJump = useRef<number | null>(null);
    const history = useRef<Omit<CodeJump, "sequence">[]>([]);
    const [historySize, setHistorySize] = useState(0);
    const parsed = useMemo(() => code ? codeDeclarations(code) : { declarations: [], error: null }, [code]);

    useEffect(() => {
        setActiveSymbol(null);
        setActiveLine(1);
        setNavigation(null);
        setNavigationNote(null);
    }, [selected?.key, code]);

    useEffect(() => {
        if (!jump || !selected || !code || lines.length === 0 || consumedJump.current === jump.sequence
            || jump.sourceId !== selected.source.id || jump.classOffset !== selected.clazz.getOffset()) return;
        const matches = parsed.declarations.filter((declaration) => declaration.name === jump.symbol);
        let referenceLine: number | undefined;
        let referenceSymbol: string | undefined;
        let note: string | null = null;
        if (jump.reference) {
            const resolved = codeReferenceLocations(code, jump.reference);
            const pc = `ABC PC 0x${jump.reference.pc.toString(16)}`;
            if (resolved.locations.length === 1 && resolved.scope === "method") {
                referenceLine = resolved.locations[0].line;
                referenceSymbol = resolved.locations[0].name;
                note = `Matched JS occurrence · line ${referenceLine} · ${pc}.`;
            } else if (resolved.locations.length > 0) {
                consumedJump.current = jump.sequence;
                setNavigation({ action: "references", symbol: jump.reference.targetName ?? jump.symbol, locations: resolved.locations,
                    locationNote: `${pc} · ${resolved.scope === "method" ? "Several matching expressions in the source method." : "The source method is unnamed or ambiguous; these are record-level matches."} Choose a JS line; bytecode order does not determine optimized JS order.` });
                return;
            } else {
                note = `${pc}: ${resolved.error ?? "No matching JS expression was found in this output."} Opened the source method/record; try Raw AST.`;
            }
        }
        if (!jump.reference && !jump.line && jump.symbol && matches.length > 1) {
            consumedJump.current = jump.sequence;
            setNavigation({ action: "definition", symbol: jump.symbol });
            return;
        }
        const line = jump.line ?? referenceLine ?? matches[0]?.line ?? 1;
        const frame = window.requestAnimationFrame(() => {
            const row = viewer.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
            if (!row) return;
            row.scrollIntoView({ block: "center" });
            viewer.current?.focus({ preventScroll: true });
            setActiveLine(line);
            setActiveSymbol(referenceSymbol ?? (jump.symbol || null));
            setNavigationNote(note ?? (jump.symbol && !jump.line && matches.length === 0 ? `Opened the record; ${jump.symbol} has no named declaration in this output mode.` : null));
            consumedJump.current = jump.sequence;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [jump, selected, code, lines, parsed]);

    const navigate = (sourceId: string, classOffset: number, symbol: string, line?: number, reference?: XrefSite): void => {
        if (selected) {
            history.current.push({ sourceId: selected.source.id, classOffset: selected.clazz.getOffset(), symbol: activeSymbol ?? "", line: activeLine });
            setHistorySize(history.current.length);
        }
        onNavigate(sourceId, classOffset, symbol, line, reference);
    };

    const openNavigation = (action: "definition" | "references", symbol = activeSymbol): void => {
        if (!selected || !symbol) return;
        setNavigation({ action, symbol });
    };

    const selectSymbol = (event: MouseEvent<HTMLDivElement>): void => {
        const selection = window.getSelection();
        const node = selection?.focusNode;
        if (!node || !viewer.current?.contains(node)) return;
        const element = node instanceof Element ? node : node.parentElement;
        const text = element?.closest<HTMLElement>(".code-text");
        const row = text?.closest<HTMLElement>(".code-line");
        if (!text || !row || !selection) return;
        const range = document.createRange();
        range.selectNodeContents(text);
        range.setEnd(node, selection.focusOffset);
        const symbol = symbolAt(text.textContent ?? "", range.toString().length);
        setActiveLine(Number(row.dataset.line));
        setActiveSymbol(symbol);
        setNavigationNote(null);
        viewer.current.focus({ preventScroll: true });
        if ((event.metaKey || event.ctrlKey) && symbol) openNavigation("definition", symbol);
    };

    useEffect(() => {
        // Render escaped plain text immediately, then swap in Shiki colors once ready.
        // `cancelled` discards stale results when switching classes quickly; on Shiki
        // failure the plain fallback stays visible.
        let cancelled = false;
        if (code === undefined || code === "") {
            setLines([]);
            return;
        }
        setLines(plainLines(code));
        highlightLines(code)
            .then((colored) => { if (!cancelled) setLines(colored); })
            .catch(() => { /* keep the plain fallback */ });
        return () => { cancelled = true; };
    }, [code]);

    if (selected === null) {
        return <div className="codepane-empty">Select a class on the left to decompile it.</div>;
    }

    const handleCopy = (): void => {
        if (code === undefined || code === "") return;
        void copyText(code).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    };

    const handleDownload = (): void => {
        if (code === undefined || code === "") return;
        downloadBlob(new Blob([code], { type: "text/javascript;charset=utf-8" }), selected.simpleName + ".js");
    };

    return (
        <div className="codepane" onKeyDown={(event) => {
            if (event.key === "F12" && activeSymbol && !navigation) {
                event.preventDefault();
                openNavigation(event.shiftKey ? "references" : "definition");
            }
        }}>
            <div className="codepane-toolbar">
                {onBack !== undefined && (
                    <button className="codepane-back" onClick={onBack} title="Back to class list" aria-label="Back to class list">
                        ‹
                    </button>
                )}
                <span className="codepane-path" title={selected.displayPath}>{selected.displayPath}</span>
                <span className="codepane-meta" title={elapsedMs === undefined ? undefined : "Time spent decompiling this class (first run)"}>
                    {mode === "raw" ? "raw" : "optimized"}
                    {elapsedMs !== undefined && ` · ${formatDuration(elapsedMs)}`}
                    {` · ${lines.length} lines`}
                </span>
                <div className="codepane-actions">
                    <button onClick={handleCopy} disabled={code === undefined || code === ""}>
                        {copied ? "Copied ✓" : "Copy"}
                    </button>
                    <button onClick={handleDownload} disabled={code === undefined || code === ""}>
                        Download .js
                    </button>
                    <button onClick={onRedecompile} disabled={decompiling} title="Discard cache and decompile again">
                        Re-decompile
                    </button>
                </div>
            </div>
            <div className="codepane-navigation">
                <label>Method <select aria-label="Method or class" value="" onChange={(event) => {
                    const declaration = parsed.declarations.find((item) => String(item.line) === event.target.value);
                    if (declaration) navigate(selected.source.id, selected.clazz.getOffset(), declaration.name, declaration.line);
                }}>
                    <option value="">Choose method…</option>
                    {parsed.declarations.map((declaration) => <option key={`${declaration.line}:${declaration.name}`} value={declaration.line}>{declaration.label} · line {declaration.line}</option>)}
                </select></label>
                <button disabled={!activeSymbol} onClick={() => openNavigation("definition")} title="Go to definition (F12 or Cmd/Ctrl+click)">Definition <kbd>F12</kbd></button>
                <button disabled={!activeSymbol} onClick={() => openNavigation("references")} title="Find references (Shift+F12)">References <kbd>⇧F12</kbd></button>
                <button disabled={historySize === 0} onClick={() => {
                    const previous = history.current.pop();
                    setHistorySize(history.current.length);
                    if (previous) onNavigate(previous.sourceId, previous.classOffset, previous.symbol, previous.line);
                }}>Back</button>
                <span className="code-symbol" title={activeSymbol ?? undefined}>{activeSymbol ? `Selected: ${activeSymbol}` : "Click a symbol or choose a method"}</span>
            </div>
            {(navigationNote || parsed.error) && <div className="code-navigation-note" role="status">{navigationNote ?? "JS declarations could not be parsed; select a symbol to search ABC candidates."}</div>}
            <div className="codepane-scroll" ref={viewer} tabIndex={0} aria-label="Code viewer" onMouseUp={selectSymbol}>
                {decompiling && code === undefined ? (
                    <div className="codepane-loading">Decompiling {selected.displayPath} …</div>
                ) : code === "" ? (
                    <div className="codepane-loading">
                        {"// decompile failed: this class produced no output (func_main_0 is missing or could not be disassembled)"}
                    </div>
                ) : (
                    <div className="code-body">
                        {lines.map((html, idx) => (
                            <div className={"code-line" + (idx + 1 === activeLine ? " code-line-selected" : "")} data-line={idx + 1} key={idx}>
                                <span className="code-ln">{idx + 1}</span>
                                <span
                                    className="code-text"
                                    dangerouslySetInnerHTML={{ __html: html === "" ? "&nbsp;" : html }}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>
            {navigation && <CodeNavigationDialog key={`${selected.key}:${navigation.action}:${navigation.symbol}`}
                action={navigation.action} symbol={navigation.symbol} source={selected.source} classOffset={selected.clazz.getOffset()}
                declarations={parsed.declarations.filter((declaration) => declaration.name === navigation.symbol)}
                getIndex={getReferenceIndex} progress={referenceProgress} locations={navigation.locations} locationNote={navigation.locationNote}
                onNavigate={navigation.locations ? onNavigate : navigate} onClose={() => setNavigation(null)} />}
        </div>
    );
}
