import crypto from "node:crypto";
import type { CheckpointStore } from "./checkpoint-store.js";
import { fetchIconAsBase64 } from "./icons.js";

/** Maximum allowed size for element/data input strings (5 MB). */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;

/**
 * Parse and validate an elements JSON string.
 * Returns the parsed array or throws a descriptive error.
 */
export function parseAndValidateElements(elements: string): any[] {
  if (elements.length > MAX_INPUT_BYTES) {
    throw new ElementsError(`Elements input exceeds ${MAX_INPUT_BYTES} byte limit.`);
  }
  try {
    return JSON.parse(elements);
  } catch (e) {
    throw new ElementsError(`Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.`);
  }
}

/**
 * Resolve restoreCheckpoint references and delete pseudo-elements.
 * Returns the fully resolved elements array.
 */
export async function resolveCheckpoint(
  parsed: any[],
  store: CheckpointStore,
): Promise<any[]> {
  const restoreEl = parsed.find((el: any) => el.type === "restoreCheckpoint");

  if (restoreEl?.id) {
    const base = await store.load(restoreEl.id);
    if (!base) {
      throw new ElementsError(
        `Checkpoint "${restoreEl.id}" not found — it may have expired or never existed. Please recreate the diagram from scratch.`,
      );
    }

    const deleteIds = new Set<string>();
    for (const el of parsed) {
      if (el.type === "delete") {
        for (const id of String(el.ids ?? el.id).split(",")) deleteIds.add(id.trim());
      }
    }

    const baseFiltered = base.elements.filter(
      (el: any) => !deleteIds.has(el.id) && !deleteIds.has(el.containerId),
    );
    const newEls = parsed.filter(
      (el: any) => el.type !== "restoreCheckpoint" && el.type !== "delete",
    );
    return [...baseFiltered, ...newEls];
  }

  return parsed.filter((el: any) => el.type !== "delete");
}

/**
 * Process icon elements: resolve iconId → fileId + base64 data URL.
 * Mutates elements in-place and returns a files record.
 */
export async function processIcons(
  elements: any[],
): Promise<Record<string, any>> {
  const files: Record<string, any> = {};
  for (const el of elements) {
    if (el.type === "image" && el.iconId) {
      try {
        const dataURL = await fetchIconAsBase64(el.iconId);
        const fileId = crypto.randomUUID().replace(/-/g, "");
        el.fileId = fileId;
        el.status = "pending"; // Required by Excalidraw
        files[fileId] = {
          mimeType: "image/svg+xml",
          id: fileId,
          dataURL,
          created: Date.now(),
        };
      } catch (e) {
        console.error(`Failed to load icon ${el.iconId}`);
      }
    }
  }
  return files;
}

/**
 * Expand shorthand `label` properties into proper Excalidraw bound text elements.
 * Used when saving .excalidraw files (the native format doesn't support the label shorthand).
 * Returns the expanded elements array.
 */
export function expandLabels(elements: any[]): any[] {
  const expanded: any[] = [];

  for (const el of elements) {
    if (el.label && typeof el.label === "object") {
      const { text, fontSize, strokeColor } = el.label;
      delete el.label;
      if (text) {
        const textId = `text_${el.id || Math.random().toString(36).slice(2)}`;
        el.boundElements = el.boundElements || [];
        el.boundElements.push({ type: "text", id: textId });

        const fSize = fontSize || 20;
        const lines = text.split("\n");
        const maxLineLen = Math.max(...lines.map((l: string) => l.length));
        const estimatedWidth = maxLineLen * fSize * 0.55;
        const estimatedHeight = lines.length * fSize * 1.25;

        expanded.push(el);
        expanded.push({
          type: "text",
          id: textId,
          x: el.x + (el.width || 0) / 2 - estimatedWidth / 2,
          y: el.y + (el.height || 0) / 2 - estimatedHeight / 2,
          width: estimatedWidth,
          height: estimatedHeight,
          text: text,
          originalText: text,
          fontSize: fSize,
          fontFamily: 1, // Virgil
          textAlign: "center",
          verticalAlign: "middle",
          containerId: el.id,
          strokeColor: strokeColor || el.strokeColor || "#1e1e1e",
          autoResize: true,
          lineHeight: 1.25,
        });
        continue;
      }
    }
    expanded.push(el);
  }

  return expanded;
}

/**
 * Check camera aspect ratios and return a hint string if any are non-4:3.
 */
export function checkCameraRatios(parsed: any[]): string {
  const cameras = parsed.filter((el: any) => el.type === "cameraUpdate");
  const badRatio = cameras.find((c: any) => {
    if (!c.width || !c.height) return false;
    const ratio = c.width / c.height;
    return Math.abs(ratio - 4 / 3) > 0.15;
  });
  return badRatio
    ? `\nTip: your cameraUpdate used ${badRatio.width}x${badRatio.height} — try to stick with 4:3 aspect ratio (e.g. 400x300, 800x600) in future.`
    : "";
}

/**
 * Filter out pseudo-elements, returning only drawable elements.
 */
export function filterDrawable(elements: any[]): any[] {
  return elements.filter(
    (el: any) => el.type !== "cameraUpdate" && el.type !== "delete" && el.type !== "restoreCheckpoint",
  );
}

/**
 * Generate a short checkpoint ID.
 */
export function generateCheckpointId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 18);
}

/**
 * Compute structural feedback for a set of elements (used by draft_view).
 * Returns a text summary with element count, bounding box, and overlap detection.
 */
export function computeStructuralFeedback(elements: any[]): string {
  const drawable = filterDrawable(elements);
  if (drawable.length === 0) return "No drawable elements found.";

  // Compute overall bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of drawable) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.width ?? 0;
    const h = el.height ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
    // Include arrow endpoints
    if (el.type === "arrow" && el.points) {
      for (const pt of el.points) {
        const px = x + pt[0];
        const py = y + pt[1];
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    }
  }

  // Count by type
  const typeCounts: Record<string, number> = {};
  for (const el of drawable) {
    typeCounts[el.type] = (typeCounts[el.type] || 0) + 1;
  }
  const typeBreakdown = Object.entries(typeCounts)
    .map(([t, c]) => `${c} ${t}${c > 1 ? "s" : ""}`)
    .join(", ");

  // Detect overlaps among shapes
  const shapes = drawable.filter((el: any) =>
    el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond",
  );
  const overlaps: string[] = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      const ax1 = a.x ?? 0, ay1 = a.y ?? 0;
      const ax2 = ax1 + (a.width ?? 0), ay2 = ay1 + (a.height ?? 0);
      const bx1 = b.x ?? 0, by1 = b.y ?? 0;
      const bx2 = bx1 + (b.width ?? 0), by2 = by1 + (b.height ?? 0);
      const margin = 5;
      if (!(ax2 + margin <= bx1 || bx2 + margin <= ax1 || ay2 + margin <= by1 || by2 + margin <= ay1)) {
        const la = a.label?.text || a.id || "?";
        const lb = b.label?.text || b.id || "?";
        overlaps.push(`"${la}" and "${lb}"`);
      }
    }
  }

  const lines: string[] = [
    `${drawable.length} elements (${typeBreakdown}).`,
    `Bounding box: (${Math.round(minX)}, ${Math.round(minY)}) to (${Math.round(maxX)}, ${Math.round(maxY)}) — ${Math.round(maxX - minX)}×${Math.round(maxY - minY)}px.`,
  ];

  if (overlaps.length > 0) {
    lines.push(`⚠ ${overlaps.length} overlap(s): ${overlaps.slice(0, 5).join("; ")}`);
  } else {
    lines.push("No overlaps detected.");
  }

  return lines.join("\n");
}

/**
 * Custom error class for element processing failures.
 */
export class ElementsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElementsError";
  }
}
