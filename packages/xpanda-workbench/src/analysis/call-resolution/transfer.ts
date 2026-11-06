import type { CallAnalysisUnit, CallInstruction } from "./types";
import { atomValue, mergeValue, read, unknownValue, unique, type FlowState, type Value } from "./values";

function propertyValue(receiver: Value, ins: CallInstruction, context: { readonly unit: CallAnalysisUnit; readonly state: FlowState }): Value {
    const property = ins.property ?? "?";
    let result: Value = { atoms: [], unknown: receiver.unknown, origins: receiver.origins, reasons: receiver.reasons };
    for (const atom of receiver.atoms) {
        if (atom.startsWith("c:") || atom.startsWith("i:")) {
            const classId = atom.slice(2);
            const klass = context.unit.classes.find((entry) => entry.id === classId);
            const table = atom.startsWith("i:") ? klass?.instanceMethods : klass?.staticMethods;
            const fields = atom.startsWith("i:") ? klass?.fieldClasses?.[property] : undefined;
            if (fields?.length) result = mergeValue(result, { atoms: fields.map(id => `i:${id}`), unknown: true, origins: [`constructor-field-candidate:${classId}.${property}`], reasons: ["Constructor-field summary is a weak candidate; writes, paths and lexical context remain unknown"] });
            const target = table?.[property];
            if (target !== undefined) {
                const value = atomValue(`f:${target}`, `class-definition:${classId}.${property}`);
                // Constructors, own fields, accessors and mutable prototype chains are not interpreted here.
                result = mergeValue(result, { ...value, unknown: true, reasons: ["Class table candidate; own-field/prototype/constructor effects remain unknown"] });
            } else {
                const parent = read(context.state, `$parent:${classId}`);
                if (parent.atoms.some((entry) => entry.startsWith("c:"))) {
                    // Preserve inheritance candidates while preventing recursive parent chains from claiming closure.
                    const inherited = parent.atoms.flatMap((entry) => {
                        const parentClass = context.unit.classes.find((candidate) => candidate.id === entry.slice(2));
                        const method = (atom.startsWith("i:") ? parentClass?.instanceMethods : parentClass?.staticMethods)?.[property];
                        return method === undefined ? [] : [`f:${method}`];
                    });
                    result = mergeValue(result, { atoms: inherited, unknown: true, origins: parent.origins, reasons: ["Inherited table candidate; recursive/dynamic ancestry remains unknown"] });
                } else result = mergeValue(result, unknownValue("Property absent from bounded class table"));
            }
        } else if (atom.startsWith("f:") && (property === "call" || property === "apply")) {
            result = mergeValue(result, { ...atomValue(atom, `function.${property} alias`), unknown: true,
                reasons: [`Function.prototype.${property} may be replaced; indirect invocation is a candidate only`] });
        } else if (atom.startsWith("e:")) {
            result = mergeValue(result, { ...atomValue(`${atom}.${property}`, `${atom.slice(2)}.${property}`), unknown: true,
                reasons: ["Import/native provenance is not function identity proof"] });
        } else result = mergeValue(result, unknownValue(`Unmodeled property ${property}`));
    }
    if (context.state.tainted) result = mergeValue(result, unknownValue("Property writes, escapes or opaque side effects may change dispatch"));
    return result;
}

/** Mutates only the private transfer state owned by one worklist visit. */
export function transfer(ins: CallInstruction, state: FlowState, unit: CallAnalysisUnit): void {
    switch (ins.op) {
        case "copy": state.values.set(ins.dest ?? "acc", read(state, ins.src)); return;
        case "constant": state.values.set("acc", atomValue("k:primitive", `constant@${ins.pc}`)); return;
        case "function": state.values.set("acc", ins.methodId === undefined ? unknownValue("Missing method ID") : atomValue(`f:${ins.methodId}`, `method:${ins.methodId}@${ins.pc}`)); return;
        case "class": {
            if (!ins.classId) { state.values.set("acc", unknownValue("Missing class definition identity")); return; }
            state.values.set(`$parent:${ins.classId}`, ins.src ? read(state, ins.src) : unknownValue("Superclass unavailable"));
            state.values.set("acc", atomValue(`c:${ins.classId}`, `class-definition:${ins.classId}`)); return;
        }
        case "object": state.values.set("acc", { ...atomValue(`o:${unit.sourceMethodOffset}:${ins.pc}`, `allocation@${ins.pc}`), unknown: true, reasons: ["Object literal contents are not modeled"] }); return;
        case "property": state.values.set("acc", propertyValue(read(state, ins.receiver), ins, { unit, state })); return;
        case "construct": {
            const constructor = read(state, ins.src);
            state.values.set("acc", { atoms: constructor.atoms.filter((atom) => atom.startsWith("c:")).map((atom) => `i:${atom.slice(2)}`), unknown: true,
                origins: constructor.origins, reasons: unique([...constructor.reasons, "Constructor return, own fields and effects are not modeled"]) });
            state.tainted = true; return;
        }
        case "import": state.values.set("acc", { ...atomValue(`e:${ins.provenance ?? "unknown"}`, ins.provenance ?? "unknown import"), unknown: true, reasons: ["External binding identity is not proven"] }); return;
        case "call": {
            const callee = read(state);
            const receiver = ins.receiver ? read(state, ins.receiver) : callee;
            state.values.set("acc", { ...unknownValue("Opaque/recursive callee return is not modeled"),
                origins: unique([...callee.origins, ...receiver.origins]).slice(0, 16) });
            state.tainted = true; return;
        }
        case "opaque":
            state.values.set("acc", unknownValue(ins.provenance ?? `Unmodeled value from ${ins.opcode}`)); state.tainted = true; return;
        case "write":
            state.tainted = true;
            if (ins.dest === "acc") state.values.set("acc", unknownValue(`Heap-operation result from ${ins.opcode} is unknown`));
            return;
        case "unknown": {
            for (const key of state.values.keys()) state.values.set(key, unknownValue(`Unsupported semantics: ${ins.opcode}`));
            state.values.set("acc", unknownValue(`Unsupported semantics: ${ins.opcode}`)); state.tainted = true; return;
        }
        case "keep": return;
        default: return assertNever(ins.op);
    }
}
function assertNever(value: never): never { throw new TypeError(`Unexpected instruction operation: ${String(value)}`); }
