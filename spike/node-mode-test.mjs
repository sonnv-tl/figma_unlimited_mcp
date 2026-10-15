import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [URL_, OUT] = process.argv.slice(2);
const c = new Client({ name: "nodemode", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } }));
const call = async (name, args, max = 600) => {
  const t = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const txt = r.content.map((x) => (x.type === "text" ? x.text : `<${x.type}>`)).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR] " : ""}(${Date.now() - t}ms)\n${txt.slice(0, max)}`);
  return txt;
};
await call("figma_get_file", { url: URL_ });                       // expect view-only hint
const tree = await call("figma_get_node", { url: URL_, depth: 2 }, 1200); // copies the node
const childId = JSON.parse(tree.split("\n").find((l) => l.startsWith("{"))).children[0].id;
await call("figma_get_node", { url: URL_, depth: 2 }, 300);          // cached mapping, fast
await call("figma_get_node", { url: URL_, nodeId: childId, depth: 1 }, 500); // child id from scratch
await call("figma_screenshot", { url: URL_, nodeId: childId, maxDimension: 1000, savePath: OUT + "/node-mode-child.png" });
await call("figma_status", {}, 900);
await call("figma_delete_copy", { url: URL_ });
await call("figma_status", {}, 900);
await c.close();
