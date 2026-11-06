import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { ClassRef, LoadedImage } from "../decompiler";
import { formatBytes } from "../format";
import { buildClassTree, type ClassDirectory } from "../class-tree";

/**
 * 左侧栏:文件(来源)列表 + 可搜索、按包分组的类列表。
 * 每个文件(.abc / .hap)可单独折叠、可单独关闭(×),多个文件时支持一键全部关闭;
 * 已反编译的类带绿点标记;点击类项触发选中反编译。
 * @Author: jmp0
 */
interface SidebarProps {
    images: LoadedImage[];
    refs: ClassRef[];
    selectedKey: string | null;
    cachedKeys: Set<string>;
    onSelect: (ref: ClassRef) => void;
    /** 关闭单个已加载文件(释放其字节码与内存缓存) */
    onCloseImage: (imageId: string) => void;
    /** 关闭全部文件;只有多于一个文件时由 App 传入 */
    onCloseAll?: () => void;
    /** 全量反编译运行中禁止关闭,避免进度统计失效 */
    closeDisabled: boolean;
}

export function Sidebar({ images, refs, selectedKey, cachedKeys, onSelect, onCloseImage, onCloseAll, closeDisabled }: SidebarProps) {
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState<Map<string, boolean>>(new Map());
    /** 按 image.id 折叠整个文件(不影响包分组各自的折叠状态) */
    const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (q.length === 0) return refs;
        return refs.filter((r) => r.displayPath.toLowerCase().includes(q));
    }, [refs, query]);

    const selected = refs.find((ref) => ref.key === selectedKey);
    useEffect(() => {
        if (!selected) return;
        const paths = selected.displayPath.split("/");
        paths.pop();
        setExpanded((previous) => {
            const next = new Map(previous);
            for (let i = 1; i <= paths.length; i++) next.set(selected.source.id + "|" + paths.slice(0, i).join("/"), true);
            return next;
        });
        setCollapsedFiles((previous) => {
            const next = new Set(previous);
            next.delete(selected.source.image.id);
            return next;
        });
    }, [selected]);

    const bySource = useMemo(() => {
        const groups = new Map<string, ClassRef[]>();
        for (const ref of filtered) {
            const group = groups.get(ref.source.id);
            if (group) group.push(ref);
            else groups.set(ref.source.id, [ref]);
        }
        return new Map([...groups].map(([id, group]) => [id, buildClassTree(group)]));
    }, [filtered]);

    const renderDirectory = (directory: ClassDirectory, sourceId: string, depth: number): React.ReactNode => (
        <ul className="tree-children">
            {[...directory.directories.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => {
                const key = sourceId + "|" + child.path;
                const open = query.trim().length > 0 || (expanded.get(key) ?? depth < 1);
                return (
                    <li key={key}>
                        <button className="tree-group-head" style={{ paddingLeft: 10 + depth * 16 }}
                            title={child.path} aria-expanded={open}
                            aria-label={`${open ? "Collapse" : "Expand"} folder ${child.path}`}
                            onClick={() => setExpanded((previous) => new Map(previous).set(key, !open))}
                            onKeyDown={(event) => {
                                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                                    event.preventDefault();
                                    setExpanded((previous) => new Map(previous).set(key, event.key === "ArrowRight"));
                                }
                            }}>
                            <span className="tw" aria-hidden="true">{open ? "▾" : "▸"}</span>
                            <span className="tree-group-name">{child.name}</span>
                            <span className="count">{child.count}</span>
                        </button>
                        {open && renderDirectory(child, sourceId, depth + 1)}
                    </li>
                );
            })}
            {[...directory.files].sort((a, b) => a.simpleName.localeCompare(b.simpleName)).map((ref) => (
                <li key={ref.key}>
                    <button className={"tree-class" + (ref.key === selectedKey ? " active" : "") + (cachedKeys.has(ref.key) ? " cached" : "")}
                        style={{ paddingLeft: 12 + depth * 16 }} title={ref.displayPath}
                        aria-current={ref.key === selectedKey ? "page" : undefined} onClick={() => onSelect(ref)}>
                        <span className="dot" aria-hidden="true" />
                        <span className="tree-file-name">{ref.simpleName}.js</span>
                    </button>
                </li>
            ))}
        </ul>
    );

    const moveFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".tree button:not(:disabled)")];
        if (!(event.target instanceof HTMLButtonElement)) return;
        const current = rows.indexOf(event.target);
        if (current < 0) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
        rows[next]?.focus();
    };

    const toggleFile = (key: string): void => {
        setCollapsedFiles((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    return (
        <div className="sidebar" onKeyDown={moveFocus}>
            <div className="sidebar-search">
                <input
                    type="text"
                    placeholder="Filter classes…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    spellCheck={false}
                />
                {onCloseAll !== undefined && (
                    <button
                        className="sidebar-close-all"
                        onClick={onCloseAll}
                        disabled={closeDisabled}
                        title="Close all loaded files and release their memory (browser-saved results are kept)"
                    >
                        Close all
                    </button>
                )}
            </div>
            <div className="tree">
                {images.map((img) => {
                    const sources = img.sources.filter((source) => bySource.has(source.id));
                    if (sources.length === 0) return null;
                    // 搜索时临时展开文件,保证匹配的类立即可见;清空搜索后恢复用户手动折叠状态
                    const fileCollapsed = collapsedFiles.has(img.id) && query.trim().length === 0;
                    return (
                        <div key={img.id} className={"tree-image-block" + (fileCollapsed ? " collapsed" : "")}>
                            <div className="tree-image">
                                <button
                                    className="tree-image-main"
                                    onClick={() => toggleFile(img.id)}
                                    aria-expanded={!fileCollapsed}
                                    title={(fileCollapsed ? "Expand " : "Collapse ") + img.fileName}
                                >
                                    <span className="tw">{fileCollapsed ? "▸" : "▾"}</span>
                                    <span className={"badge badge-" + img.kind}>{img.kind}</span>
                                    <span className="tree-image-name" title={img.fileName}>{img.fileName}</span>
                                    <span className="tree-image-meta">{formatBytes(img.sizeBytes)}</span>
                                </button>
                                <button
                                    className="tree-image-close"
                                    onClick={() => onCloseImage(img.id)}
                                    disabled={closeDisabled}
                                    title={"Close " + img.fileName + " and release its memory"}
                                    aria-label={"Close " + img.fileName}
                                >
                                    ×
                                </button>
                            </div>
                            {!fileCollapsed && (
                                <>
                                    {img.moduleInfo !== null && (
                                        <div className="tree-module">
                                            {img.moduleInfo.bundle} · v{img.moduleInfo.version} · {img.moduleInfo.vm}
                                        </div>
                                    )}
                                    {sources.map((source) => {
                                        const root = bySource.get(source.id);
                                        return root && (
                                            <div key={source.id}>
                                                {img.kind === "hap" && <div className="tree-source" title={source.name}>{source.name}</div>}
                                                {renderDirectory(root, source.id, 0)}
                                            </div>
                                        );
                                    })}
                                </>
                            )}
                        </div>
                    );
                })}
                {filtered.length === 0 && <div className="tree-empty">no classes match</div>}
            </div>
        </div>
    );
}
