// Ad-hoc: node spike/mcp-call.mjs <tool> '<json args>' [<tool> '<json args>' ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "adhoc", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));
const a = process.argv.slice(2);
for (let i = 0; i < a.length; i += 2) {
  const r = await client.callTool({ name: a[i], arguments: JSON.parse(a[i + 1]) }, undefined, { timeout: 300_000 });
  console.log(`=== ${a[i]}${r.isError ? " [ERROR]" : ""}`);
  for (const c of r.content) console.log(c.type === "text" ? c.text.slice(0, 2500) : `<${c.type}>`);
}
await client.close();
