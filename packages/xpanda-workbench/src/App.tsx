import { useEffect, useRef, useState, type CSSProperties } from "react";
import { GlobalSearchPanel } from "./components/GlobalSearchPanel";
import { useGlobalSearch } from "./useGlobalSearch";
import { useCallAnalysis } from "./useCallAnalysis";
import { AnalysisClient } from "./client";
import { CodeEditor, type EditorHandle } from "./components/CodeEditor";
import { Icon } from "./components/Icon";
import { Navigator } from "./components/Navigator";
import { ReferenceDock, type ReferenceQuery } from "./components/ReferenceDock";
import { displayRecordPath, hex, shortName } from "./text";
import type { DocumentInfo, LocationInfo, NavigationPoint, RecordInfo, ReferencePage, SourceInfo, View, XrefSite } from "./model";

const views: { key: View; label: string }[] = [{ key: "readable", label: "可读 JS" }, { key: "raw", label: "未优化 JS" }, { key: "bytecode", label: "字节码" }, { key: "details", label: "记录信息" }];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
interface DefinitionChoice { record: RecordInfo; line?: number; methodOffset?: number; name: string }
export default function App() {
    const [theme, setTheme] = useState<"light" | "dark">(() => { try { const saved = localStorage.getItem("xpanda-workbench-theme"); if (saved === "light" || saved === "dark") return saved; } catch (failure) { console.warn("Theme preference unavailable:", errorText(failure)); } return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; });
    const [sources, setSources] = useState<SourceInfo[]>([]);
    const [active, setActive] = useState<DocumentInfo | null>(null);
    const [tabs, setTabs] = useState<RecordInfo[]>([]);
    const tabPoints = useRef(new Map<string, NavigationPoint>());
    const current = useRef<NavigationPoint | null>(null);
    const history = useRef<{ points: NavigationPoint[]; index: number }>({ points: [], index: -1 });
    const [, redrawHistory] = useState(0);
    const [landing, setLanding] = useState<{ key: number; line?: number; column?: number; length?: number; frame?: NavigationPoint["frame"] }>({ key: 0 });
    const [position, setPosition] = useState<{ line: number; column: number; symbol: string | null }>({ line: 1, column: 1, symbol: null });
    const caret = useRef(position);
    const editor = useRef<EditorHandle>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const findInput = useRef<HTMLInputElement>(null);
    const [findOpen, setFindOpen] = useState(false);
    const [find, setFind] = useState("");
    const [findMessage, setFindMessage] = useState("");
    const [query, setQuery] = useState<ReferenceQuery | null>(null);
    const [page, setPage] = useState<ReferencePage | null>(null);
    const [referenceError, setReferenceError] = useState<string | null>(null);
    const [refsBusy, setRefsBusy] = useState(false);
    const [codeBusy, setCodeBusy] = useState(false);
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState("就绪");
    const [error, setError] = useState<string | null>(null);
    const [mapping, setMapping] = useState<{ site: XrefSite; sourceId: string; location: LocationInfo | null } | null>(null);
    const [choices, setChoices] = useState<DefinitionChoice[] | null>(null);
    const [choiceMessage, setChoiceMessage] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchFocus, setSearchFocus] = useState(0);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [sidebarWidth, setSidebarWidth] = useState(286);
    const [dockHeight, setDockHeight] = useState(290);
    const [lenient, setLenient] = useState(false);
    const navigationSequence = useRef(0);
    const referenceSequence = useRef(0);
    const definitionSequence = useRef(0);
    const client = useRef<AnalysisClient | null>(null);
    const callAnalysis = useCallAnalysis(client, query, setStatus);
    const globalSearch = useGlobalSearch(client, sources.length);
    function showGlobalSearch() { setSearchOpen(true); setSidebarOpen(true); setSearchFocus(value => value + 1); }
    useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); showGlobalSearch(); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, []);
    function getClient() { if (!client.current) client.current = new AnalysisClient(setStatus, (message) => { setError(message); setLoading(false); setCodeBusy(false); setRefsBusy(false); }); return client.current; }
    useEffect(() => () => { client.current?.dispose(); }, []);
    useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem("xpanda-workbench-theme", theme); } catch (failure) { console.warn("Theme preference not persisted:", errorText(failure)); } }, [theme]);
    useEffect(() => { if (findOpen) findInput.current?.focus(); }, [findOpen]);

    function saveFrame() {
        if (!current.current) return;
        const point = { ...current.current, frame: editor.current?.snapshot(), line: undefined, pc: undefined };
        tabPoints.current.set(point.recordId, point);
        current.current = point;
        if (history.current.index >= 0) history.current.points[history.current.index] = point;
    }
    async function navigate(point: NavigationPoint, push = true) {
        if (push) saveFrame();
        const sequence = ++navigationSequence.current;
        const worker = getClient();
        setCodeBusy(true); setError(null); setChoices(null); setSidebarOpen(false); setMapping(null);
        try {
            const document = await worker.request("open", { recordId: point.recordId, view: point.view, methodOffset: point.methodOffset });
            let location: LocationInfo | null = null;
            if (point.reference && (point.view === "readable" || point.view === "raw")) location = await worker.request("locate", { recordId: point.recordId, view: point.view, site: point.reference });
            if (navigationSequence.current !== sequence) return;
            const resolved = { ...point, methodOffset: document.methodOffset };
            current.current = resolved;
            tabPoints.current.set(point.recordId, resolved);
            if (push) {
                history.current.points = history.current.points.slice(0, history.current.index + 1);
                history.current.points.push(resolved);
                if (history.current.points.length > 100) history.current.points.shift();
                history.current.index = history.current.points.length - 1;
            }
            redrawHistory((value) => value + 1);
            setActive(document);
            setTabs((previous) => previous.some((tab) => tab.id === document.record.id) ? previous : [...previous, document.record]);
            let line = point.line;
            if (point.pc !== undefined) line = document.pcLines.find((row) => row.pc === point.pc)?.line;
            if (!point.frame && location?.locations.length === 1) line = location.locations[0].line;
            if (point.reference) setMapping({ site: point.reference, sourceId: document.record.sourceId, location });
            setLanding({ key: sequence, line, column: point.column, length: point.selectionLength, frame: point.frame });
            setStatus(point.pc !== undefined && line === undefined ? "未找到该 PC 的字节码行" : "就绪");
        } catch (failure) { if (navigationSequence.current === sequence) setError(errorText(failure)); }
        finally { if (navigationSequence.current === sequence) setCodeBusy(false); }
    }
    function openRecord(record: RecordInfo) { void navigate(tabPoints.current.get(record.id) ?? { recordId: record.id, view: "readable" }); }
    function goHistory(direction: number) {
        saveFrame();
        const index = history.current.index + direction;
        const point = history.current.points[index];
        if (!point) return;
        history.current.index = index; void navigate(point, false);
    }
    function reveal(line: number) {
        if (!active) return;
        void navigate({ recordId: active.record.id, view: active.view, methodOffset: active.methodOffset, line });
    }
    function closeTab(record: RecordInfo) {
        const remaining = tabs.filter((tab) => tab.id !== record.id);
        setTabs(remaining); tabPoints.current.delete(record.id);
        if (active?.record.id === record.id) {
            if (remaining.length) openRecord(remaining[remaining.length - 1]);
            else { ++navigationSequence.current; current.current = null; setActive(null); setCodeBusy(false); setMapping(null); }
        }
    }
    async function loadFile(name: string, bytes: ArrayBuffer) {
        const worker = getClient();
        setLoading(true); setError(null); setStatus(`正在解析 ${name}`);
        try {
            const loaded = await worker.request("load", { name, bytes, lenient }, [bytes]);
            if (worker !== client.current) return;
            setSources((previous) => [...previous, ...loaded]);
            setStatus(`已加载 ${loaded.reduce((sum, source) => sum + source.records.length, 0)} 个文件记录`);
            const first = loaded.flatMap((source) => source.records)[0];
            if (first) void navigate({ recordId: first.id, view: "readable" });
        } catch (failure) { if (worker === client.current) { setError(errorText(failure)); setStatus("加载失败"); } }
        finally { if (worker === client.current) setLoading(false); }
    }
    async function loadPicked(files: FileList | null) {
        if (!files || loading) return;
        // One project import at a time keeps parsing errors associated with the selected file.
        const file = files[0]; if (!file) return;
        try { await loadFile(file.name, await file.arrayBuffer()); } catch (failure) { setError(errorText(failure)); }
        if (fileInput.current) fileInput.current.value = "";
    }
    async function openExample() {
        if (loading) return;
        setLoading(true);
        try { const response = await fetch(`${import.meta.env.BASE_URL}samples/class.abc`); if (!response.ok) throw new Error("Unable to load the bundled example."); await loadFile("class.abc (示例)", await response.arrayBuffer()); }
        catch (failure) { setError(errorText(failure)); }
        finally { setLoading(false); }
    }
    function reset() {
        ++navigationSequence.current; ++referenceSequence.current; ++definitionSequence.current;
        client.current?.dispose(); client.current = null;
        setSources([]); setTabs([]); setActive(null); setQuery(null); setPage(null); setMapping(null); setChoices(null); setError(null);
        setRefsBusy(false); setCodeBusy(false); setLoading(false); setStatus("工作区已重置");
        tabPoints.current.clear(); current.current = null; history.current = { points: [], index: -1 }; redrawHistory((value) => value + 1);
    }
    async function runQuery(next: ReferenceQuery) {
        const sequence = ++referenceSequence.current;
        setQuery(next); setRefsBusy(true); setReferenceError(null);
        if (query?.record.id !== next.record.id || query.symbol !== next.symbol) setPage(null);
        try {
            const result = await getClient().request("references", { recordId: next.record.id, symbol: next.symbol, group: next.group, offset: next.offset });
            if (sequence !== referenceSequence.current) return;
            const execution = result.summary.execution;
            const buildLabel = execution ? ` · ${execution.mode === "parallel" ? `${execution.workers} 线程` : execution.mode === "fallback" ? "已回退串行" : "串行"} · 首次构建 ${(execution.elapsedMs / 1000).toFixed(2)}s` : "";
            setPage(result); setStatus(`索引 · ${result.summary.scannedMethods.toLocaleString()} 个方法 · ${result.summary.siteCount.toLocaleString()} 条操作数引用${buildLabel}`);
        } catch (failure) { if (sequence === referenceSequence.current) setReferenceError(errorText(failure)); }
        finally { if (sequence === referenceSequence.current) setRefsBusy(false); }
    }
    function references() {
        if (!active || !caret.current.symbol) { setStatus("先将光标放到方法名或属性名上"); return; }
        void runQuery({ record: active.record, symbol: caret.current.symbol.replace(/^#/, ""), group: "calls", offset: 0 });
    }
    async function definition() {
        if (!active || !caret.current.symbol) { setStatus("先将光标放到方法名上"); return; }
        const symbol = caret.current.symbol.replace(/^#/, "");
        const local = active.declarations.filter((declaration) => declaration.name === symbol);
        if (local.length === 1) { reveal(local[0].line); return; }
        if (local.length > 1) { setChoiceMessage("当前 JS 中有多个同名声明，请选择。"); setChoices(local.map((item) => ({ record: active.record, line: item.line, name: item.label }))); return; }
        const record = active.record;
        setStatus("正在查找定义候选…");
        const sequence = ++definitionSequence.current;
        try {
            const result = await getClient().request("references", { recordId: record.id, symbol, group: "definitions", offset: 0 });
            if (sequence !== definitionSequence.current || current.current?.recordId !== record.id) return;
            const source = sources.find((item) => item.id === record.sourceId);
            const candidates: DefinitionChoice[] = [];
            for (const target of result.references.entities.targets) {
                if (target.kind !== "method") continue;
                const match = source?.records.find((item) => item.offset === target.classOffset);
                if (match) candidates.push({ record: match, methodOffset: target.offset, name: target.name });
            }
            setChoiceMessage(candidates.length ? `按名称找到 ${candidates.length} 个方法候选（最多 300 项），请选择实现；动态接收者类型尚未解析。` : "没有可定位的方法定义。可以查找引用中的字符串或属性使用。");
            setChoices(candidates); setStatus("就绪");
        } catch (failure) { setError(errorText(failure)); }
    }
    function openReference(site: XrefSite, bytecode: boolean) {
        if (!query) return;
        const record = sources.find((source) => source.id === query.record.sourceId)?.records.find((candidate) => candidate.offset === site.sourceClassOffset);
        if (!record) { setError("此引用的文件记录未包含可反编译的入口。"); return; }
        void navigate({ recordId: record.id, view: bytecode ? "bytecode" : "readable", methodOffset: bytecode ? site.sourceMethodOffset : undefined, pc: bytecode ? site.callPc ?? site.pc : undefined, reference: site });
    }
    function openBytecodeMapping() {
        if (!active || !mapping) return;
        void navigate({ recordId: active.record.id, view: "bytecode", methodOffset: mapping.site.sourceMethodOffset, pc: mapping.site.callPc ?? mapping.site.pc, reference: mapping.site });
    }
    async function copy() {
        if (!active) return;
        try { await navigator.clipboard.writeText(active.text); setStatus("已复制当前视图"); } catch { setError("无法访问剪贴板，请在代码中使用全选和复制。"); }
    }
    function download() {
        if (!active) return;
        const url = URL.createObjectURL(new Blob([active.text], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url;
        link.download = shortName(active.record.path).replace(/\.js$/, active.view === "bytecode" ? ".asm.txt" : active.view === "details" ? ".json" : ".js");
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    const busy = loading || codeBusy;
    const activeSource = sources.find((source) => source.id === active?.record.sourceId);
    const workbenchStyle: CSSProperties & { "--sidebar-width": string; "--dock-height": string } = { "--sidebar-width": `${sidebarWidth}px`, "--dock-height": `${dockHeight}px` };
    return <div className="workbench" style={workbenchStyle} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void loadPicked(event.dataTransfer.files); }}>
        <header className="topbar"><button className="icon-button mobile-menu" title="文件导航" aria-label="切换文件导航" onClick={() => setSidebarOpen(!sidebarOpen)}><Icon name="menu" /></button><div className="brand"><span className="brand-mark">x</span><strong>xpanda<span>Workbench</span></strong><span className="independent-label">独立工作台</span></div><div className="topbar-actions"><button className="icon-button" aria-label="全局搜索" title="全局搜索 · ⌘/Ctrl+Shift+F" onClick={showGlobalSearch}><Icon name="search" /></button><button className="quiet-button example-button" disabled={loading} onClick={() => void openExample()}>打开示例</button><button className="primary-button" disabled={loading} onClick={() => fileInput.current?.click()}><Icon name="folder" />打开 ABC / HAP</button><button className="icon-button" title="重置工作区并释放内存" aria-label="重置工作区" disabled={!sources.length && !loading && !refsBusy} onClick={reset}><Icon name="reset" /></button><button className="icon-button" title={`切换到${theme === "light" ? "深色" : "浅色"}`} aria-label="切换主题" onClick={() => setTheme(theme === "light" ? "dark" : "light")}><Icon name="sun" /></button></div><input ref={fileInput} type="file" accept=".abc,.hap,.hsp,.zip" hidden onChange={(event) => void loadPicked(event.target.files)} /></header>
        <div className="main-layout">
            {sidebarOpen && !searchOpen && <button className="sidebar-backdrop" aria-label="关闭文件导航" onClick={() => setSidebarOpen(false)} />}
            <div className={`sidebar-slot ${sidebarOpen ? "is-open" : ""} ${searchOpen ? "search-active" : ""}`}><div className="sidebar-content"><div className="sidebar-tabs" role="tablist" aria-label="导航面板"><button role="tab" aria-selected={!searchOpen} onClick={() => { setSearchOpen(false); setSidebarOpen(true); }}>文件</button><button role="tab" aria-selected={searchOpen} onClick={showGlobalSearch}>全局搜索</button></div><div className="navigator-content" hidden={searchOpen}><Navigator sources={sources} active={active} onOpen={openRecord} onLine={reveal} /></div><GlobalSearchPanel active={searchOpen} focusToken={searchFocus} state={globalSearch} sourceCount={sources.length} recordCount={sources.reduce((count, source) => count + source.records.length, 0)} onClose={() => { setSearchOpen(false); setSidebarOpen(false); }} onOpen={(hit, kind) => { void navigate({ recordId: hit.recordId, view: "readable", line: kind === "code" ? hit.line : undefined, column: kind === "code" ? hit.column : undefined, selectionLength: kind === "code" ? hit.length : undefined }); }} /></div><div className="sidebar-resizer" role="separator" aria-label="调整导航宽度" aria-orientation="vertical" tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setSidebarWidth((width) => Math.min(520, Math.max(210, width + (event.key === "ArrowRight" ? 20 : -20)))); } }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setSidebarWidth(Math.max(210, Math.min(520, event.clientX))); }} /></div>
            <main className="workspace">
                {!!tabs.length && <div className="document-tabs" role="tablist" aria-label="打开的文件">{tabs.map((tab) => <div className={`document-tab ${active?.record.id === tab.id ? "active" : ""}`} key={tab.id}><button role="tab" aria-selected={active?.record.id === tab.id} title={tab.path} onClick={() => openRecord(tab)}><span className="js-icon">JS</span><span>{shortName(displayRecordPath(tab.path))}</span></button><button className="tab-close" aria-label={`关闭 ${shortName(displayRecordPath(tab.path))}`} onClick={() => closeTab(tab)}><Icon name="close" size={12} /></button></div>)}</div>}
                {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError(null)}><Icon name="close" /></button></div>}
                {active ? <>
                    <div className="document-header"><div className="history-controls"><button className="icon-button" aria-label="后退" title="后退（保留选区和滚动）" disabled={history.current.index <= 0 || codeBusy} onClick={() => goHistory(-1)}><Icon name="back" /></button><button className="icon-button" aria-label="前进" title="前进" disabled={history.current.index >= history.current.points.length - 1 || codeBusy} onClick={() => goHistory(1)}><Icon name="forward" /></button></div><span className="breadcrumb truncate" title={`${activeSource?.name} / ${active.record.path}`}>{displayRecordPath(active.record.path)}</span><span className="readonly-label">READ ONLY</span></div>
                    <div className="editor-toolbar"><div className="view-tabs" role="tablist" aria-label="代码视图">{views.map((view) => <button role="tab" key={view.key} aria-selected={active.view === view.key} disabled={codeBusy} onClick={() => void navigate({ recordId: active.record.id, view: view.key })}>{view.label}</button>)}</div><div className="editor-actions"><button title="查找引用 · Shift+F12" disabled={codeBusy || !position.symbol || active.view === "details"} onClick={references}><Icon name="reference" /><span>查找引用</span></button><button className="icon-button" title="文件内搜索 · ⌘/Ctrl+F" aria-label="文件内搜索" onClick={() => setFindOpen(!findOpen)}><Icon name="search" /></button><button className="icon-button" title="复制当前视图" aria-label="复制当前视图" onClick={() => void copy()}><Icon name="copy" /></button><button className="icon-button" title="下载当前视图" aria-label="下载当前视图" onClick={download}><Icon name="download" /></button></div></div>
                    {active.view === "bytecode" && <div className="method-selector"><label htmlFor="bytecode-method">方法</label><select id="bytecode-method" value={active.methodOffset} onChange={(event) => void navigate({ recordId: active.record.id, view: "bytecode", methodOffset: Number(event.target.value) })}>{active.methods.map((method) => <option value={method.offset} key={method.offset}>{method.name} · {hex(method.offset)}</option>)}</select><span className="precision exact">精度：指令 PC</span></div>}
                    {mapping && <div className="mapping-strip"><span className={`precision ${active.view === "bytecode" ? "exact" : ""}`}>{active.view === "bytecode" ? "字节码 PC 定位" : mapping.location?.locations.length === 1 ? "JS 表达式匹配" : mapping.location?.locations.length ? `JS 候选 ${mapping.location.locations.length} 处` : "JS 暂无可匹配位置"}</span><span className="subtle">{active.view === "bytecode" ? `method ${hex(mapping.site.sourceMethodOffset)} · PC ${hex(mapping.site.callPc ?? mapping.site.pc)}` : mapping.location?.scope === "method" ? "在来源方法内匹配；非 PC 源码映射" : "在文件内匹配；非 PC 源码映射"}</span>{active.view !== "bytecode" && <button onClick={openBytecodeMapping}>定位字节码 PC <Icon name="forward" size={12} /></button>}{!!mapping.location && mapping.location.locations.length > 1 && <div className="mapping-candidates">{mapping.location.locations.slice(0, 30).map((location) => <button key={location.line} title={location.snippet} onClick={() => editor.current?.reveal(location.line)}>行 {location.line}</button>)}{mapping.location.locations.length > 30 && <span>另有 {mapping.location.locations.length - 30} 处，可在文件内搜索</span>}</div>}</div>}
                    {findOpen && <form className="find-bar" onSubmit={(event) => { event.preventDefault(); setFindMessage(editor.current?.find(find) ? "" : "未找到"); }}><Icon name="search" /><input ref={findInput} aria-label="在当前文件查找" placeholder="在当前文件查找…" value={find} onChange={(event) => setFind(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setFindOpen(false); editor.current?.focus(); } }} /><button disabled={!find}>下一个</button><span>{findMessage}</span><button type="button" className="icon-button" aria-label="关闭文件搜索" onClick={() => setFindOpen(false)}><Icon name="close" size={14} /></button></form>}
                    <div className="editor-container" aria-busy={codeBusy}><CodeEditor ref={editor} code={active.text} syntax={active.view === "readable" || active.view === "raw"} theme={theme} landing={landing} onSelection={(line, column, symbol) => { caret.current = { line, column, symbol }; setPosition(caret.current); }} onDefinition={() => void definition()} onReferences={references} onFind={() => setFindOpen(true)} />{codeBusy && <div className="editor-loading">正在反编译…</div>}</div>
                </> : <div className="welcome"><div className="welcome-icon"><Icon name="files" size={32} /></div><span className="eyebrow">XPANDA WORKBENCH</span><h1>从代码走向调用关系</h1><p>沿目录阅读 JS，在方法之间跳转，<br />对照引用与原始字节码。</p><div className="welcome-actions"><button className="primary-button" disabled={loading} onClick={() => fileInput.current?.click()}><Icon name="folder" />打开 ABC / HAP</button><button className="quiet-button" disabled={loading} onClick={() => void openExample()}>试用真实 ABC 示例 <Icon name="forward" size={14} /></button></div><div className="welcome-notes"><span>文件只在本机浏览器中处理</span><span>也可拖入文件</span></div><div className="shortcut-list"><div><span>跳转到定义</span><kbd>F12</kbd><small>或 ⌘ / Ctrl 点击</small></div><div><span>查找引用</span><kbd>Shift F12</kbd></div><div><span>文件内搜索</span><kbd>⌘ / Ctrl F</kbd></div></div><label className="checksum-option"><input type="checkbox" checked={lenient} onChange={(event) => setLenient(event.target.checked)} />允许校验和不匹配的 dump 文件</label><small className="subtle">仅影响之后打开的文件</small></div>}
                {query && <><div className="dock-resizer" role="separator" aria-label="调整引用面板高度" aria-orientation="horizontal" tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setDockHeight((height) => Math.max(200, Math.min(window.innerHeight * 0.65, height + (event.key === "ArrowUp" ? 20 : -20)))); } }} onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setDockHeight(Math.max(200, Math.min(window.innerHeight * 0.65, window.innerHeight - event.clientY - 25))); }} /><ReferenceDock analysis={callAnalysis} query={query} page={page} busy={refsBusy} error={referenceError} onQuery={(next) => void runQuery(next)} onOpen={openReference} onClose={() => { ++referenceSequence.current; setQuery(null); setRefsBusy(false); }} /></>}
            </main>
        </div>
        <footer className="statusbar"><span className={`status-dot ${busy || refsBusy || callAnalysis.busy ? "working" : ""}`} /><span className="truncate" role="status">{loading ? status : codeBusy ? "正在反编译…" : refsBusy ? status : status}</span><span className="status-right">{activeSource?.checksumWarning && <span className="warning-text">校验和不匹配</span>}{active && <span>行 {position.line}, 列 {position.column}</span>}<span>xpanda-core · 本地</span></span></footer>
        {choices !== null && <div className="modal-backdrop" onClick={() => setChoices(null)}><section className="definition-dialog" role="dialog" aria-modal="true" aria-label="选择定义候选" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") setChoices(null); }}><div className="dock-heading"><strong>定义候选</strong><button className="icon-button" autoFocus aria-label="关闭定义候选" onClick={() => setChoices(null)}><Icon name="close" /></button></div><p>{choiceMessage}</p><div className="definition-list">{choices.map((choice, index) => <button key={index} onClick={() => void navigate({ recordId: choice.record.id, view: choice.line ? active?.view === "raw" ? "raw" : "readable" : "bytecode", line: choice.line, methodOffset: choice.methodOffset })}><strong>{choice.name}</strong><span title={choice.record.path}>{displayRecordPath(choice.record.path)}{choice.line ? `:${choice.line}` : ` · 方法 ${hex(choice.methodOffset ?? 0)}`}</span></button>)}</div></section></div>}
    </div>;
}
