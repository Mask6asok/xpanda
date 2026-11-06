/** A finite set plus an independent Unknown bit; a singleton partial set is never exact. */
export interface Value {
    readonly atoms: readonly string[];
    readonly unknown: boolean;
    readonly origins: readonly string[];
    readonly reasons: readonly string[];
}
export interface FlowState {
    readonly values: Map<string, Value>;
    tainted: boolean;
}
export const unknownValue = (reason: string): Value => ({ atoms: [], unknown: true, origins: [], reasons: [reason] });
export const atomValue = (atom: string, origin: string): Value => ({ atoms: [atom], unknown: false, origins: [origin], reasons: [] });
export const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();
export function mergeValue(left: Value, right: Value): Value {
    const atoms = unique([...left.atoms, ...right.atoms]);
    return { atoms: atoms.slice(0, 32), unknown: left.unknown || right.unknown || atoms.length > 32,
        origins: unique([...left.origins, ...right.origins]).slice(0, 16),
        reasons: unique([...left.reasons, ...right.reasons, ...(atoms.length > 32 ? ["Value-set budget exceeded"] : [])]).slice(0, 16) };
}
export function read(state: FlowState, key = "acc"): Value {
    return state.values.get(key) ?? unknownValue(key === "p2" ? "Unbound this receiver" : `Unbound ${key}`);
}
export function mergeState(left: FlowState, right: FlowState): FlowState {
    const values = new Map<string, Value>();
    for (const key of unique([...left.values.keys(), ...right.values.keys()])) values.set(key, mergeValue(read(left, key), read(right, key)));
    return { values, tainted: left.tainted || right.tainted };
}
export function stateKey(state: FlowState): string {
    return JSON.stringify([state.tainted, [...state.values].sort(([a], [b]) => a.localeCompare(b))]);
}
