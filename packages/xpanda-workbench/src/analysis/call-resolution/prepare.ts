import { OPCODE_FLAG, PandaInstructionID, PandaString, type PandaFile, type PandaMethod } from "xpanda-core";
import { ClassFacts } from "./class-facts";
import type { XrefSite } from "../xrefs";
import type { CallAnalysisPlan, CallAnalysisUnit, CallClass, CallInstruction } from "./types";

type PandaInstruction = NonNullable<ReturnType<PandaMethod["disAssemble"]>>["pandaIRBasicBlocks"][number]["pandaInstructions"][number];

const ASSUMPTIONS = [
    "Intraprocedural value flow over normal CFG edges; parameters, captured/module values and opaque returns retain Unknown.",
    "Runtime class identity is the define-class site plus constructor method ID, never the file record name.",
    "Method tables are candidate evidence. Construction, writes, escapes and opaque effects prevent exact property-target claims.",
    "Module-entry and constructor-field summaries are weak candidate hints; lexical context, fields and receiver binding remain unknown.",
    "Imports, including native modules, provide provenance only. No module API or unmodified Function.prototype assumption is made.",
    "Exceptions, unsupported semantics and analysis budgets retain Unknown; this bounded model does not claim absolute soundness.",
] as const;

function register(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null || !("type" in value) || !("index" in value)) return undefined;
    if ((value.type !== "PARAM" && value.type !== "VREG") || typeof value.index !== "number") return undefined;
    return `${value.type === "PARAM" ? "p" : "v"}${value.index}`;
}
function namedProperty(ins: PandaInstruction): string | undefined {
    for (const param of ins.params) {
        if (param instanceof PandaInstructionID && param.obj instanceof PandaString) return param.obj.content;
    }
    return undefined;
}
function instruction(ins: PandaInstruction, classes: CallClass[], methodId: number): CallInstruction {
    const base = { pc: ins.pc, opcode: ins.opcode.name };
    const src = register(ins.srcObj);
    const dest = register(ins.destObj);
    switch (ins.kind) {
        case "mov": return src && dest ? { ...base, op: "copy", src, dest } : { ...base, op: "unknown" };
        case "store": return dest ? { ...base, op: "copy", src: "acc", dest } : { ...base, op: "unknown" };
        case "load": {
            const source = register(ins.loadParam);
            if (source) return { ...base, op: "copy", src: source, dest: "acc" };
            if (ins.opcode.name === "ldthis") return { ...base, op: "copy", src: "p2", dest: "acc" };
            if (/^(?:ldai|fldai|lda.str|ldtrue|ldfalse|ldnull|ldundefined|ldhole|ldnan|ldinfinity|ldbigint)$/.test(ins.opcode.name)) return { ...base, op: "constant" };
            return { ...base, op: "unknown" };
        }
        case "defineFunc": return ins.func ? { ...base, op: "function", methodId: ins.func.getOffset() } : { ...base, op: "unknown" };
        case "defineClassWithBuffer": {
            if (!ins.constructorMethod) return { ...base, op: "unknown" };
            const id = `${methodId}:${ins.pc}:${ins.constructorMethod.getOffset()}`;
            classes.push({ id, constructorId: ins.constructorMethod.getOffset(),
                instanceMethods: Object.fromEntries(ins.methodDescriptions.map((m) => [m.protoMethodName, m.method.getOffset()])),
                staticMethods: Object.fromEntries(ins.staticMethodDescriptions.map((m) => [m.protoMethodName, m.method.getOffset()])),
            });
            const parent = register(ins.protoReg);
            return { ...base, op: "class", classId: id, ...(parent ? { src: parent } : {}) };
        }
        case "loadObjectBy": {
            const property = namedProperty(ins);
            if (/^(?:wide\.)?ld(?:obj|this)byname$/.test(ins.opcode.name) && property !== undefined) {
                return { ...base, op: "property", property, receiver: ins.opcode.name.includes("ldthis") ? "p2" : "acc" };
            }
            return { ...base, op: "unknown" };
        }
        case "loadExternalModuleVar": {
            const module = ins.module;
            return { ...base, op: "import", provenance: module ? module.toString() : "unresolved import" };
        }
        case "unary":
            return /^(?:istrue|isfalse)$/.test(ins.opcode.name) ? { ...base, op: "constant" } : { ...base, op: "opaque", provenance: `Unresolved value from ${ins.opcode.name}` };
        case "loadLex": case "loadModuleVar": case "binaryOp":
            return { ...base, op: "opaque", provenance: `Unresolved value from ${ins.opcode.name}` };
        case "loadGlobal": return { ...base, op: "import", provenance: `global:${ins.globalName?.content ?? "unknown"}` };
        case "newObjRange": {
            const constructor = register(ins.objectVReg);
            return constructor ? { ...base, op: "construct", src: constructor } : { ...base, op: "unknown" };
        }
        case "call": {
            const receiver = register(ins.thisObj);
            return { ...base, op: "call", ...(receiver ? { receiver } : {}) };
        }
        case "createObject": case "createArray": return { ...base, op: "object" };
        case "storeObject": case "storeByIndex": case "storeArraySpread": case "deleteObjProp":
        case "storeSuperObj": case "setObjectWithProto": case "copyDataProperties":
        case "defineGetterSetterByValue": case "storeModuleVar": case "storeObjectRecord": case "storeLex":
            return { ...base, op: "write", ...(ins.opcode.flags & OPCODE_FLAG.ACC_WRITE ? { dest: "acc" } : {}) };
        case "nop": case "jumpDirect": case "jumpEqual": case "jumpNotEqual": case "jumpPlain":
        case "return": case "throw": case "throwIf": case "assert": case "newLexEnv": case "popLexEnv":
            return { ...base, op: "keep" };
        default: return { ...base, op: "unknown" };
    }
}

/** Prepare only methods containing the requested physical candidate sites. */
export function prepareCallAnalysis(file: PandaFile, sites: readonly XrefSite[], selectedMethodOffsets: readonly number[]): CallAnalysisPlan {
    const grouped = new Map<number, XrefSite[]>();
    for (const site of sites) {
        const rows = grouped.get(site.sourceMethodOffset) ?? [];
        rows.push(site);
        grouped.set(site.sourceMethodOffset, rows);
    }
    const methods = new Map(file.getAllClasses().flatMap((record) => [...record.pandaMethods.values()].map((m) => [m.getOffset(), m] as const)));
    const facts = new ClassFacts(file);
    const units: CallAnalysisUnit[] = [];
    const preparationIssues: string[] = [];
    for (const [offset, rows] of [...grouped].sort(([a], [b]) => a - b)) {
        const classes: CallClass[] = [];
        const issues: string[] = selectedMethodOffsets.length ? [] : ["Target method ID unavailable; name alone cannot identify an implementation"];
        const method = methods.get(offset);
        let blocks: CallAnalysisUnit["blocks"] = [];
        // Preparation is a parser boundary: report malformed/unsupported methods instead of dropping their sites.
        try {
            if (!method?.methodCode) issues.push("Method body unavailable");
            else if (method.methodCode.codeSize > 250_000) issues.push("Method preparation byte budget exceeded");
            else {
                const cfg = method.disAssemble();
                if (method.methodCode.triesSize > 0) issues.push("Exception edges are not modeled; exception paths retain Unknown");
                if (!cfg) issues.push("Method CFG unavailable");
                else blocks = cfg.pandaIRBasicBlocks.map((block) => {
                    const successors = cfg.graph.normalSuccessors(block).map((next) => next.getStartPC());
                    const terminator = block.getTerminator();
                    if (terminator.isJump() && !successors.includes(terminator.destinationPC)) {
                        issues.push(`Incomplete CFG jump at PC ${terminator.pc}; missing paths retain Unknown`);
                    }
                    return { id: block.getStartPC(), successors,
                        instructions: block.pandaInstructions.map((ins) => instruction(ins, classes, offset)) };
                });
            }
        } catch (error) {
            if (!(error instanceof Error)) throw error;
            issues.push(`Method preparation failed: ${error.message}`);
        }
        const context = method ? facts.forMethod(method) : { classes: [], thisClasses: [] };
        for (const klass of context.classes) if (!classes.some(candidate => candidate.id === klass.id)) classes.push(klass);
        for (const issue of issues) preparationIssues.push(`${offset}: ${issue}`);
        units.push({ sourceMethodOffset: offset, selectedMethodOffsets: [...selectedMethodOffsets].sort((a, b) => a - b),
            sites: rows.map((site) => ({ siteId: site.id, pc: site.callPc ?? site.pc })),
            blocks, classes, thisClasses: context.thisClasses, issues, maxSteps: 20_000 });
    }
    return { units, assumptions: ASSUMPTIONS, preparationIssues };
}
