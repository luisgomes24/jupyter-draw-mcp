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

/** Search icons via the Iconify API. Returns raw API response data. */
export async function searchIcons(query: string, limit: number): Promise<{ total: number; icons: string[] }> {
  const response = await fetch(`${ICONIFY_API}/search?query=${encodeURIComponent(query)}&limit=${limit}`);
  if (!response.ok) throw new Error(`Search failed: ${response.statusText}`);
  const data = await response.json() as any;
  return { total: data.total ?? 0, icons: data.icons ?? [] };
}
