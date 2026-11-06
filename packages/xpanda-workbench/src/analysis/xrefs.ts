export const XREF_ENTITY_KINDS = ["method", "string", "field", "literal_array"] as const;
export type XrefEntityKind = (typeof XREF_ENTITY_KINDS)[number];
export type XrefTargetKind = XrefEntityKind | "type";
export type XrefDirection = "incoming" | "outgoing";

export interface XrefTarget {
    key: string;
    kind: XrefEntityKind;
    offset: number;
    name: string;
    record: string | null;
    classOffset: number | null;
}

export interface XrefMethod {
    key: string;
    classOffset: number;
    record: string;
    methodOffset: number;
    name: string;
}

export interface XrefSite {
    id: string;
    sourceClassOffset: number;
    sourceRecord: string;
    sourceMethodOffset: number;
    sourceMethod: string;
    instructionIndex: number;
    pc: number;
    block: string;
    opcode: string;
    operandPath: string;
    relation: string;
    resolution: "exact_operand" | "unresolved_operand" | "unresolved_dynamic" | "runtime_intrinsic";
    targetKind: XrefTargetKind | null;
    targetOffset: number | null;
    targetName: string | null;
    /** Adjacent dynamic call consuming this property load; receiver type is still unresolved. */
    readonly callPc?: number;
}

export interface XrefIndex {
    targets: XrefTarget[];
    methods: XrefMethod[];
    sites: XrefSite[];
    scannedMethods: number;
    failedMethods: number;
}

export interface XrefSummary {
    readonly execution?: import("./xref-pool").XrefExecution;
    readonly targetCount: number;
    readonly siteCount: number;
    readonly scannedMethods: number;
    readonly failedMethods: number;
}

export interface XrefSymbolMatches {
    readonly targets: readonly XrefTarget[];
    readonly total: number;
}

export interface XrefReferenceGroup {
    readonly count: number;
    readonly sites: readonly XrefSite[];
}

export interface XrefSymbolReferences {
    readonly entities: XrefSymbolMatches;
    readonly definitionScope: "method" | "record" | "name";
    readonly calls: XrefReferenceGroup;
    readonly definitions: XrefReferenceGroup;
    readonly sameNameDefinitions: XrefReferenceGroup;
    readonly other: XrefReferenceGroup;
}

function isDefinitionSite(site: XrefSite): boolean {
    return site.relation === "function_definition" || site.relation === "class_constructor"
        || /defineclasswithbuffer|definesendableclass|definefunc|definemethod/.test(site.opcode);
}

function physicalSiteKey(site: XrefSite): string {
    return `${site.sourceClassOffset}:${site.sourceMethodOffset}:${site.pc}`;
}

/** Merge the method/name query entrances into physical sites, keeping registrations out of calls. */
export function querySymbolReferences(index: XrefIndex, request: { symbol: string; classOffset: number; page?: { group: "calls" | "definitions" | "sameNameDefinitions" | "other"; offset: number; limit: number } }): XrefSymbolReferences {
    const { symbol, classOffset, page } = request;
    const matchingMethods = index.methods.filter((method) => methodSymbol(method.name) === symbol || method.name === symbol);
    const localMethods = matchingMethods.filter((method) => method.classOffset === classOffset);
    const hasLocal = localMethods.length > 0;
    const localOffsets = new Set(localMethods.map((method) => method.methodOffset));
    const matchingOffsets = new Set(matchingMethods.map((method) => method.methodOffset));
    const strings = index.targets.filter((target) => target.kind === "string" && target.name === symbol);
    const stringOffsets = new Set(strings.map((target) => target.offset));
    const definitionScope = localMethods.length === 1 ? "method" : hasLocal ? "record" : "name";
    const methodTargets: XrefTarget[] = (hasLocal ? localMethods : matchingMethods).slice(0, 300).map((method) => ({
        key: `method:${method.methodOffset}`, kind: "method", offset: method.methodOffset,
        name: method.name, record: method.record, classOffset: method.classOffset,
    }));
    const entities: XrefSymbolMatches = {
        targets: [...strings.slice(0, 300), ...methodTargets].slice(0, 300),
        total: strings.length + (hasLocal ? localMethods.length : matchingMethods.length),
    };
    // A shared name string cannot identify which implementation is being registered.
    // Only a method operand with a selected offset can anchor the merged registration row.
    const localRegistrations = new Set<string>();
    if (hasLocal) {
        for (const site of index.sites) {
            if (site.resolution === "exact_operand" && site.targetKind === "method" && site.targetOffset !== null && localOffsets.has(site.targetOffset) && isDefinitionSite(site)) {
                localRegistrations.add(physicalSiteKey(site));
            }
        }
    }
    const rows: Record<"calls" | "definitions" | "sameNameDefinitions" | "other", XrefSite[]> = {
        calls: [], definitions: [], sameNameDefinitions: [], other: [],
    };
    const seen = { calls: new Set<string>(), definitions: new Set<string>(), sameNameDefinitions: new Set<string>(), other: new Set<string>() };
    const limits = { calls: 500, definitions: 100, sameNameDefinitions: 200, other: 200 } as const;
    for (const site of index.sites) {
        const definition = isDefinitionSite(site);
        const eligibleMethod = site.targetKind === "method" && site.targetOffset !== null && (definition || !hasLocal ? matchingOffsets : localOffsets).has(site.targetOffset);
        if (site.resolution !== "exact_operand" || !(eligibleMethod || site.targetKind === "string" && site.targetOffset !== null && stringOffsets.has(site.targetOffset))) continue;
        const key = physicalSiteKey(site);
        const group = definition ? localRegistrations.has(key) ? "definitions" : "sameNameDefinitions"
            : site.callPc !== undefined ? "calls" : "other";
        if (seen[group].has(key)) continue;
        seen[group].add(key);
        if (page) {
            const row = seen[group].size - 1;
            if (group === page.group && row >= Math.max(0, page.offset) && rows[group].length < Math.min(100, Math.max(1, page.limit))) rows[group].push(site);
        } else if (rows[group].length < limits[group]) rows[group].push(site);
    }
    return {
        entities, definitionScope,
        calls: { count: seen.calls.size, sites: rows.calls },
        definitions: { count: seen.definitions.size, sites: rows.definitions },
        sameNameDefinitions: { count: seen.sameNameDefinitions.size, sites: rows.sameNameDefinitions },
        other: { count: seen.other.size, sites: rows.other },
    };
}

export function methodSymbol(name: string): string {
    return name.slice(name.lastIndexOf("#") + 1).replace(/\^\d+$/, "");
}
