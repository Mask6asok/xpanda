import type { ClassRef } from "./decompiler";

/** Mutable only while building a source's directory hierarchy. */
export interface ClassDirectory {
    readonly path: string;
    readonly name: string;
    readonly directories: Map<string, ClassDirectory>;
    readonly files: ClassRef[];
    count: number;
}

export function buildClassTree(refs: readonly ClassRef[]): ClassDirectory {
    const root: ClassDirectory = { path: "", name: "", directories: new Map(), files: [], count: 0 };
    for (const ref of refs) {
        let directory = root;
        directory.count++;
        const segments = ref.displayPath.split("/");
        segments.pop();
        for (const segment of segments) {
            let child = directory.directories.get(segment);
            if (!child) {
                child = { path: directory.path ? `${directory.path}/${segment}` : segment, name: segment, directories: new Map(), files: [], count: 0 };
                directory.directories.set(segment, child);
            }
            directory = child;
            directory.count++;
        }
        directory.files.push(ref);
    }
    return root;
}
