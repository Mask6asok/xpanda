import { PandaInstructionID, PandaString, type PandaFile, type PandaMethod, type PandaClass } from "xpanda-core";
import type { CallClass } from "./types";

type Ins = NonNullable<ReturnType<PandaMethod["disAssemble"]>>["pandaIRBasicBlocks"][number]["pandaInstructions"][number];
const symbol = (name: string) => name.slice(name.lastIndexOf("#") + 1).replace(/\^\d+$/, "");
const key = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || !("type" in value) || !("index" in value)) return undefined;
    return (value.type === "PARAM" || value.type === "VREG") && typeof value.index === "number" ? `${value.type}:${value.index}` : undefined;
};
function property(ins: Ins): string | undefined {
    const id = ins.params.find((param: unknown) => param instanceof PandaInstructionID && param.obj instanceof PandaString);
    return id instanceof PandaInstructionID && id.obj instanceof PandaString ? id.obj.content : undefined;
}
interface Definition { readonly model: CallClass; readonly constructor: PandaMethod }

/** Weak provenance only: these summaries never remove Unknown or prove an invocation target. */
export class ClassFacts {
    private readonly records: Map<string, PandaClass>;
    private readonly definitions = new Map<number, readonly Definition[]>();
    private readonly mainInstructions = new Map<number, readonly Ins[]>();
    constructor(file: PandaFile) { this.records = new Map(file.getAllClasses().map(record => [record.name.content, record])); }
    private main(record: PandaClass): readonly Ins[] {
        const cached = this.mainInstructions.get(record.getOffset());
        if (cached) return cached;
        const entry = record.pandaMethods.get("func_main_0");
        let instructions: readonly Ins[] = [];
        try { if (entry?.methodCode && entry.methodCode.codeSize < 250_000) instructions = entry.disAssemble()?.pandaIRBasicBlocks.flatMap(block => block.pandaInstructions) ?? []; }
        catch (error) { if (!(error instanceof Error)) throw error; }
        this.mainInstructions.set(record.getOffset(), instructions); return instructions;
    }
    private models(record: PandaClass): readonly Definition[] {
        const cached = this.definitions.get(record.getOffset()); if (cached) return cached;
        const entry = record.pandaMethods.get("func_main_0");
        const result: Definition[] = [];
        for (const ins of this.main(record)) if (ins.kind === "defineClassWithBuffer" && ins.constructorMethod) result.push({
            constructor: ins.constructorMethod,
            model: { id: `${entry?.getOffset()}:${ins.pc}:${ins.constructorMethod.getOffset()}`, constructorId: ins.constructorMethod.getOffset(),
                instanceMethods: Object.fromEntries(ins.methodDescriptions.map(item => [item.protoMethodName, item.method.getOffset()])),
                staticMethods: Object.fromEntries(ins.staticMethodDescriptions.map(item => [item.protoMethodName, item.method.getOffset()])) },
        });
        // Older/ArkUI output installs many methods after defineclasswithbuffer.
        const tables = new Map(result.map(definition => [definition.model.id, { instance: { ...definition.model.instanceMethods }, statics: { ...definition.model.staticMethods } }]));
        const registers = new Map<string, string>();
        let acc: string | undefined;
        for (const ins of this.main(record)) {
            switch (ins.kind) {
                case "defineClassWithBuffer": acc = `c:${entry?.getOffset()}:${ins.pc}:${ins.constructorMethod?.getOffset()}`; break;
                case "defineFunc": acc = ins.func ? `f:${ins.func.getOffset()}` : undefined; break;
                case "store": { const dest = key(ins.destObj); if (dest) { if (acc) registers.set(dest, acc); else registers.delete(dest); } break; }
                case "mov": { const dest = key(ins.destObj), src = key(ins.srcObj); if (dest) { const value = src ? registers.get(src) : undefined; if (value) registers.set(dest, value); else registers.delete(dest); } break; }
                case "load": acc = registers.get(key(ins.loadParam) ?? ""); break;
                case "loadObjectBy": acc = acc?.startsWith("c:") && property(ins) === "prototype" ? `p:${acc.slice(2)}` : undefined; break;
                case "storeObject": {
                    const receiver = registers.get(key(ins.storeKeyObj) ?? "");
                    const name = property(ins);
                    if (receiver && name && acc?.startsWith("f:")) {
                        const table = tables.get(receiver.slice(2));
                        if (table && receiver.startsWith("p:")) table.instance[name] = Number(acc.slice(2));
                        else if (table && receiver.startsWith("c:")) table.statics[name] = Number(acc.slice(2));
                    }
                    break;
                }
                case "nop": case "throwIf": case "jumpDirect": case "jumpEqual": case "jumpNotEqual": case "jumpPlain": break;
                default: acc = undefined; break;
            }
        }
        const expanded = result.map(definition => ({ ...definition, model: { ...definition.model, instanceMethods: tables.get(definition.model.id)?.instance ?? definition.model.instanceMethods, staticMethods: tables.get(definition.model.id)?.statics ?? definition.model.staticMethods } }));
        this.definitions.set(record.getOffset(), expanded); return expanded;
    }
    private imported(ins: Ins): readonly CallClass[] {
        const module = ins.module;
        if (!module || !("path" in module) || !("importName" in module) || !module.path.startsWith("@normalized:")) return [];
        const recordName = `L${module.path.slice("@normalized:".length).split("&").slice(2).join("&")};`;
        const record = this.records.get(recordName); if (!record) return [];
        const models = this.models(record);
        // Alias/default/namespace ambiguity stays unknown rather than guessing a constructor name.
        return models.filter(definition => symbol(definition.constructor.name.content) === module.importName).map(definition => definition.model);
    }
    forMethod(method: PandaMethod): { classes: CallClass[]; thisClasses: string[] } {
        const record = method.getParent(); if (!record) return { classes: [], thisClasses: [] };
        const definitions = this.models(record);
        const owners = definitions.filter(definition => definition.model.constructorId === method.getOffset()
            || Object.values(definition.model.instanceMethods).includes(method.getOffset())
            || Object.values(definition.model.staticMethods).includes(method.getOffset()));
        const classes = new Map<string, CallClass>();
        const lexical = new Map<number, readonly string[]>();
        this.collect(this.main(record), classes, lexical);
        const thisClasses: string[] = [];
        for (const owner of owners) {
            const model = owner.model;
            const fieldClasses: Record<string, readonly string[]> = {};
            try {
                const instructions = owner.constructor.methodCode && owner.constructor.methodCode.codeSize < 250_000 ? owner.constructor.disAssemble()?.pandaIRBasicBlocks.flatMap(block => block.pandaInstructions) ?? [] : [];
                if (instructions.length < 20_000) this.collect(instructions, classes, lexical, fieldClasses);
            } catch (error) { if (!(error instanceof Error)) throw error; }
            classes.set(model.id, { ...model, fieldClasses });
            thisClasses.push(`${Object.values(model.staticMethods).includes(method.getOffset()) ? "c" : "i"}:${model.id}`);
        }
        return { classes: [...classes.values()], thisClasses };
    }
    private collect(instructions: readonly Ins[], classes: Map<string, CallClass>, lexical: Map<number, readonly string[]>, fields?: Record<string, readonly string[]>): void {
        const bindings = new Map<string, readonly string[]>();
        const thisAliases = new Set(["PARAM:2"]);
        let acc: readonly string[] = [];
        for (const ins of instructions) {
            const dest = key(ins.destObj), src = key(ins.srcObj);
            switch (ins.kind) {
                case "loadExternalModuleVar": {
                    const imported = this.imported(ins); for (const model of imported) classes.set(model.id, model);
                    acc = imported.map(model => model.id); break;
                }
                case "loadLex": acc = lexical.get(ins.lexIndex) ?? []; break;
                case "storeLex": lexical.set(ins.lexIndex, [...new Set([...(lexical.get(ins.lexIndex) ?? []), ...acc])]); break;
                case "load": acc = bindings.get(key(ins.loadParam) ?? "") ?? []; break;
                case "store": if (dest) bindings.set(dest, acc); break;
                case "mov":
                    if (dest) { bindings.set(dest, src ? bindings.get(src) ?? [] : []); if (src && thisAliases.has(src)) thisAliases.add(dest); else thisAliases.delete(dest); }
                    break;
                case "newObjRange": acc = bindings.get(key(ins.objectVReg) ?? "") ?? []; break;
                case "storeObject": {
                    const name = property(ins);
                    if (fields && name && (thisAliases.has(key(ins.storeKeyObj) ?? "") || /stthisbyname$/.test(ins.opcode.name))) fields[name] = [...new Set([...(fields[name] ?? []), ...acc])];
                    break;
                }
                default: acc = []; break;
            }
        }
    }
}
