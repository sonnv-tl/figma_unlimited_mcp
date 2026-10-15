export interface FigmaRef {
  fileKey: string;
  nodeId?: string;
}

/** Normalizes "3315-2" / "3315%3A2" / "3315:2" to "3315:2". */
export function normalizeNodeId(id: string | undefined | null): string | undefined {
  if (!id) return undefined;
  return decodeURIComponent(id).trim().replace(/-/g, ":");
}

/** Accepts a Figma URL (design/file/proto, optional branch) or a bare file key. */
export function parseFigmaRef(input: string, nodeId?: string): FigmaRef {
  const s = input.trim();
  if (/^[A-Za-z0-9]{10,}$/.test(s)) return { fileKey: s, nodeId: normalizeNodeId(nodeId) };

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`Not a Figma URL or file key: ${input}`);
  }
  const m = url.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (!m) throw new Error(`Unsupported Figma URL (expected /design/<key>): ${input}`);
  return {
    fileKey: m[2] || m[1],
    nodeId: normalizeNodeId(nodeId) ?? normalizeNodeId(url.searchParams.get("node-id")),
  };
}
