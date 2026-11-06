import type { CallAnalysisUnit, CallSiteOutcome } from "./types";
import { transfer } from "./transfer";
import { mergeState, mergeValue, read, stateKey, unknownValue, unique, type FlowState, type Value } from "./values";

/** Deterministic, core-free finite worklist interpreter; inputs and outputs are structured-clone-safe. */
export function analyzeCallUnit(unit: CallAnalysisUnit): CallSiteOutcome[] {
    const incoming = new Map<number, FlowState>();
    const calls = new Map<number, Value>();
    const receivers = new Map<number, Value>();
    const first = unit.blocks[0];
    const queue: number[] = first ? [first.id] : [];
    if (first) {
        const values = new Map<string, Value>();
        if (unit.thisClasses?.length) values.set("p2", { atoms: unit.thisClasses, unknown: true, origins: unit.thisClasses.map(id => `owning-class-candidate:${id}`), reasons: ["Declaring method table suggests this type; rebinding and subclasses remain unknown"] });
        incoming.set(first.id, { values, tainted: false });
    }
    let steps = 0;
    while (queue.length > 0 && steps < unit.maxSteps) {
        const id = queue.shift();
        const block = unit.blocks.find((entry) => entry.id === id);
        const input = id === undefined ? undefined : incoming.get(id);
        if (!block || !input) continue;
        const state: FlowState = { values: new Map(input.values), tainted: input.tainted };
        for (const ins of block.instructions) {
            if (++steps > unit.maxSteps) break;
            if (ins.op === "call") {
                const value = read(state);
                const previous = calls.get(ins.pc);
                calls.set(ins.pc, previous ? mergeValue(previous, value) : value);
                const receiver = ins.receiver ? read(state, ins.receiver) : unknownValue("Implicit/undefined receiver");
                const previousReceiver = receivers.get(ins.pc);
                receivers.set(ins.pc, previousReceiver ? mergeValue(previousReceiver, receiver) : receiver);
            }
            transfer(ins, state, unit);
        }
        for (const successor of block.successors) {
            const previous = incoming.get(successor);
            const merged = previous ? mergeState(previous, state) : state;
            if (!previous || stateKey(previous) !== stateKey(merged)) {
                incoming.set(successor, merged);
                if (!queue.includes(successor)) queue.push(successor);
            }
        }
    }
    const budgetIssues = steps > unit.maxSteps || steps >= unit.maxSteps && queue.length > 0 ? ["Control-flow/instruction budget exceeded; pending paths retain Unknown"] : [];
    return unit.sites.map((site): CallSiteOutcome => {
        const value = calls.get(site.pc) ?? unknownValue("Candidate is unreachable or is not a modeled call instruction");
        const issues = [...unit.issues, ...budgetIssues];
        const possibleMethodIds = [...new Set(value.atoms.filter((atom) => atom.startsWith("f:")).map((atom) => Number(atom.slice(2))))].sort((a, b) => a - b);
        const hasUnknown = value.unknown || issues.length > 0;
        const matches = possibleMethodIds.filter((id) => unit.selectedMethodOffsets.includes(id));
        const relation = matches.length > 0 ? !hasUnknown && possibleMethodIds.length === 1 ? "resolved" : "possible"
            : !hasUnknown && possibleMethodIds.length > 0 ? "excluded" : "unresolved";
        return { siteId: site.siteId, sourceMethodOffset: unit.sourceMethodOffset, pc: site.pc,
            relation, possibleMethodIds, receiverOrigin: unique(receivers.get(site.pc)?.origins ?? []), hasUnknown,
            reasons: unique([...value.reasons, ...issues, ...(hasUnknown ? ["Unknown alternatives remain; listed method IDs are not exhaustive"] : [])]),
            evidence: unique(value.origins),
        };
    });
}
