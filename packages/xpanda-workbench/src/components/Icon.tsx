const paths = {
    files: "M8 3H3v18h14V8L12 3H8m4 0v6h5M6 13h8M6 17h6",
    folder: "M3 6h7l2 2h9v12H3V6Z",
    search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
    reference: "M8 4H4v6h4V4Zm12 10h-4v6h4v-6ZM8 7h8v10M4 17h12",
    back: "m14 5-7 7 7 7",
    forward: "m10 5 7 7-7 7",
    close: "m6 6 12 12M6 18 18 6",
    sun: "M12 3V1m0 22v-2M3 12H1m22 0h-2M5 5 3 3m18 18-2-2M5 19l-2 2M21 3l-2 2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
    chevron: "m9 5 7 7-7 7",
    copy: "M8 8h13v13H8V8ZM4 16H2V2h14v2",
    download: "M12 2v13m-5-5 5 5 5-5M3 16v5h18v-5",
    menu: "M3 6h18M3 12h18M3 18h18",
    reset: "M3 11a9 9 0 1 1 2 7M3 3v8h8",
};
export function Icon({ name, size = 16 }: { name: keyof typeof paths; size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
