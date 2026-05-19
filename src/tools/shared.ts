import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import { searchIcons } from "../core/icons.js";
import { loadExcalidrawSpec, loadJupyterSpec } from "../prompts/index.js";

/**
 * Registers shared tools available to both interactive and automatic workflows:
 * - read_me: Returns the Excalidraw element format reference
 * - read_notebook: Reads a Jupyter notebook file
 * - search_icons: Searches Iconify for icon identifiers
 */
export function registerSharedTools(server: McpServer): void {
  // ============================================================
  // Tool: read_me (call before drawing)
  // ============================================================
  server.registerTool(
    "read_me",
    {
      description: "Returns the Excalidraw element format reference with color palettes, examples, and tips. Call this BEFORE using create_view for the first time.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      const header = "# Excalidraw Element Format\n\nThanks for calling read_me! Do NOT call it again in this conversation — you will not see anything new. Now use create_view to draw.\n\n";
      return { content: [{ type: "text", text: header + loadExcalidrawSpec() + "\n\n---\n\n# Jupyter Notebook Diagramming Rules\n\n" + loadJupyterSpec() }] };
    },
  );

  // ============================================================
  // Tool: read_notebook (read Jupyter notebook content)
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
  // Tool: search_icons
  // ============================================================
  server.registerTool(
    "search_icons",
    {
      description: "Search for icons across Iconify libraries. Returns icon identifiers (e.g., 'lucide:home') to use in diagrams with the 'iconId' property.",
      inputSchema: z.object({
        query: z.string().describe("Search query (e.g., 'database', 'user', 'arrow')"),
        limit: z.number().min(1).max(5).default(5).describe("Maximum results to return"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      try {
        const data = await searchIcons(query, limit);
        if (!data.icons || data.icons.length === 0) {
          return { content: [{ type: "text", text: `No icons found for "${query}".` }] };
        }

        const iconList = data.icons.map((id: string) => `- \`${id}\``).join("\n");
        return {
          content: [{
            type: "text",
            text: `Found ${data.total} icons. Here are the top results:\n\n${iconList}\n\nUse these IDs in your diagram elements like: { "type": "image", "iconId": "..." }`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to search icons: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}
