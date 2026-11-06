import { useEffect, useRef, useState } from "react";
import type { GlobalSearchState } from "../useGlobalSearch";
import type { SearchHit, SearchKind } from "../model";
import { displayRecordPath } from "../text";
import { Icon } from "./Icon";

export function GlobalSearchPanel({ active, focusToken, state, sourceCount, recordCount, onOpen, onClose }: {
    active: boolean; focusToken: number; state: GlobalSearchState; sourceCount: number; recordCount: number;
    onOpen(hit: SearchHit, kind: SearchKind): void; onClose(): void;
}) {
    const [query, setQuery] = useState("");
    const [kind, setKind] = useState<SearchKind>("code");
    const [matchCase, setMatchCase] = useState(false);
    const [selected, setSelected] = useState("");
    const input = useRef<HTMLInputElement>(null);
    const { page, busy, error } = state;
    useEffect(() => { if (active) input.current?.focus(); }, [active, focusToken]);
    const changed = page && (page.query !== query || page.kind !== kind || page.matchCase !== matchCase);
    return <section className="global-search-panel" aria-label="全局搜索面板" hidden={!active}>
        <div className="section-heading"><span>全局搜索</span><button className="icon-button" aria-label="关闭全局搜索" onClick={onClose}><Icon name="close" size={14} /></button></div>
        <form className="global-search-form" onSubmit={event => { event.preventDefault(); setSelected(""); void state.run(query, kind, matchCase); }}>
            <label className="global-search-input"><Icon name="search" /><input ref={input} aria-label="全局搜索关键词" placeholder="输入关键词，按 Enter 搜索" value={query} maxLength={512} onChange={event => setQuery(event.target.value)} /></label>
            <div className="global-search-options"><select aria-label="全局搜索范围" value={kind} onChange={event => setKind(event.target.value === "path" ? "path" : "code")}><option value="code">可读 JS 全文</option><option value="path">文件路径</option></select><label><input type="checkbox" checked={matchCase} onChange={event => setMatchCase(event.target.checked)} />区分大小写</label></div>
            <div className="global-search-actions"><button className="primary-button" disabled={!query.trim() || !sourceCount}>搜索全部文件</button>{busy && <button type="button" onClick={state.stop}>停止</button>}</div>
        </form>
        <div className="global-search-status" role="status">{error ? <span className="error-text">{error}</span> : page ? <><span>{busy ? "正在扫描" : page.stopped ? "已停止" : "搜索完成"} · {page.scanned}/{page.total} 文件</span><span>{page.truncated ? "已达 5000 条上限，请缩小关键词" : `${page.count} 处匹配`}{page.failed ? ` · ${page.failed} 个文件失败，结果不完整` : ""}</span>{page.total !== recordCount && <span>文件集已更新，请重新搜索。</span>}{changed && <span>显示“{page.query}”的结果，按 Enter 更新。</span>}</> : <span>{sourceCount ? "搜索所有已加载 ABC；全文按需反编译，大包可能较慢。" : "先打开 ABC 或 HAP 文件。"}</span>}</div>
        <div className="global-search-results" aria-label="全局搜索结果" aria-busy={busy}>{page?.rows.map(hit => {
            const key = `${hit.recordId}:${hit.line}:${hit.column}`;
            return <button type="button" className={`global-search-hit ${selected === key ? "selected" : ""}`} key={key} title={`${hit.sourceName} / ${hit.path}:${hit.line}:${hit.column}`} onClick={() => { setSelected(key); onOpen(hit, page.kind); }}>
                <span className="search-hit-path">{displayRecordPath(hit.path)}{page.kind === "code" && <strong>:{hit.line}:{hit.column}</strong>}</span>
                <span className="search-hit-source">{hit.sourceName}</span><code>{hit.preview.slice(0, hit.highlightStart)}<mark>{hit.preview.slice(hit.highlightStart, hit.highlightStart + hit.highlightLength)}</mark>{hit.preview.slice(hit.highlightStart + hit.highlightLength)}</code>
            </button>;
        })}{page && !page.rows.length && <p className="subtle tree-limit">{busy ? "正在搜索，请稍候…" : page.failed ? "当前输出未找到匹配，部分文件搜索失败。" : "没有匹配结果。"}</p>}</div>
        {page && <div className="global-search-footer"><span>{page.count ? page.offset + 1 : 0}–{page.offset + page.rows.length} / {page.count}</span><button disabled={page.offset === 0} onClick={() => void state.turnPage(page.offset - 100)}>上一页</button><button disabled={page.offset + 100 >= page.count} onClick={() => void state.turnPage(page.offset + 100)}>下一页</button></div>}
    </section>;
}
