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

let _excalidrawSpec: string | null = null;
let _jupyterSpec: string | null = null;
let _interactivePrompt: string | null = null;
let _automaticPrompt: string | null = null;

/** Returns the Excalidraw element format reference. */
export function loadExcalidrawSpec(): string {
  if (!_excalidrawSpec) {
    _excalidrawSpec = loadPromptFile("excalidraw-spec.md");
  }
  return _excalidrawSpec;
}

/** Returns the Jupyter notebook diagramming spec. */
export function loadJupyterSpec(): string {
  if (!_jupyterSpec) {
    _jupyterSpec = loadPromptFile("jupyter-spec.md");
  }
  return _jupyterSpec;
}

/** Backwards-compatible alias — returns excalidraw-spec. */
export function loadCheatSheet(): string {
  return loadExcalidrawSpec();
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
 * Each prompt composes three specs: excalidraw syntax + jupyter diagramming rules + mode-specific instructions.
 */
export function registerPrompts(server: McpServer): void {
  server.prompt(
    "diagram_interactive",
    "Persona and instructions for interactive (human-in-the-loop) notebook diagram creation.",
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Excalidraw Syntax Reference\n\n${loadExcalidrawSpec()}\n\n---\n\n# Jupyter Notebook Diagramming Rules\n\n${loadJupyterSpec()}\n\n---\n\n# Interactive Mode Instructions\n\n${loadInteractivePrompt()}`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "diagram_automatic",
    "Persona and instructions for autonomous (headless) notebook diagram generation.",
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `# Excalidraw Syntax Reference\n\n${loadExcalidrawSpec()}\n\n---\n\n# Jupyter Notebook Diagramming Rules\n\n${loadJupyterSpec()}\n\n---\n\n# Automatic Mode Instructions\n\n${loadAutomaticPrompt()}`,
          },
        },
      ],
    }),
  );
}
