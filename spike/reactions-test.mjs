// Builds a tiny prototype in the scratch file (button → hover variant swap, click → overlay), reads it back, removes it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const SCRATCH = process.argv[2];
const c = new Client({ name: "rx", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } }));
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const t = r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  console.log(`=== ${name}${r.isError ? " [ERROR]" : ""}\n${t.slice(0, 2500)}`);
  return t;
};
const setup = await call("figma_execute", { url: SCRATCH, code: `
  const page = figma.createPage(); page.name = "rx-test"; await figma.setCurrentPageAsync(page);
  const mk = (name, color) => { const c = figma.createComponent(); c.name = name; c.resize(120, 40); c.fills = [{ type: "SOLID", color }]; return c; };
  const def = mk("State=Default", { r: 0.03, g: 0.47, b: 0.84 });
  const hov = mk("State=Hover", { r: 0, g: 0.33, b: 0.68 });
  const set = figma.combineAsVariants([def, hov], page); set.name = "TestButton";
  const tip = figma.createFrame(); tip.name = "Tooltip"; tip.resize(200, 60); tip.x = 400;
  const g = figma.createFrame(); g.name = "Grad"; g.x = 700; g.resize(200, 100);
  g.fills = [{ type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }];
  const inst = def.createInstance(); inst.y = 200;
  await inst.setReactionsAsync([
    { trigger: { type: "ON_HOVER" }, actions: [{ type: "NODE", destinationId: hov.id, navigation: "CHANGE_TO", transition: { type: "SMART_ANIMATE", easing: { type: "EASE_OUT" }, duration: 0.2 }, preserveScrollPosition: false, resetVideoPosition: false }] },
    { trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: tip.id, navigation: "OVERLAY", transition: null, preserveScrollPosition: false, resetVideoPosition: false }] },
  ]);
  return { page: page.id, inst: inst.id, grad: g.id };` });
const ids = JSON.parse(setup);
await call("figma_get_node", { url: SCRATCH, nodeId: ids.inst, depth: 0 });
await call("figma_get_node", { url: SCRATCH, nodeId: ids.grad, depth: 0 });
await call("figma_get_component_states", { url: SCRATCH, nodeId: ids.inst, depth: 1 });
await call("figma_execute", { url: SCRATCH, code: `const p = await figma.getNodeByIdAsync("${ids.page}"); await figma.setCurrentPageAsync(figma.root.children.find(x => x !== p)); p.remove(); return "cleaned";` });
await c.close();
