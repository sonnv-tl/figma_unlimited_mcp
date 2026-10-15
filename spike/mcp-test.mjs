// Smoke test: spawn the MCP server over stdio and call tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const URL_ = process.argv[2];
const OUT = process.argv[3];
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const show = (label, r, max = 1500) => {
  const parts = r.content.map((c) => c.type === "text" ? c.text : `<${c.type} ${c.mimeType} ${Math.round(c.data.length * 0.75 / 1024)}KB>`);
  console.log(`\n=== ${label}${r.isError ? " [ERROR]" : ""} ===\n` + parts.join("\n").slice(0, max));
};
const t = async (label, name, args, max) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  show(`${label} (${Date.now() - t0}ms)`, r, max);
  return r;
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
await t("get_file", "figma_get_file", { url: URL_ });
const node = await t("get_node depth 3", "figma_get_node", { url: URL_, nodeId: "3512:8953", depth: 3 }, 3000);
await t("search TEXT 応募者", "figma_search", { url: URL_, query: "応募者", searchText: true, limit: 5 });
await t("screenshot", "figma_screenshot", { url: URL_, nodeId: "3512:8953", maxDimension: 800, savePath: OUT + "/mcp-shot.png" });
await t("css", "figma_get_css", { url: URL_, nodeId: "3512:8953" });
await t("variables", "figma_get_variables", { url: URL_ }, 800);
await t("styles", "figma_get_styles", { url: URL_ }, 800);
await t("execute", "figma_execute", { url: URL_, code: "const p = figma.currentPage; return { page: p.name, top: p.children.map(c => c.name).slice(0,5) };" });
await t("status", "figma_status", {});
await client.close();
