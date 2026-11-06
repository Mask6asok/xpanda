import { methodSymbol, type XrefReferenceGroup, type XrefSite, type XrefSymbolReferences } from "../xrefs";

interface SymbolReferenceResultsProps {
    readonly references: XrefSymbolReferences;
    readonly onOpen: (site: XrefSite) => void;
}

function recordPath(record: string): string {
    return record.startsWith("L") && record.endsWith(";") ? record.slice(1, -1) : record;
}

function siteLabel(site: XrefSite): string {
    const file = recordPath(site.sourceRecord).split("/").pop()?.split("&")[0] ?? site.sourceRecord;
    const method = site.sourceMethod === "func_main_0" ? "模块初始化"
        : /^#\*/.test(site.sourceMethod) || site.sourceMethod.endsWith("#") ? "匿名函数" : methodSymbol(site.sourceMethod);
    return `${file} · ${method}`;
}

/** Show physical uses first; method IDs and name strings are expandable technical details. */
export function SymbolReferenceResults({ references, onOpen }: SymbolReferenceResultsProps) {
    const renderSites = (group: XrefReferenceGroup) => (
        <>
            {group.sites.map((site) => (
                <button className="code-navigation-row" key={site.id} onClick={() => onOpen(site)}
                    title={`${site.opcode} · ABC PC 0x${site.pc.toString(16)}${site.callPc !== undefined ? ` → call PC 0x${site.callPc.toString(16)}` : ""}`}>
                    <strong>{siteLabel(site)}</strong>
                    <span>{recordPath(site.sourceRecord)}</span>
                </button>
            ))}
            {group.count > group.sites.length && <p className="code-navigation-note">显示前 {group.sites.length} 条，共 {group.count.toLocaleString()} 条。</p>}
        </>
    );

    return (
        <div className="symbol-reference-results">
            <section className="code-reference-group" aria-label="调用位置">
                <strong className="code-reference-group-title">调用位置（{references.calls.count.toLocaleString()}）</strong>
                {references.calls.count > 0 ? renderSites(references.calls) : (
                    <p className="code-navigation-note">未找到可直接识别的属性调用。其他引用中可能还有间接调用。</p>
                )}
            </section>
            {references.definitions.count > 0 && (
                <details className="code-reference-group">
                    <summary>{references.definitionScope === "method" ? "当前方法定义/注册" : "当前记录定义/注册"}（{references.definitions.count.toLocaleString()}）</summary>
                    <p className="code-navigation-note">{references.definitionScope === "method"
                        ? "按当前方法实体的偏移确定注册位置，不计入调用位置。"
                        : "当前记录中有多个同名方法，这里列出这些方法实体的注册位置。"}</p>
                    {renderSites(references.definitions)}
                </details>
            )}
            {references.sameNameDefinitions.count > 0 && (
                <details className="code-reference-group">
                    <summary>{references.definitionScope === "name" ? "同名定义候选" : "其他同名定义"}（{references.sameNameDefinitions.count.toLocaleString()}）</summary>
                    <p className="code-navigation-note">{references.definitionScope === "name"
                        ? "当前记录没有同名方法定义，以下仅按名称匹配，请核对所属组件。"
                        : "这些是其他方法实体的同名注册，不代表它们引用了当前方法。"}</p>
                    {renderSites(references.sameNameDefinitions)}
                </details>
            )}
            {references.other.count > 0 && (
                <details className="code-reference-group">
                    <summary>其他引用（{references.other.count.toLocaleString()}）</summary>
                    <p className="code-navigation-note">属性访问或字符串使用，未确认发生调用。</p>
                    {renderSites(references.other)}
                </details>
            )}
            <details className="code-reference-group code-reference-technical">
                <summary>底层实体与字节码</summary>
                <p className="code-navigation-note">方法实体和属性名是不同索引入口；当前注册按方法偏移确定，其他同名注册单独展示。</p>
                {references.entities.targets.map((target) => (
                    <div className="code-navigation-note" key={target.key}>
                        <strong>{target.kind === "method" ? "方法实体" : "属性名字符串"} · 0x{target.offset.toString(16)}</strong>
                        <div>{target.name}</div>
                        {target.record && <div>{recordPath(target.record)}</div>}
                    </div>
                ))}
                {references.entities.total > references.entities.targets.length && <p className="code-navigation-note">实体过多，仅显示前 {references.entities.targets.length} 个；上方计数已查询全部匹配实体。</p>}
                {[...references.calls.sites, ...references.definitions.sites, ...references.sameNameDefinitions.sites, ...references.other.sites].map((site) => (
                    <div className="code-navigation-note" key={site.id}>
                        {siteLabel(site)} · {site.opcode} · ABC PC 0x{site.pc.toString(16)}
                        {site.callPc !== undefined && ` → call PC 0x${site.callPc.toString(16)}`}
                        <div>{site.operandPath} · {site.relation}</div>
                    </div>
                ))}
            </details>
        </div>
    );
}
