import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { highlightLines, plainLines } from "../highlight";
import { symbolAt } from "../text";
import type { EditorFrame } from "../model";

export interface EditorHandle {
    snapshot(): EditorFrame;
    reveal(line: number): void;
    find(query: string): boolean;
    focus(): void;
}
interface Props {
    code: string; theme: "light" | "dark"; syntax: boolean;
    landing: { key: number; line?: number; column?: number; length?: number; frame?: EditorFrame };
    onSelection(line: number, column: number, symbol: string | null): void;
    onReferences(): void; onDefinition(): void; onFind(): void;
}
const HEIGHT = 21;
export const CodeEditor = forwardRef<EditorHandle, Props>(function CodeEditor(props, ref) {
    const input = useRef<HTMLTextAreaElement>(null);
    const shell = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ top: 0, left: 0, height: 500 });
    const [caretLine, setCaretLine] = useState(1);
    const plain = useMemo(() => plainLines(props.code), [props.code]);
    const [paint, setPaint] = useState<{ code: string; theme: string; lines: string[] } | null>(null);
    const lines = paint?.code === props.code && paint.theme === props.theme && props.syntax ? paint.lines : plain;
    const offsets = useMemo(() => { const result = [0]; for (let i = 0; i < props.code.length; i++) if (props.code[i] === "\n") result.push(i + 1); return result; }, [props.code]);
    const selection = () => {
        const element = input.current;
        if (!element) return;
        const at = element.selectionStart;
        let low = 0, high = offsets.length;
        while (low + 1 < high) { const mid = (low + high) >>> 1; if (offsets[mid] <= at) low = mid; else high = mid; }
        setCaretLine(low + 1);
        props.onSelection(low + 1, at - offsets[low] + 1, symbolAt(props.code, at));
    };
    const updateScroll = () => { const element = input.current; if (element) setViewport({ top: element.scrollTop, left: element.scrollLeft, height: element.clientHeight }); };
    const reveal = (line: number, column?: number, length?: number) => {
        const element = input.current;
        if (!element) return;
        const index = Math.min(offsets.length - 1, Math.max(0, line - 1));
        const lineEnd = offsets[index + 1] !== undefined ? offsets[index + 1] - 1 : props.code.length;
        const start = Math.min(lineEnd, offsets[index] + Math.max(0, (column ?? 1) - 1));
        element.setSelectionRange(start, length === undefined ? lineEnd : Math.min(props.code.length, start + length));
        element.scrollTop = Math.max(0, index * HEIGHT - element.clientHeight * 0.35);
        const context = document.createElement("canvas").getContext("2d");
        if (context) context.font = getComputedStyle(element).font;
        const prefix = props.code.slice(offsets[index], start);
        const width = context?.measureText(prefix).width ?? prefix.length * 7.8;
        element.scrollLeft = column === undefined ? 0 : Math.max(0, width - element.clientWidth * 0.35);
        element.focus({ preventScroll: true }); selection(); updateScroll();
    };
    useImperativeHandle(ref, () => ({
        snapshot: () => ({ start: input.current?.selectionStart ?? 0, end: input.current?.selectionEnd ?? 0, top: input.current?.scrollTop ?? 0, left: input.current?.scrollLeft ?? 0 }),
        reveal, focus: () => input.current?.focus(),
        find: (query) => {
            const element = input.current;
            if (!element || !query) return false;
            const after = props.code.toLowerCase().indexOf(query.toLowerCase(), element.selectionEnd);
            const index = after < 0 ? props.code.toLowerCase().indexOf(query.toLowerCase()) : after;
            if (index < 0) return false;
            element.setSelectionRange(index, index + query.length);
            const line = props.code.slice(0, index).split("\n").length;
            element.scrollTop = Math.max(0, (line - 1) * HEIGHT - element.clientHeight * 0.35);
            element.focus(); selection(); updateScroll(); return true;
        },
    }));
    useEffect(() => {
        let cancelled = false;
        if (props.syntax) void highlightLines(props.code, props.theme).then((result) => { if (!cancelled) setPaint({ code: props.code, theme: props.theme, lines: result }); }).catch(() => { /* Plain text remains readable if highlighting fails. */ });
        return () => { cancelled = true; };
    }, [props.code, props.theme, props.syntax]);
    useEffect(() => {
        const element = input.current;
        if (!element) return;
        if (props.landing.line !== undefined) reveal(props.landing.line, props.landing.column, props.landing.length);
        else {
            const frame = props.landing.frame;
            element.setSelectionRange(frame?.start ?? 0, frame?.end ?? 0);
            element.scrollTop = frame?.top ?? 0; element.scrollLeft = frame?.left ?? 0;
            selection(); updateScroll();
        }
    }, [props.code, props.landing.key]);
    useEffect(() => { if (!shell.current) return; const observer = new ResizeObserver(updateScroll); observer.observe(shell.current); return () => observer.disconnect(); }, []);
    const first = Math.max(0, Math.floor(viewport.top / HEIGHT) - 4);
    const last = Math.min(lines.length, Math.ceil((viewport.top + viewport.height) / HEIGHT) + 4);
    return <div className="code-editor" ref={shell}>
        <div className="code-paint" aria-hidden="true">{lines.slice(first, last).map((html, i) => <div className={`paint-line ${first + i + 1 === caretLine ? "caret-line" : ""}`} key={first + i} style={{ top: 14 + (first + i) * HEIGHT - viewport.top }}><span className="line-number">{first + i + 1}</span><span className="line-content" style={{ transform: `translateX(${-viewport.left}px)` }} dangerouslySetInnerHTML={{ __html: html || " " }} /></div>)}</div>
        <textarea ref={input} aria-label="代码查看器" className="code-input" readOnly spellCheck={false} wrap="off" value={props.code} onSelect={selection} onScroll={updateScroll}
            onMouseUp={(event) => { selection(); if (event.ctrlKey || event.metaKey) props.onDefinition(); }}
            onKeyDown={(event) => {
                if (event.key === "F12") { event.preventDefault(); if (event.shiftKey) props.onReferences(); else props.onDefinition(); }
                if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); props.onFind(); }
            }} />
    </div>;
});
