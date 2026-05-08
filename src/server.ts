import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import type { CheckpointStore } from "./core/checkpoint-store.js";
import { registerPrompts } from "./prompts/index.js";
import { registerAutomaticTools } from "./tools/automatic.js";
import { registerInteractiveTools } from "./tools/interactive.js";
import { registerSharedTools } from "./tools/shared.js";

// Re-export for downstream consumers (main.ts, api/mcp.ts)
export type { CheckpointStore } from "./core/checkpoint-store.js";
export {
  FileCheckpointStore,
  MemoryCheckpointStore,
  RedisCheckpointStore,
  createVercelStore,
} from "./core/checkpoint-store.js";

// Works both from source (src/server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "dist")
  : import.meta.dirname;

/**
 * Registers all Excalidraw tools, prompts, and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export function registerTools(server: McpServer, distDir: string, store: CheckpointStore): void {
  registerSharedTools(server);
  registerInteractiveTools(server, store, distDir);
  registerAutomaticTools(server, store);
  registerPrompts(server);
}

/**
 * Creates a new MCP server instance with Excalidraw drawing tools.
 * Used by local entry point (main.ts) and Docker deployments.
 */
export function createServer(store: CheckpointStore): McpServer {
  const server = new McpServer({
    name: "Excalidraw",
    version: "1.0.0",
  });
  registerTools(server, DIST_DIR, store);
  return server;
}
