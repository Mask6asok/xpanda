import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Registry } from "./registry";
import { registerLoadTools } from "./tools/load";
import { registerBrowseTools } from "./tools/browse";
import { registerDecompileTools } from "./tools/decompile";
import { registerDisasmTools } from "./tools/disasm";
import { registerStringTools } from "./tools/strings";
import { registerHapTools } from "./tools/hap";

/** Register the original live tools without opening a second MCP transport. */
export function registerXpandaTools(server: McpServer): void {
    const registry = new Registry();
    registerLoadTools(server, registry);
    registerBrowseTools(server, registry);
    registerDecompileTools(server, registry);
    registerDisasmTools(server, registry);
    registerStringTools(server, registry);
    registerHapTools(server, registry);
}
