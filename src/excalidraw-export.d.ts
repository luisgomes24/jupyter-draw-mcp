declare module "@moona3k/excalidraw-export" {
  /**
   * Render an Excalidraw document to an SVG string.
   * Pure computation: roughjs for hand-drawn effects, no DOM needed.
   */
  export function renderToSvg(
    doc: {
      type?: string;
      version?: number;
      elements: any[];
      appState?: Record<string, any>;
      files?: Record<string, any>;
    },
    options?: { background?: boolean },
  ): string;

  /**
   * Export an Excalidraw file to PNG or SVG on disk.
   */
  export function exportDiagram(
    inputPath: string,
    outputPath: string,
    options?: { format?: "svg" | "png"; background?: boolean; scale?: number },
  ): { format: string; path: string; size: number; width?: number; height?: number };
}
