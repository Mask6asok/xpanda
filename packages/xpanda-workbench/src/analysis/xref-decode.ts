import { decodeInstructions, OPCODE_FLAG } from "xpanda-core";

export interface XrefDecodeUnit {
    readonly code: Uint8Array;
    readonly registers: number;
    readonly hasModuleData: boolean;
    readonly namespaceCount: number;
    readonly boundaries: readonly number[];
    readonly catches: readonly { readonly pc: number; readonly size: number }[];
}
export interface XrefDecoded { readonly rows: Uint32Array; readonly fallback: boolean }
// Each row: PC, opcode code, instruction ordinal, block start, next call PC,
// operand index, raw ID. Special rows have no operand (NONE).
export const XREF_ROW_SIZE = 7;
export const XREF_NONE = 0xffffffff;
const CALLS = new Set([
    "callarg0", "callarg1", "callargs1", "callargs2", "callargs3", "callrange", "wide.callrange",
    "callthis0", "callthis1", "callthis2", "callthis3", "callthisrange", "wide.callthisrange", "apply",
    "callthis0withname", "callthis1withname", "callthis2withname", "callthis3withname",
    "callthisrangewithname", "wide.callthisrangewithname",
]);
const DYNAMIC = new Set([...CALLS, "supercallthisrange", "supercallarrowrange", "wide.supercallthisrange",
    "wide.supercallarrowrange", "supercallspread", "callruntime.supercallforwardallargs", "newobjrange", "newobjapply"]);
// definefield instructions are classified as storeObject by core's last registration.
const RUNTIME = new Set(["callruntime.callinit", "callruntime.isfalse", "callruntime.istrue", "callruntime.notifyconcurrentresult"]);
export function xrefInstructionKind(name: string): string {
    if (DYNAMIC.has(name)) return "call";
    if (RUNTIME.has(name)) return "callRuntime";
    if (name === "definefunc" || name === "definemethod") return "defineFunc";
    if (name === "defineclasswithbuffer" || name === "callruntime.definesendableclass") return "defineClassWithBuffer";
    return "other";
}

/** Index-only decoding does not construct decompiler instructions, lexical state, or CFG edges. */
export function decodeXrefUnit(unit: XrefDecodeUnit): XrefDecoded {
    try {
        const instructions = decodeInstructions(unit.code);
        const last = instructions[instructions.length - 1];
        const terminates = (flags: number, name: string): boolean => !!(flags & (OPCODE_FLAG.JUMP | OPCODE_FLAG.RETURN)) || name === "throw";
        if (!last || !terminates(last.opcode.flags, last.opcode.name)) throw new Error("Unterminated method");
        const pcs = new Set(instructions.map(instruction => instruction.pc));
        const starts = new Set([0, ...unit.boundaries]);
        for (const handler of unit.catches) {
            starts.add(handler.pc);
            if (handler.pc + handler.size <= last.pc) starts.add(handler.pc + handler.size);
        }
        for (const instruction of instructions) {
            const { opcode, operands, pc, size } = instruction;
            if ((/modulevar$/.test(opcode.name) || /getmodulenamespace$/.test(opcode.name)) && !unit.hasModuleData) throw new Error("Missing module metadata");
            if (/getmodulenamespace$/.test(opcode.name) && operands[0] >= unit.namespaceCount) throw new Error("Invalid namespace index");
            if (["jeq", "jne", "jstricteq", "jnstricteq"].includes(opcode.name)) throw new Error("Core requires fallback");
            opcode.operands.forEach((operand, index) => {
                if (operand.kind === "v" && operands[index] > unit.registers) throw new Error("Invalid register");
            });
            if (opcode.flags & OPCODE_FLAG.JUMP) {
                let imm = opcode.operands.length - 1;
                while (imm >= 0 && opcode.operands[imm].kind !== "imm") imm--;
                starts.add(pc + operands[imm]);
            }
            if (terminates(opcode.flags, opcode.name) && pc + size < unit.code.length) starts.add(pc + size);
        }
        for (const pc of starts) if (!pcs.has(pc)) throw new Error("Invalid block boundary");
        const rows: number[] = [];
        let block = 0;
        instructions.forEach((instruction, ordinal) => {
            const { opcode, pc, operands } = instruction;
            if (starts.has(pc)) block = pc;
            const next = instructions[ordinal + 1];
            const callPc = /(?:ldobjbyname|ldthisbyname)$/.test(opcode.name) && next && !starts.has(next.pc) && CALLS.has(next.opcode.name) ? next.pc : XREF_NONE;
            opcode.operands.forEach((operand, index) => {
                if (operand.kind === "id") rows.push(pc, opcode.code, ordinal, block, callPc, index, operands[index]);
            });
            if (DYNAMIC.has(opcode.name) || RUNTIME.has(opcode.name)) rows.push(pc, opcode.code, ordinal, block, XREF_NONE, XREF_NONE, 0);
        });
        return { rows: new Uint32Array(rows), fallback: false };
    } catch {
        // Unsupported/malformed methods retain the original scanner's failure semantics.
        return { rows: new Uint32Array(), fallback: true };
    }
}
