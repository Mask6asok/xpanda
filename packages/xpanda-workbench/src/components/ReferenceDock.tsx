import { CallAnalysisResults } from "./CallAnalysisResults";
import type { CallAnalysisState } from "../useCallAnalysis";
import type { RecordInfo, ReferenceGroup, ReferencePage, XrefSite } from "../model";
import { displayRecordPath, hex, shortName } from "../text";
import { Icon } from "./Icon";
export interface ReferenceQuery { record: RecordInfo; symbol: string; group: ReferenceGroup; offset: number }
const groups: { key: ReferenceGroup; label: string; explanation: string }[] = [
    { key: "calls", label: "同名调用候选", explanation: "属性名加载后紧邻调用指令。按名称匹配，尚未解析接收者类型，不能确认调用的是当前实现。" },
    { key: "definitions", label: "当前定义 / 注册", explanation: "通过当前记录中的方法 ID 关联到该实现的注册位置；这里不计入调用者。" },
    { key: "sameNameDefinitions", label: "其他同名实现", explanation: "其他方法 ID 或无法关联当前方法 ID 的同名注册，不是当前实现的调用者。" },
    { key: "other", label: "其他名称使用", explanation: "同名字符串、属性访问等其他字节码操作数使用；不保证是一次调用。" },
];
export function ReferenceDock({ analysis, query, page, busy, error, onQuery, onOpen, onClose }: { analysis: CallAnalysisState; query: ReferenceQuery; page: ReferencePage | null; busy: boolean; error: string | null; onQuery(query: ReferenceQuery): void; onOpen(site: XrefSite, bytecode: boolean): void; onClose(): void }) {
    const group = groups.find((item) => item.key === query.group) ?? groups[0];
    const result = page?.references[query.group];
    return <section className="reference-dock" aria-label="交叉引用结果">
        <div className="dock-heading"><Icon name="reference" /><strong>引用</strong><code>{query.symbol}</code><span className="query-source truncate" title={query.record.path}>{shortName(displayRecordPath(query.record.path))}</span><button className="icon-button" title="关闭引用" aria-label="关闭引用" onClick={onClose}><Icon name="close" /></button></div>
        <div className="reference-tabs" role="tablist" aria-label="引用分组">{groups.map((item) => <button role="tab" aria-selected={item.key === query.group} key={item.key} onClick={() => onQuery({ ...query, group: item.key, offset: 0 })}>{item.label}<span className="count">{page ? page.references[item.key].count.toLocaleString() : "—"}</span></button>)}</div>
        <p className="reference-explanation">{group.explanation}</p>
        <div className="reference-list" aria-busy={busy}>
            {query.group === "calls" && <CallAnalysisResults state={analysis} onOpen={onOpen} />}
            {analysis.page && query.group === "calls" ? null : busy ? <div className="dock-empty">正在查询索引…</div> : error ? <div className="dock-empty error-text">{error}</div> : !result?.sites.length ? <div className="dock-empty">此分组没有结果。可切换其他分组查看注册或名称使用。</div> : result.sites.map((site) => <div className="reference-row" key={site.id}>
                <button className="reference-location" onClick={() => onOpen(site, false)} title={site.sourceRecord}><span className="reference-name">{shortName(displayRecordPath(site.sourceRecord.replace(/^L/, "").replace(/;$/, "")))}<span className="reference-method">{site.sourceMethod}</span></span><span className="reference-path">{displayRecordPath(site.sourceRecord.replace(/^L/, "").replace(/;$/, ""))}</span></button>
                <span className="relation-badge">{query.group === "calls" ? "名称候选" : query.group === "definitions" ? "方法 ID" : "同名操作数"}</span>
                <button className="pc-link" onClick={() => onOpen(site, true)} title={`跳到字节码 ${site.opcode}`}><span>PC {hex(site.callPc ?? site.pc)}</span><Icon name="forward" size={12} /></button>
                <details className="reference-technical"><summary aria-label="字节码详情">详情</summary><div><code>{site.opcode} · {site.operandPath}<br />method {hex(site.sourceMethodOffset)} · operand PC {hex(site.pc)}<br />{site.relation} · {site.resolution}</code></div></details>
            </div>)}
        </div>
        {!(analysis.page && query.group === "calls") && <div className="dock-footer"><span>{busy ? "索引留在 Worker 内存中" : result ? `${result.count ? query.offset + 1 : 0}–${query.offset + result.sites.length} / ${result.count.toLocaleString()}` : "每页 100 项"}</span>{!!page?.summary.failedMethods && <span className="warning-text">{page.summary.failedMethods} 个方法扫描失败</span>}<div className="pagination"><button disabled={busy || query.offset === 0} onClick={() => onQuery({ ...query, offset: Math.max(0, query.offset - 100) })}>上一页</button><button disabled={busy || !result || query.offset + 100 >= result.count} onClick={() => onQuery({ ...query, offset: query.offset + 100 })}>下一页</button></div></div>}
    </section>;
}
