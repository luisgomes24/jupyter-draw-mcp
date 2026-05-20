import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod/v4";
import type { CheckpointStore } from "./checkpoint-store.js";

/** Maximum allowed size for element/data input strings (5 MB). */
const MAX_INPUT_BYTES = 5 * 1024 * 1024;

// Works both from source (src/server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "dist")
  : import.meta.dirname;

// ============================================================
// Load spec from external file (src/prompts/ in dev, dist/prompts/ in prod)
// ============================================================
const PROMPTS_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "prompts")
  : path.join(import.meta.dirname, "prompts");

function loadSpec(): string {
  return fsSync.readFileSync(path.join(PROMPTS_DIR, "excalidraw-spec.md"), "utf-8");
}

let _cachedSpec: string | null = null;
function getSpec(): string {
  if (!_cachedSpec) {
    _cachedSpec = loadSpec();
  }
  return _cachedSpec;
}

// ============================================================
// MCP Server Instructions — injected into every conversation
// This ensures the LLM has the spec even if it doesn't call read_me.
// ============================================================
const SERVER_INSTRUCTIONS = `You are an Excalidraw diagram assistant. You create beautiful, hand-drawn diagrams using the create_view tool.

IMPORTANT: Before calling create_view for the first time, you MUST call read_me to learn the Excalidraw element format, color palettes, camera sizing, and examples. The spec contains mandatory rules you must follow — do NOT guess the format.

If the user provides a Jupyter notebook or asks about a data science / ML workflow, use read_notebook to understand the notebook first, then create a diagram following the Jupyter Notebook Diagramming rules in the spec.

Key rules (full details in read_me):
- Elements are a JSON array of Excalidraw element objects
- ALWAYS start with a cameraUpdate element (4:3 ratio: 800x600, 400x300, etc.)
- Use labeled shapes: { "type": "rectangle", "label": { "text": "...", "fontSize": 20 } }
- Use the spec's color palette — never invent colors
- Emit elements progressively: background → shape → label → arrows → next shape
- Use multiple cameraUpdate elements to pan/zoom during streaming — this is the most engaging feature
- Minimum fontSize: 14 (secondary), 16 (body), 20 (titles)
`;

/**
 * Registers all Excalidraw tools and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export function registerTools(server: McpServer, distDir: string, store: CheckpointStore): void {
  const resourceUri = "ui://excalidraw/mcp-app.html";

  // Track whether read_me has been called in this session
  let readMeCalled = false;

  // ============================================================
  // Tool 1: read_me (call before drawing)
  // ============================================================
  server.registerTool(
    "read_me",
    {
      description: "Returns the MANDATORY Excalidraw element format reference with color palettes, examples, camera sizing, and Jupyter notebook diagramming rules. You MUST call this BEFORE using create_view — the spec contains rules and examples that are required to produce correct diagrams.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      readMeCalled = true;
      const header = "# Excalidraw Element Format\n\nThanks for calling read_me! Do NOT call it again in this conversation — you will not see anything new. Now use create_view to draw.\n\n";
      return { content: [{ type: "text", text: header + getSpec() }] };
    },
  );

  // ============================================================
  // Tool 2: read_notebook (read Jupyter notebook content)
  // ============================================================
  server.registerTool(
    "read_notebook",
    {
      description: "Reads a Jupyter notebook (.ipynb) file and returns its code and markdown cells as structured text. Use this to understand what the notebook does before creating a diagram.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative path to a .ipynb file."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path: notebookPath }): Promise<CallToolResult> => {
      try {
        const resolvedPath = path.resolve(notebookPath);
        const raw = await fs.readFile(resolvedPath, "utf-8");
        const notebook = JSON.parse(raw);

        if (!notebook.cells || !Array.isArray(notebook.cells)) {
          return {
            content: [{ type: "text", text: "Invalid notebook format: no cells array found." }],
            isError: true,
          };
        }

        const output: string[] = [];
        output.push(`# Notebook: ${path.basename(resolvedPath)}`);
        output.push(`Total cells: ${notebook.cells.length}\n`);

        for (let i = 0; i < notebook.cells.length; i++) {
          const cell = notebook.cells[i];
          const cellType = cell.cell_type ?? "unknown";
          const source = Array.isArray(cell.source) ? cell.source.join("") : (cell.source ?? "");

          if (!source.trim()) continue; // skip empty cells

          output.push(`--- Cell ${i + 1} [${cellType}] ---`);
          output.push(source);
          output.push("");
        }

        return { content: [{ type: "text", text: output.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to read notebook: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 3: create_view (Excalidraw SVG)
  // ============================================================
  registerAppTool(server,
    "create_view",
    {
      title: "Draw Diagram",
      description: `Renders a hand-drawn diagram using Excalidraw elements.
Elements stream in one by one with draw-on animations.
You MUST call read_me first to learn the element format — diagrams will not render correctly without following the spec.`,
      inputSchema: z.object({
        elements: z.string().describe(
          "JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. Keep compact. You MUST call read_me first for format reference."
        ),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri } },
    },
    async ({ elements }): Promise<CallToolResult> => {
      if (elements.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Elements input exceeds ${MAX_INPUT_BYTES} byte limit. Reduce the number of elements or use checkpoints to build incrementally.` }],
          isError: true,
        };
      }
      let parsed: any[];
      try {
        parsed = JSON.parse(elements);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.` }],
          isError: true,
        };
      }

      // Resolve restoreCheckpoint references and save fully resolved state
      const restoreEl = parsed.find((el: any) => el.type === "restoreCheckpoint");
      let resolvedElements: any[];

      if (restoreEl?.id) {
        const base = await store.load(restoreEl.id);
        if (!base) {
          return {
            content: [{ type: "text", text: `Checkpoint "${restoreEl.id}" not found — it may have expired or never existed. Please recreate the diagram from scratch.` }],
            isError: true,
          };
        }

        const deleteIds = new Set<string>();
        for (const el of parsed) {
          if (el.type === "delete") {
            for (const id of String(el.ids ?? el.id).split(",")) deleteIds.add(id.trim());
          }
        }

        const baseFiltered = base.elements.filter((el: any) =>
          !deleteIds.has(el.id) && !deleteIds.has(el.containerId)
        );
        const newEls = parsed.filter((el: any) =>
          el.type !== "restoreCheckpoint" && el.type !== "delete"
        );
        resolvedElements = [...baseFiltered, ...newEls];
      } else {
        resolvedElements = parsed.filter((el: any) => el.type !== "delete");
      }

      // Check camera aspect ratios — nudge toward 4:3
      const cameras = parsed.filter((el: any) => el.type === "cameraUpdate");
      const badRatio = cameras.find((c: any) => {
        if (!c.width || !c.height) return false;
        const ratio = c.width / c.height;
        return Math.abs(ratio - 4 / 3) > 0.15;
      });
      const ratioHint = badRatio
        ? `\nTip: your cameraUpdate used ${badRatio.width}x${badRatio.height} — try to stick with 4:3 aspect ratio (e.g. 400x300, 800x600) in future.`
        : "";

      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      await store.save(checkpointId, { elements: resolvedElements });

      // If read_me was never called, include the spec in the response so the LLM
      // has the format reference for any subsequent create_view calls.
      const specReminder = readMeCalled
        ? ""
        : `\n\n⚠ You did not call read_me before drawing. For future diagrams, follow this spec:\n\n${getSpec()}`;

      return {
        content: [{ type: "text", text: `Diagram displayed! Checkpoint id: "${checkpointId}".
If user asks to create a new diagram - simply create a new one from scratch.
However, if the user wants to edit something on this diagram "${checkpointId}", take these steps:
1) read widget context (using read_widget_context tool) to check if user made any manual edits first
2) decide whether you want to make new diagram from scratch OR - use this one as starting checkpoint:
  simply start from the first element [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...your new elements...]
  this will use same diagram state as the user currently sees, including any manual edits they made in fullscreen, allowing you to add elements on top.
  To remove elements, use: {"type":"delete","ids":"<id1>,<id2>"}${ratioHint}${specReminder}` }],
        structuredContent: { checkpointId },
      };
    },
  );

  // ============================================================
  // Tool 4: export_to_excalidraw (server-side proxy for CORS)
  // Called by widget via app.callServerTool(), not by the model.
  // ============================================================
  registerAppTool(server,
    "export_to_excalidraw",
    {
      description: "Upload diagram to excalidraw.com and return shareable URL.",
      inputSchema: { json: z.string().describe("Serialized Excalidraw JSON") },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ json }): Promise<CallToolResult> => {
      if (json.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Export data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        // --- Excalidraw v2 binary format ---
        const remappedJson = json;
        // concatBuffers: [version=1 (4B)] [len₁ (4B)] [data₁] [len₂ (4B)] [data₂] ...
        const concatBuffers = (...bufs: Uint8Array[]): Uint8Array => {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        };
        const te = new TextEncoder();

        // 1. Inner payload: concatBuffers(fileMetadata, data)
        const fileMetadata = te.encode(JSON.stringify({}));
        const dataBytes = te.encode(remappedJson);
        const innerPayload = concatBuffers(fileMetadata, dataBytes);

        // 2. Compress inner payload with zlib deflate
        const compressed = deflateSync(Buffer.from(innerPayload));

        // 3. Generate AES-GCM 128-bit key + encrypt
        const cryptoKey = await globalThis.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 128 },
          true,
          ["encrypt"],
        );
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          cryptoKey,
          compressed,
        );

        // 4. Encoding metadata (tells excalidraw.com how to decode)
        const encodingMeta = te.encode(JSON.stringify({
          version: 2,
          compression: "pako@1",
          encryption: "AES-GCM",
        }));

        // 5. Outer payload: concatBuffers(encodingMeta, iv, encryptedData)
        const payload = Buffer.from(concatBuffers(encodingMeta, iv, new Uint8Array(encrypted)));

        // 5. Upload to excalidraw backend
        const res = await fetch("https://json.excalidraw.com/api/v2/post/", {
          method: "POST",
          body: payload,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };

        // 6. Export key as base64url string
        const jwk = await globalThis.crypto.subtle.exportKey("jwk", cryptoKey);
        const url = `https://excalidraw.com/#json=${id},${jwk.k}`;

        return { content: [{ type: "text", text: url }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Export failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 5: save_checkpoint (private — widget only, for user edits)
  // ============================================================
  registerAppTool(server,
    "save_checkpoint",
    {
      description: "Update checkpoint with user-edited state.",
      inputSchema: { id: z.string(), data: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id, data }): Promise<CallToolResult> => {
      if (data.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Checkpoint data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        await store.save(id, JSON.parse(data));
        return { content: [{ type: "text", text: "ok" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `save failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ============================================================
  // Tool 6: read_checkpoint (private — widget only)
  // ============================================================
  registerAppTool(server,
    "read_checkpoint",
    {
      description: "Read checkpoint state for restore.",
      inputSchema: { id: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const data = await store.load(id);
        if (!data) return { content: [{ type: "text", text: "" }] };
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `read failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // CSP: allow Excalidraw to load fonts from esm.sh
  const cspMeta = {
    ui: {
      csp: {
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://esm.sh"],
      },
    },
  };

  // Register the single shared resource for all UI tools
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(distDir, "mcp-app.html"), "utf-8");
      return {
        contents: [{
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              ...cspMeta.ui,
              prefersBorder: true,
              permissions: { clipboardWrite: {} },
            },
          },
        }],
      };
    },
  );
}

/**
 * Creates a new MCP server instance with Excalidraw drawing tools.
 * Used by local entry point (main.ts) and Docker deployments.
 */
export function createServer(store: CheckpointStore): McpServer {
  const server = new McpServer({
    name: "Excalidraw",
    version: "1.0.0",
  }, {
    instructions: SERVER_INSTRUCTIONS,
  });
  registerTools(server, DIST_DIR, store);
  return server;
}
