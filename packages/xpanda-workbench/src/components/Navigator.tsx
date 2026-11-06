import { useEffect, useMemo, useState } from "react";
import type { DocumentInfo, RecordInfo, SourceInfo } from "../model";
import { displayRecordPath, shortName, sizeLabel } from "../text";
import { Icon } from "./Icon";

interface Branch { key: string; label: string; children: Map<string, Branch>; record?: RecordInfo }
interface Row { key: string; label: string; depth: number; record?: RecordInfo; expanded?: boolean; count?: number }
export function Navigator({ sources, active, onOpen, onLine }: { sources: SourceInfo[]; active: DocumentInfo | null; onOpen(record: RecordInfo): void; onLine(line: number): void }) {
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState(new Set<string>());
    const trees = useMemo(() => sources.map((source) => {
        const root: Branch = { key: source.id, label: source.name, children: new Map() };
        for (const record of source.records) {
            let branch = root;
            const segments = record.path.split("/").filter(Boolean);
            for (let i = 0; i < segments.length; i++) {
                const key = `${branch.key}/${segments[i]}`;
                let child = branch.children.get(segments[i]);
                if (!child) { child = { key, label: segments[i], children: new Map() }; branch.children.set(segments[i], child); }
                branch = child;
                if (i === segments.length - 1) branch.record = record;
            }
        }
        return root;
    }), [sources]);
    useEffect(() => {
        if (!active) return;
        setExpanded((previous) => {
            const result = new Set(previous); let key = active.record.sourceId; result.delete(key);
            for (const segment of active.record.path.split("/").filter(Boolean).slice(0, -1)) { key += `/${segment}`; result.add(key); }
            return result;
        });
    }, [active?.record.id]);
    const rows = useMemo(() => {
        const result: Row[] = [];
        if (query.trim()) {
            const needle = query.trim().toLowerCase();
            for (const source of sources) for (const record of source.records) if (record.path.toLowerCase().includes(needle)) result.push({ key: record.id, label: record.path, depth: 0, record });
            return result;
        }
        const visit = (branch: Branch, depth: number) => {
            const open = depth === 0 ? !expanded.has(branch.key) : expanded.has(branch.key);
            result.push({ key: branch.key, label: branch.label, depth, record: branch.record, expanded: open, count: depth === 0 ? sources.find((source) => source.id === branch.key)?.records.length : undefined });
            if (open) for (const child of [...branch.children.values()].sort((a, b) => Number(!!a.record) - Number(!!b.record) || a.label.localeCompare(b.label))) visit(child, depth + 1);
        };
        for (const tree of trees) visit(tree, 0);
        return result;
    }, [trees, sources, expanded, query]);
    const display = rows.slice(0, 500);
    return <aside className="navigator" aria-label="文件和方法导航">
        <div className="section-heading"><span>EXPLORER</span><span className="count">{sources.reduce((count, source) => count + source.records.length, 0)}</span></div>
        <label className="search-field"><Icon name="search" /><input placeholder="筛选文件路径…" aria-label="筛选文件" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="file-tree" role="tree" aria-label="文件树" onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
            const index = items.findIndex((item) => item === document.activeElement);
            const item = items[index];
            if (!item) return;
            let next = index;
            if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
            else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else if (event.key === "ArrowRight" && item.getAttribute("aria-expanded") === "false" || event.key === "ArrowLeft" && item.getAttribute("aria-expanded") === "true") { event.preventDefault(); item.click(); return; }
            else return;
            event.preventDefault(); items[next]?.focus();
        }}>{display.map((row) => <button key={row.key} role="treeitem" aria-level={row.depth + 1} aria-selected={row.record ? row.record.id === active?.record.id : undefined} aria-expanded={!row.record ? row.expanded : undefined} className={`tree-row ${row.record?.id === active?.record.id ? "selected" : ""}`} style={{ paddingLeft: 12 + row.depth * 14 }} title={row.record?.path ?? row.label} onClick={() => row.record ? onOpen(row.record) : setExpanded((previous) => { const result = new Set(previous); if (result.has(row.key)) result.delete(row.key); else result.add(row.key); return result; })}>
            {!row.record && <span className={`tree-chevron ${row.expanded ? "expanded" : ""}`}><Icon name="chevron" size={12} /></span>}
            {row.record ? <span className="js-icon">JS</span> : <Icon name="folder" size={15} />}
            <span className="truncate">{row.record ? displayRecordPath(row.label) : row.depth === 0 && !query ? shortName(row.label) : row.label}</span>{row.count !== undefined && <span className="count">{row.count}</span>}
        </button>)}{rows.length > display.length && <p className="subtle tree-limit">还有 {rows.length - display.length} 项，请筛选路径以缩小范围。</p>}{!sources.length && <p className="subtle tree-limit">打开 ABC 或 HAP 后，按原始目录层级浏览文件。</p>}{!!sources.length && !rows.length && <p className="subtle tree-limit">没有匹配的文件。</p>}</div>
        <div className="section-heading outline-heading"><span>OUTLINE</span><span className="count">{active?.declarations.length ?? 0}</span></div>
        <div className="outline" aria-label="当前代码大纲">{active?.declarations.map((declaration, index) => <button className="outline-row" key={`${declaration.line}:${index}`} onClick={() => onLine(declaration.line)} title={declaration.label}><span className="symbol-icon">{declaration.label.includes(".") ? "m" : "ƒ"}</span><span className="truncate">{declaration.label}</span><span className="count">{declaration.line}</span></button>)}{!active?.declarations.length && <p className="subtle tree-limit">{active?.outlineError ? "此输出无法解析大纲，可继续阅读代码或切换字节码。" : active ? "可读 JS 视图显示实际类与方法大纲。" : "打开文件后显示 JS 类与方法。"}</p>}</div>
        <div className="sidebar-foot">{sources.length ? `${sources.length} ABC · ${sizeLabel(sources.reduce((total, source) => total + source.bytes, 0))}` : "LOCAL ANALYSIS"}<span>只读</span></div>
    </aside>;
}
