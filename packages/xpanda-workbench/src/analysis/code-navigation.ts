import { NodeFactory } from "xpanda-core";
import { methodSymbol, type XrefSite } from "./xrefs";

export interface CodeDeclaration {
    readonly name: string;
    readonly line: number;
    readonly label: string;
}

interface AstNode {
    readonly type: string;
    readonly [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
    return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function nodeName(value: unknown): string | null {
    if (!isNode(value)) return null;
    switch (value.type) {
        case "Identifier": return typeof value.name === "string" ? value.name : null;
        case "StringLiteral": return typeof value.value === "string" ? value.value : null;
        case "PrivateName": return nodeName(value.id);
        case "MemberExpression": return nodeName(value.property);
        default: return null;
    }
}

function lineOf(value: unknown): number | null {
    if (typeof value !== "object" || value === null || !("loc" in value)) return null;
    const loc = value.loc;
    if (typeof loc !== "object" || loc === null || !("start" in loc)) return null;
    const start = loc.start;
    return typeof start === "object" && start !== null && "line" in start && typeof start.line === "number" ? start.line : null;
}

/** Parse the displayed JS, so declaration jumps use its actual lines in either output mode. */
export function codeDeclarations(code: string): { readonly declarations: readonly CodeDeclaration[]; readonly error: string | null } {
    const declarations: CodeDeclaration[] = [];
    const visit = (value: unknown, parent: AstNode | null, owner: string | null): void => {
        if (!isNode(value)) return;
        let name: string | null = null;
        let key: unknown = value;
        let nextOwner = owner;
        switch (value.type) {
            case "ClassDeclaration":
            case "ClassExpression":
                name = nodeName(value.id);
                key = value.id;
                nextOwner = name ?? owner;
                break;
            case "ClassMethod":
            case "ClassPrivateMethod":
            case "ObjectMethod":
                name = nodeName(value.key);
                key = value.key;
                break;
            case "FunctionDeclaration":
                name = nodeName(value.id);
                key = value.id;
                break;
            case "FunctionExpression":
            case "ArrowFunctionExpression":
                name = nodeName(value.id);
                if (!name && parent?.type === "VariableDeclarator") { name = nodeName(parent.id); key = parent.id; }
                if (!name && parent?.type === "AssignmentExpression") { name = nodeName(parent.left); key = parent.left; }
                if (!name && parent?.type === "ObjectProperty") { name = nodeName(parent.key); key = parent.key; }
                break;
        }
        const line = lineOf(key) ?? lineOf(value);
        if (name && line !== null) declarations.push({ name, line, label: `${owner ? owner + "." : ""}${name}` });
        for (const [property, child] of Object.entries(value)) {
            if (["loc", "extra", "leadingComments", "trailingComments", "innerComments"].includes(property)) continue;
            if (Array.isArray(child)) for (const element of child) visit(element, value, nextOwner);
            else if (isNode(child)) visit(child, value, nextOwner);
        }
    };
    try {
        visit(NodeFactory.parse(code), null, null);
        return { declarations, error: null };
    } catch (e) {
        return { declarations: [], error: e instanceof Error ? e.message : String(e) };
    }
}

export interface CodeReferenceLocation extends CodeDeclaration {
    readonly snippet: string;
}

/** Match expressions in the displayed JS. Multiple matches stay explicit: PC order is not JS order. */
export function codeReferenceLocations(code: string, site: XrefSite): {
    readonly locations: readonly CodeReferenceLocation[];
    readonly scope: "method" | "record";
    readonly error: string | null;
} {
    if (site.targetName === null) return { locations: [], scope: "record", error: "This bytecode reference has no resolved target name." };
    const name = site.targetKind === "method" ? methodSymbol(site.targetName) : site.targetName;
    const sourceName = methodSymbol(site.sourceMethod);
    const moduleScope = site.sourceMethod === "func_main_0";
    const sourceLines = code.split("\n");
    const matches: { location: CodeReferenceLocation; inSource: boolean }[] = [];
    let sourceScopes = moduleScope ? 1 : 0;

    const add = (node: unknown, inSource: boolean): void => {
        const line = lineOf(node);
        if (line !== null) matches.push({ inSource, location: { name, line, label: `JS occurrence · line ${line}`, snippet: sourceLines[line - 1]?.trim() ?? "" } });
    };
    const callableName = (node: AstNode, parent: AstNode | null, owner: string | null): string | null => {
        const key = nodeName(node.key);
        if (key === "constructor") return owner;
        return key ?? nodeName(node.id)
            ?? (parent?.type === "VariableDeclarator" ? nodeName(parent.id) : null)
            ?? (parent?.type === "AssignmentExpression" ? nodeName(parent.left) : null)
            ?? (parent?.type === "ObjectProperty" ? nodeName(parent.key) : null);
    };
    const visit = (value: unknown, parent: AstNode | null, property: string, inSource: boolean, owner: string | null): void => {
        if (!isNode(value)) return;
        const isFunction = ["ClassMethod", "ClassPrivateMethod", "ObjectMethod", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(value.type);
        if (isFunction) {
            const callable = callableName(value, parent, owner);
            const inside = !moduleScope && callable === sourceName;
            if (inside) sourceScopes++;
            if (site.targetKind === "method" && callable === name) {
                add(value.key ?? value.id ?? (parent?.type === "VariableDeclarator" ? parent.id : parent?.type === "AssignmentExpression" ? parent.left : value), inSource);
            }
            // Method/property names belong to the enclosing scope; their bodies belong to the function.
            if (site.targetKind !== "method") visit(value.key, value, "key", inSource, owner);
            visit(value.body, value, "body", inside, owner);
            return;
        }
        const isClass = value.type === "ClassDeclaration" || value.type === "ClassExpression";
        const nextOwner = isClass ? nodeName(value.id) ?? owner : owner;
        if (isClass && site.targetKind === "method" && nodeName(value.id) === name) add(value.id, inSource);
        const binding = (property === "id" && ["VariableDeclarator", "ClassDeclaration", "ClassExpression"].includes(parent?.type ?? ""))
            || ["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(parent?.type ?? "");
        if (site.targetKind !== "method" && !binding && nodeName(value) === name
            && (value.type === "Identifier" || value.type === "StringLiteral" || value.type === "PrivateName")) {
            // A string constant and a property access can have the same name in one function.
            const propertyAccess = parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression";
            const namedProperty = /(?:ldobjbyname|ldthisbyname)$/.test(site.opcode);
            if ((!namedProperty || propertyAccess && property === "property") && (site.opcode !== "lda.str" || value.type === "StringLiteral" && !propertyAccess)) add(value, inSource);
        }
        for (const [key, child] of Object.entries(value)) {
            if (["loc", "extra", "leadingComments", "trailingComments", "innerComments"].includes(key)) continue;
            if (Array.isArray(child)) for (const element of child) visit(element, value, key, inSource, nextOwner);
            else if (isNode(child)) visit(child, value, key, inSource, nextOwner);
        }
    };
    try {
        visit(NodeFactory.parse(code), null, "", moduleScope, null);
        const scope = sourceScopes === 1 ? "method" : "record";
        const byLine = new Map<number, CodeReferenceLocation>();
        for (const match of matches) {
            if (sourceScopes === 0 || match.inSource) byLine.set(match.location.line, match.location);
        }
        return { locations: [...byLine.values()].sort((a, b) => a.line - b.line), scope, error: null };
    } catch (e) {
        return { locations: [], scope: "record", error: e instanceof Error ? e.message : String(e) };
    }
}
