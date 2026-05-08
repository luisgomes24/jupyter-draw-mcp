import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";

// Load prompt markdown files at module init time.
// Works from both src/ (dev) and dist/ (compiled).
const promptsDir = import.meta.filename.endsWith(".ts")
  ? import.meta.dirname
  : path.join(import.meta.dirname, "prompts");

function loadPromptFile(filename: string): string {
  return fs.readFileSync(path.join(promptsDir, filename), "utf-8");
}

let _cheatSheet: string | null = null;
let _interactivePrompt: string | null = null;
let _automaticPrompt: string | null = null;

/** Returns the Excalidraw element format cheat sheet. */
export function loadCheatSheet(): string {
  if (!_cheatSheet) {
    _cheatSheet = loadPromptFile("excalidraw-spec.md");
  }
  return _cheatSheet;
}

/** Returns the interactive persona prompt. */
export function loadInteractivePrompt(): string {
  if (!_interactivePrompt) {
    _interactivePrompt = loadPromptFile("interactive.md");
  }
  return _interactivePrompt;
}

/** Returns the automatic persona prompt. */
export function loadAutomaticPrompt(): string {
  if (!_automaticPrompt) {
    _automaticPrompt = loadPromptFile("automatic.md");
  }
  return _automaticPrompt;
}

/**
 * Registers MCP Prompts for both interactive and automatic workflows.
 */
export function registerPrompts(server: McpServer): void {
  server.prompt(
    "diagram_interactive",
    "Persona and instructions for interactive (human-in-the-loop) diagram creation. Includes the Excalidraw element format reference.",
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Excalidraw Element Format\n\n${loadCheatSheet()}\n\n---\n\n# Instructions\n\n${loadInteractivePrompt()}`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "diagram_automatic",
    "Persona and instructions for autonomous (headless) diagram generation. Includes the Excalidraw element format reference.",
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Excalidraw Element Format\n\n${loadCheatSheet()}\n\n---\n\n# Instructions\n\n${loadAutomaticPrompt()}`,
          },
        },
      ],
    }),
  );
}
