import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import dark from "shiki/themes/dark-plus.mjs";
import light from "shiki/themes/light-plus.mjs";
let highlighter: Promise<HighlighterCore> | null = null;
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const plainLines = (code: string): string[] => code.split("\n").map(escape);
export async function highlightLines(code: string, theme: "light" | "dark"): Promise<string[]> {
    if (code.length > 2_000_000) return plainLines(code);
    highlighter ??= createHighlighterCore({ langs: [import("shiki/langs/javascript.mjs")], themes: [light, dark], engine: createJavaScriptRegexEngine({ forgiving: true }) }).catch((error: unknown) => { highlighter = null; throw error; });
    const { tokens } = (await highlighter).codeToTokens(code, { lang: "javascript", theme: `${theme}-plus` });
    return tokens.map((line) => line.map((token) => `<span${token.color ? ` style="color:${token.color}"` : ""}>${escape(token.content)}</span>`).join(""));
}
