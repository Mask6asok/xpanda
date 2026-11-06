import {
    PandaField,
    PandaInstructionID,
    PandaLiteralArray,
    PandaMethod,
    PandaString,
    type PandaFile,
    type PandaClass,
} from "xpanda-core";

import type { XrefEntityKind, XrefIndex, XrefTarget, XrefTargetKind, XrefMethod, XrefSite } from "./xrefs";

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
    return value instanceof PandaMethod || value instanceof PandaField ? value.getParent() : null;
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

export interface XrefMethodEntry { readonly clazz: PandaClass; readonly method: PandaMethod }
export interface XrefInstruction {
    readonly pc: number;
    readonly opcode: { readonly name: string };
    readonly kind: string;
    readonly params: readonly unknown[];
    readonly ordinal?: number;
    readonly callPc?: number;
}
export interface XrefBlock { readonly name: string; readonly pandaInstructions: readonly XrefInstruction[] }
export function codedXrefMethods(pandaFile: PandaFile): XrefMethodEntry[] {
    return uniqueByOffset(pandaFile.getAllClasses()).flatMap((clazz) =>
        uniqueByOffset([...clazz.pandaMethods.values()])
            .filter((method) => method.methodCode !== null)
            .map((method) => ({ clazz, method })),
    );
}

/** The original CFG scanner is retained as the oracle and per-method fallback. */
export function buildXrefIndex(pandaFile: PandaFile, onProgress: (done: number, total: number) => void): XrefIndex {
    return scanXrefMethods(codedXrefMethods(pandaFile), onProgress);
}
export function scanXrefMethods(codedMethods: readonly XrefMethodEntry[], onProgress: (done: number, total: number) => void,
    blocksFor: (entry: XrefMethodEntry, index: number) => readonly XrefBlock[] = ({ method }) => method.disAssemble()?.pandaIRBasicBlocks ?? [],
): XrefIndex {
    const targets = new Map<string, XrefTarget>();
    const methods: XrefMethod[] = [];
    const sites: XrefSite[] = [];
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
            const blocks = blocksFor({ clazz, method }, scannedMethods);
            let instructionIndex = 0;
            const seen = new Set<string>();
            for (const block of blocks) {
                for (let blockIndex = 0; blockIndex < block.pandaInstructions.length; blockIndex++) {
                    const instruction = block.pandaInstructions[blockIndex];
                    const following = block.pandaInstructions[blockIndex + 1];
                    const propertyCall = instruction.ordinal === undefined && /(?:ldobjbyname|ldthisbyname)$/.test(instruction.opcode.name) && following?.kind === "call";
                    const at = instruction.ordinal ?? instructionIndex++;
                    const callPc = instruction.callPc ?? (propertyCall ? following?.pc : undefined);
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
                            ...(callPc !== undefined && targetKind === "string" && resolution === "exact_operand" ? { callPc } : {}),
                        });
                    };

                    instruction.params.forEach((param, paramIndex) => {
                        if (!(param instanceof PandaInstructionID)) return;
                        const expectedKind = ID_KINDS[param.type];
                        const pending = [{ value: param.obj, kind: expectedKind, path: `param[${paramIndex}]`, nested: false }];
                        const visited = new Set<number>();
                        while (pending.length > 0) {
                            const current = pending.pop();
                            if (!current) break;
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
