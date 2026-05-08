import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

const ICONIFY_API = "https://api.iconify.design";

/** Fetches an icon from Iconify and converts it to a Base64 Data URL */
export async function fetchIconAsBase64(iconId: string): Promise<string> {
  const [prefix, name] = iconId.split(":");
  if (!prefix || !name) throw new Error(`Invalid icon ID format: ${iconId}`);

  const response = await fetch(`${ICONIFY_API}/${prefix}.json?icons=${name}`);
  if (!response.ok) throw new Error(`Icon ${iconId} not found`);

  const data = await response.json() as any;
  const icon = data.icons?.[name];
  if (!icon) throw new Error(`Icon ${iconId} not found in collection`);
  
  const width = icon.width || data.width || 24;
  const height = icon.height || data.height || 24;
  
  // Excalidraw requires the raw SVG string converted to a base64 Data URL
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${icon.body}</svg>`;
  
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Registers icon search tools for the agent */
export function registerIconTools(server: McpServer): void {
  server.registerTool("search_icons", {
    description: "Search for icons across Iconify libraries. Returns icon identifiers (e.g., 'lucide:home') to use in diagrams with the 'iconId' property.",
    inputSchema: z.object({
      query: z.string().describe("Search query (e.g., 'database', 'user', 'csv')"),
      limit: z.number().min(1).max(3).default(1).describe("Maximum results to return"),
    }),
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    try {
      const response = await fetch(`${ICONIFY_API}/search?query=${encodeURIComponent(query)}&limit=${limit}`);
      if (!response.ok) return { content: [{ type: "text", text: `Error: ${response.statusText}` }], isError: true };
      
      const data = await response.json() as any;
      if (!data.icons || data.icons.length === 0) {
        return { content: [{ type: "text", text: `No icons found for "${query}".` }] };
      }

      const iconList = data.icons.map((id: string) => `- \`${id}\``).join("\n");
      return { 
        content: [{ 
          type: "text", 
          text: `Found ${data.total} icons. Here are the top results:\n\n${iconList}\n\nUse these IDs in your diagram elements like: { "type": "image", "iconId": "..." }` 
        }] 
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Failed to search icons: ${(err as Error).message}` }], isError: true };
    }
  });
}