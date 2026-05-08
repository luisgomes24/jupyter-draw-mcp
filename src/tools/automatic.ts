import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { CheckpointStore } from "../core/checkpoint-store.js";
import {
  checkCameraRatios,
  computeStructuralFeedback,
  expandLabels,
  filterDrawable,
  generateCheckpointId,
  parseAndValidateElements,
  processIcons,
  resolveCheckpoint,
} from "../core/elements.js";

/**
 * Registers automatic (headless) tools for autonomous workflows:
 * - draft_view: Like create_view but without UI — returns structural feedback for Visual Chain of Thought (CoT)
 * - save_excalidraw_file: Saves elements as a .excalidraw JSON file
 */
export function registerAutomaticTools(
  server: McpServer,
  store: CheckpointStore,
): void {
  // ============================================================
  // Tool: draft_view (headless create_view — structural feedback only)
  // ============================================================
  server.registerTool(
    "draft_view",
    {
      description: `Builds a diagram draft without rendering UI. Returns structural feedback (element count, bounding box, overlap detection) and a checkpoint ID for iterative building. Same element format as create_view. Call read_me first to learn the element format.`,
      inputSchema: z.object({
        elements: z.string().describe(
          "JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. Keep compact. Call read_me first for format reference."
        ),
      }),
    },
    async ({ elements }): Promise<CallToolResult> => {
      let parsed: any[];
      try {
        parsed = parseAndValidateElements(elements);
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }

      let resolvedElements: any[];
      try {
        resolvedElements = await resolveCheckpoint(parsed, store);
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }

      const ratioHint = checkCameraRatios(parsed);
      const checkpointId = generateCheckpointId();

      const files = await processIcons(resolvedElements);
      await store.save(checkpointId, { elements: resolvedElements, files });

      const feedback = computeStructuralFeedback(resolvedElements);

      return {
        content: [{ type: "text", text: `Draft saved. Checkpoint id: "${checkpointId}".\n\n## Structural Feedback\n${feedback}\n\nTo iterate, start your next elements array with:\n[{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...new elements...]\n\nTo remove elements: {"type":"delete","ids":"<id1>,<id2>"}\n\nWhen satisfied, call save_excalidraw_file with ALL final elements.${ratioHint}` }],
        structuredContent: { checkpointId },
      };
    },
  );

  // ============================================================
  // Tool: save_excalidraw_file (write .excalidraw JSON to disk)
  // ============================================================
  server.registerTool(
    "save_excalidraw_file",
    {
      description: "Saves Excalidraw elements as a .excalidraw JSON file to disk. The elements must be a valid JSON array string of Excalidraw elements (same format as create_view). Call read_me first to learn the element format.",
      inputSchema: z.object({
        path: z.string().describe("Absolute or relative path for the output .excalidraw file."),
        elements: z.string().describe("JSON array string of Excalidraw elements."),
      }),
    },
    async ({ path: outputPath, elements }): Promise<CallToolResult> => {
      let parsed: any[];
      try {
        parsed = parseAndValidateElements(elements);
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }

      // Filter out pseudo-elements
      const drawableElements = filterDrawable(parsed);

      // Process icons and expand labels for native .excalidraw format
      const files: Record<string, any> = {};
      const iconFiles = await processIcons(drawableElements);
      Object.assign(files, iconFiles);

      const expandedElements = expandLabels(drawableElements);

      // Build a valid .excalidraw file structure
      const excalidrawFile = {
        type: "excalidraw",
        version: 2,
        source: "mcp-excalidraw-agent",
        elements: expandedElements,
        appState: {
          gridSize: null,
          viewBackgroundColor: "#ffffff",
        },
        files: files,
      };

      try {
        const resolvedPath = path.resolve(outputPath);
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        await fs.writeFile(resolvedPath, JSON.stringify(excalidrawFile, null, 2));
        return {
          content: [{ type: "text", text: `Excalidraw file saved to: ${resolvedPath}` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to save file: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
