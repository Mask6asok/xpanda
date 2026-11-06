if (!("process" in globalThis)) {
    Object.defineProperty(globalThis, "process", { value: { env: {} }, configurable: true, writable: true });
}
