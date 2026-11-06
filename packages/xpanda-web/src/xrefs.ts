import {
    PandaField,
    PandaInstructionID,
    PandaLiteralArray,
    PandaMethod,
    PandaString,
    type PandaFile,
} from "xpanda-core";

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
    readonly targetCount: number;
    readonly siteCount: number;
    readonly scannedMethods: number;
    readonly failedMethods: number;
}

export interface XrefQuery {
    readonly direction: XrefDirection;
    readonly kind: XrefEntityKind | "all";
    readonly query: string;
    readonly selectedKey: string | null;
    readonly target?: XrefTarget;
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
export function querySymbolReferences(index: XrefIndex, symbol: string, classOffset: number): XrefSymbolReferences {
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
            if (site.resolution === "exact_operand" && site.targetKind === "method" && localOffsets.has(site.targetOffset) && isDefinitionSite(site)) {
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
        const eligibleMethod = site.targetKind === "method" && (definition || !hasLocal ? matchingOffsets : localOffsets).has(site.targetOffset);
        if (site.resolution !== "exact_operand" || !(eligibleMethod || site.targetKind === "string" && stringOffsets.has(site.targetOffset))) continue;
        const key = physicalSiteKey(site);
        const group = definition ? localRegistrations.has(key) ? "definitions" : "sameNameDefinitions"
            : site.callPc !== undefined ? "calls" : "other";
        if (seen[group].has(key)) continue;
        seen[group].add(key);
        if (rows[group].length < limits[group]) rows[group].push(site);
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

/** Names are candidates, never proof of a dynamic call's target. Offsets identify the chosen entity. */
export function lookupXrefSymbol(index: XrefIndex, symbol: string, classOffset: number): XrefSymbolMatches {
    const local: XrefTarget[] = [];
    const other: XrefTarget[] = [];
    let total = 0;
    for (const method of index.methods) {
        if (methodSymbol(method.name) !== symbol && method.name !== symbol) continue;
        total++;
        const list = method.classOffset === classOffset ? local : other;
        if (list.length < 300) list.push({ key: `method:${method.methodOffset}`, kind: "method", offset: method.methodOffset,
            name: method.name, record: method.record, classOffset: method.classOffset });
    }
    // Property names in dynamic calls are string operands; show them distinctly from method candidates.
    for (const target of index.targets) {
        if (target.kind !== "string" || target.name !== symbol) continue;
        total++;
        if (other.length < 300) other.push(target);
    }
    return { targets: [...local, ...other].slice(0, 300), total };
}

export interface XrefPage {
    readonly items: readonly (XrefTarget | XrefMethod)[];
    readonly itemCount: number;
    readonly selected: XrefTarget | XrefMethod | null;
    readonly sites: readonly XrefSite[];
    readonly siteCount: number;
}

/** Keep the complete index in its worker; only bounded query results cross the thread boundary. */
export function queryXrefIndex(index: XrefIndex, request: XrefQuery): XrefPage {
    const needle = request.query.trim().toLowerCase();
    const candidates = request.direction === "incoming" ? index.targets : index.methods;
    const items: (XrefTarget | XrefMethod)[] = [];
    let itemCount = 0;
    let selected: XrefTarget | XrefMethod | null = null;
    for (const item of candidates) {
        if (request.direction === "incoming" && "kind" in item && request.kind !== "all" && item.kind !== request.kind) continue;
        if (needle && !`${item.name} ${item.record ?? ""}`.toLowerCase().includes(needle)) continue;
        itemCount++;
        if (items.length < 300) items.push(item);
        if (selected === null || item.key === request.selectedKey) selected = item;
    }
    if (request.target) selected = request.target;
    const sites: XrefSite[] = [];
    let siteCount = 0;
    if (selected !== null) {
        for (const site of index.sites) {
            const matches = "kind" in selected
                ? site.resolution === "exact_operand" && site.targetKind === selected.kind && site.targetOffset === selected.offset
                : site.sourceClassOffset === selected.classOffset && site.sourceMethodOffset === selected.methodOffset
                    && (request.kind === "all" || site.targetKind === request.kind);
            if (!matches) continue;
            siteCount++;
            if (sites.length < 1000) sites.push(site);
        }
    }
    return { items, itemCount, selected, sites, siteCount };
}

const ID_KINDS: Record<string, XrefTargetKind> = {
    METHOD: "method",
    STRING: "string",
    FIELD: "field",
    LITERALARRAY: "literal_array",
    TYPE: "type",
};

const DYNAMIC_KINDS = new Set([
    "call", "superCall", "superCallSpread", "superCallForwardAllArgs", "newObjRange", "newObjSpread",
]);

function entityKind(value: unknown): XrefEntityKind | null {
    if (value instanceof PandaMethod) return "method";
    if (value instanceof PandaString) return "string";
    if (value instanceof PandaField) return "field";
    if (value instanceof PandaLiteralArray) return "literal_array";
    return null;
}

function entityName(value: PandaMethod | PandaString | PandaField | PandaLiteralArray, offset: number): string {
    if (value instanceof PandaMethod) return value.name.content;
    if (value instanceof PandaString) return value.content;
    if (value instanceof PandaField) return value.name.content;
    return `LiteralArray @0x${offset.toString(16)}`;
}

function parentOf(value: PandaMethod | PandaString | PandaField | PandaLiteralArray): { name?: { content?: string }; getOffset?: () => number } | null {
    return (value as unknown as { getParent?: () => { name?: { content?: string }; getOffset?: () => number } | null }).getParent?.() ?? null;
}

function relationFor(kind: XrefTargetKind, instructionKind: string, nested: boolean): string {
    if (nested) return kind === "literal_array" ? "nested_literal_array" : `literal_${kind}`;
    if (kind === "method") {
        if (instructionKind === "defineFunc") return "function_definition";
        if (instructionKind === "defineClassWithBuffer") return "class_constructor";
        return "method_reference";
    }
    return `${kind}_operand`;
}

function uniqueByOffset<T extends { getOffset(): number }>(items: T[]): T[] {
    const seen = new Set<number>();
    return items.filter((item) => {
        const offset = item.getOffset();
        if (seen.has(offset)) return false;
        seen.add(offset);
        return true;
    });
}

/** Build the same exact-operand index as xpanda-index, without Node or SQLite. */
export function buildXrefIndex(pandaFile: PandaFile, onProgress: (done: number, total: number) => void): XrefIndex {
    const targets = new Map<string, XrefTarget>();
    const methods: XrefMethod[] = [];
    const sites: XrefSite[] = [];
    const codedMethods = uniqueByOffset(pandaFile.getAllClasses()).flatMap((clazz) =>
        uniqueByOffset([...clazz.pandaMethods.values()])
            .filter((method) => method.methodCode !== null)
            .map((method) => ({ clazz, method })),
    );
    let failedMethods = 0;
    let scannedMethods = 0;
    const reportEvery = Math.max(1, Math.ceil(codedMethods.length / 80));

    for (const { clazz, method } of codedMethods) {
        const sourceClassOffset = clazz.getOffset();
        const sourceRecord = clazz.name.content;
        const sourceMethodOffset = method.getOffset();
        const sourceMethod = method.name.content;
        const methodKey = `${sourceClassOffset}:${sourceMethodOffset}`;
        methods.push({ key: methodKey, classOffset: sourceClassOffset, record: sourceRecord, methodOffset: sourceMethodOffset, name: sourceMethod });
        const methodTargets = new Map<string, XrefTarget>();
        const methodSites: XrefSite[] = [];
        try {
            const cfg = method.disAssemble();
            let instructionIndex = 0;
            const seen = new Set<string>();
            for (const block of cfg?.pandaIRBasicBlocks ?? []) {
                for (let blockIndex = 0; blockIndex < block.pandaInstructions.length; blockIndex++) {
                    const instruction = block.pandaInstructions[blockIndex];
                    const following = block.pandaInstructions[blockIndex + 1];
                    const propertyCall = /(?:ldobjbyname|ldthisbyname)$/.test(instruction.opcode.name) && following?.kind === "call";
                    const at = instructionIndex++;
                    const put = (
                        operandPath: string,
                        relation: string,
                        resolution: XrefSite["resolution"],
                        targetKind: XrefTargetKind | null = null,
                        targetOffset: number | null = null,
                        targetName: string | null = null,
                    ): void => {
                        const dedupeKey = `${instruction.pc}:${operandPath}`;
                        if (seen.has(dedupeKey)) return;
                        seen.add(dedupeKey);
                        methodSites.push({
                            id: `${methodKey}:${instruction.pc}:${operandPath}`,
                            sourceClassOffset,
                            sourceRecord,
                            sourceMethodOffset,
                            sourceMethod,
                            instructionIndex: at,
                            pc: instruction.pc,
                            block: block.name,
                            opcode: instruction.opcode.name,
                            operandPath,
                            relation,
                            resolution,
                            targetKind,
                            targetOffset,
                            targetName,
                            ...(propertyCall && targetKind === "string" && resolution === "exact_operand" ? { callPc: following.pc } : {}),
                        });
                    };

                    instruction.params.forEach((param, paramIndex) => {
                        if (!(param instanceof PandaInstructionID)) return;
                        const expectedKind = ID_KINDS[param.type];
                        const pending = [{ value: param.obj, kind: expectedKind, path: `param[${paramIndex}]`, nested: false }];
                        const visited = new Set<number>();
                        while (pending.length > 0) {
                            const current = pending.pop()!;
                            if (current.kind === "type") {
                                put(current.path, relationFor(current.kind, instruction.kind, current.nested), "unresolved_operand", current.kind);
                                continue;
                            }
                            if (current.value === null) {
                                put(current.path, relationFor(current.kind, instruction.kind, current.nested), "unresolved_operand", current.kind);
                                continue;
                            }
                            const resolvedKind = entityKind(current.value);
                            if (resolvedKind === null || resolvedKind !== current.kind) {
                                put(current.path, relationFor(current.kind, instruction.kind, current.nested), "unresolved_operand", current.kind);
                                continue;
                            }

                            const value = current.value as PandaMethod | PandaString | PandaField | PandaLiteralArray;
                            const offset = value.getOffset();
                            const key = `${resolvedKind}:${offset}`;
                            const parent = parentOf(value);
                            const targetName = entityName(value, offset);
                            methodTargets.set(key, {
                                key,
                                kind: resolvedKind,
                                offset,
                                name: targetName,
                                record: parent?.name?.content ?? null,
                                classOffset: parent?.getOffset?.() ?? null,
                            });
                            put(current.path, relationFor(current.kind, instruction.kind, current.nested), "exact_operand", resolvedKind, offset, targetName);

                            if (value instanceof PandaLiteralArray && !visited.has(offset)) {
                                visited.add(offset);
                                const literals = value.getLiterals();
                                for (let i = literals.length - 1; i >= 0; i--) {
                                    const child = literals[i];
                                    const childKind = entityKind(child);
                                    if (childKind !== null) {
                                        pending.push({ value: child, kind: childKind, path: `${current.path}.literal[${i}]`, nested: true });
                                    }
                                }
                            }
                        }
                    });

                    if (DYNAMIC_KINDS.has(instruction.kind)) put("$call", "dynamic_call", "unresolved_dynamic");
                    else if (instruction.kind === "callRuntime") put("$runtime", "runtime_intrinsic", "runtime_intrinsic");
                }
            }
            for (const [key, target] of methodTargets) targets.set(key, target);
            sites.push(...methodSites);
        } catch {
            failedMethods++;
        }
        scannedMethods++;
        if (scannedMethods % reportEvery === 0 || scannedMethods === codedMethods.length) {
            onProgress(scannedMethods, codedMethods.length);
        }
    }

    if (codedMethods.length === 0) onProgress(0, 0);
    return { targets: [...targets.values()], methods, sites, scannedMethods, failedMethods };
}
