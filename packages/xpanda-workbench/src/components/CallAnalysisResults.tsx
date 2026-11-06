import type { XrefSite, CallFilter } from "../model";
import type { CallAnalysisState } from "../useCallAnalysis";
import { displayRecordPath, hex, shortName } from "../text";

const labels = { resolved: "模型内已解析", possible: "可能调用", unresolved: "无法解析", excluded: "指向其他方法" } as const;
export function CallAnalysisResults({ state, onOpen }: { state: CallAnalysisState; onOpen(site: XrefSite, bytecode: boolean): void }) {
    const { page, busy, error, filter } = state;
    return <div className="call-analysis">
        <div className="call-analysis-toolbar"><button className="quiet-button" disabled={busy} onClick={() => void state.run()}>分析这些调用候选</button>{busy && <button onClick={state.cancel}>取消分析</button>}<span className="subtle">小任务串行，大任务最多 2 个 Worker</span></div>
        {error && <p className="error-text" role="alert">{error}</p>}
        {busy && <p role="status" className="subtle">正在追踪寄存器、函数和对象来源…</p>}
        {page && <>
            <div className="call-filters" aria-label="调用分析筛选">{(["all", "resolved", "possible", "unresolved", "excluded"] satisfies CallFilter[]).map((status) => <button key={status} aria-pressed={status === filter} disabled={busy} onClick={() => void state.run(status)}>{status === "all" ? "全部" : labels[status]} <span>{status === "all" ? page.candidateCount : page.counts[status]}</span></button>)}</div>
            <p className="subtle">{page.execution.mode === "parallel" ? `${page.execution.workers} Worker 并行` : page.execution.mode === "fallback" ? "Worker 不可用，回退串行" : "小任务自动串行"}，分析 {page.analyzedMethods} 个方法，耗时 {page.elapsedMs.toFixed(1)} ms。仅覆盖当前同名候选集合，间接调用可能遗漏。</p>
            <details className="analysis-assumptions"><summary>分析模型与限制</summary><ul>{page.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>{page.issues.map((issue) => <p key={issue}>{issue}</p>)}</details>
            <div className="analysis-rows">{page.rows.map(({ site, outcome }) => <div className="analysis-row" key={site.id}>
                <div className="analysis-row-heading"><button title={site.sourceRecord} onClick={() => onOpen(site, false)}>{shortName(displayRecordPath(site.sourceRecord.replace(/^L/, "").replace(/;$/, "")))} · {site.sourceMethod}</button><span className={`analysis-status status-${outcome.relation}`}>{labels[outcome.relation]}</span><button className="pc-link" onClick={() => onOpen(site, true)}>PC {hex(outcome.pc)}</button></div>
                <details><summary>来源与证据</summary><p>来源方法：{site.sourceMethod} · {hex(site.sourceMethodOffset)}</p><p>候选方法 ID：{outcome.possibleMethodIds.length ? outcome.possibleMethodIds.map(hex).join(", ") : "尚未解析"}</p><p>接收对象来源：{outcome.receiverOrigin.join(" → ") || "未知"}</p><ul>{outcome.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><code>{outcome.evidence.join(" → ") || "无完整目标证据"}</code></details>
            </div>)}{!page.rows.length && <p className="subtle">此分类没有结果。</p>}</div>
            <div className="dock-footer"><span>{page.count ? page.offset + 1 : 0}–{page.offset + page.rows.length} / {page.count}</span><div className="pagination"><button disabled={busy || page.offset === 0} onClick={() => void state.run(filter, Math.max(0, page.offset - 100))}>分析上一页</button><button disabled={busy || page.offset + 100 >= page.count} onClick={() => void state.run(filter, page.offset + 100)}>分析下一页</button></div></div>
        </>}
    </div>;
}
