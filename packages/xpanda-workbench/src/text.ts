export function symbolAt(code: string, offset: number): string | null {
    const start = code.lastIndexOf("\n", offset - 1) + 1;
    const end = code.indexOf("\n", offset);
    const line = code.slice(start, end < 0 ? undefined : end);
    for (const match of line.matchAll(/#?[$\p{ID_Start}][$\p{ID_Continue}]*/gu)) {
        if (match.index !== undefined && offset - start >= match.index && offset - start <= match.index + match[0].length) return match[0];
    }
    return null;
}
export function shortName(path: string): string { return path.split("/").pop() ?? path; }
/** Shorten normalized record labels without changing record identity or export paths. */
export function displayRecordPath(path: string): string {
    const extension = path.endsWith(".js") ? ".js" : "";
    const record = extension ? path.slice(0, -extension.length) : path;
    return record.replace(/&\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "") + extension;
}
export function hex(value: number): string { return `0x${value.toString(16)}`; }
export function sizeLabel(bytes: number): string { return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`; }
