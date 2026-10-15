import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "dbg", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } }));
const code = `const r = figma.root; return { vis: document.visibilityState, focus: document.hasFocus(), url: location.href.slice(0,90), root: r.name, pages: r.children.map(p => ({ id: p.id, name: p.name, n: p.children.length })), cur: figma.currentPage.name, node: !!(await figma.getNodeByIdAsync("3512:9475")) };`;
for (let i = 0; i < 2; i++) {
  const r = await c.callTool({ name: "figma_execute", arguments: { url: "r8Vr9f9sN9f4NdYOWhmh8X", code } });
  console.log(new Date().toISOString().slice(17, 23), r.content[0].text.slice(0, 300));
  await new Promise((r) => setTimeout(r, 1500));
}
await c.close();
