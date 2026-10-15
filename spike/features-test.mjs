// Exercises reactions, component states, and compare (design render vs itself / a perturbed copy).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import { PNG } from "pngjs";
const [URL_, OUT] = process.argv.slice(2);
const c = new Client({ name: "features", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } }));
const call = async (name, args, max = 1500) => {
  const t = Date.now();
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const txt = r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  console.log(`\n=== ${name} ${r.isError ? "[ERROR] " : ""}(${Date.now() - t}ms)\n${txt.slice(0, max)}`);
  return { r, txt };
};
const body = (txt) => JSON.parse(txt.split("\n").find((l) => l.startsWith("{") || l.startsWith("[")));

// 1) full tree: look for reactions / instances
const { txt } = await call("figma_get_node", { url: URL_, depth: 12 }, 200);
const tree = body(txt);
const withRx = [], instances = [];
(function walk(n) { if (n.reactions) withRx.push({ id: n.id, name: n.name, reactions: n.reactions }); if (n.type === "INSTANCE") instances.push({ id: n.id, name: n.name, component: n.component, variant: n.variant }); (n.children || []).forEach(walk); })(tree);
console.log("nodes with reactions:", JSON.stringify(withRx.slice(0, 5)));
console.log("instances:", instances.length, JSON.stringify(instances.filter((i) => i.variant).slice(0, 8)));

// 2) component states for an instance that has variants
const candidate = instances.find((i) => /button|ボタン|tab|タブ|checkbox|chip/i.test((i.component || "") + i.name) && i.variant) || instances.find((i) => i.variant);
if (candidate) await call("figma_get_component_states", { url: URL_, nodeId: candidate.id, depth: 2 }, 2500);

// 3) compare: dashboard frame vs its own render (expect ~0%), then vs a perturbed version
const frame = tree.children.find((ch) => ch.type === "FRAME") ?? tree;
const shot = `${OUT}/impl-same.png`;
await call("figma_screenshot", { url: URL_, nodeId: frame.id, scale: 1, maxDimension: 8000, savePath: shot }, 200);
await call("figma_compare", { url: URL_, nodeId: frame.id, imagePath: shot }, 600);
const png = PNG.sync.read(fs.readFileSync(shot));
for (let y = 300; y < 360; y++) for (let x = 600; x < 900; x++) { const i = (y * png.width + x) * 4; png.data[i] = 30; png.data[i + 1] = 120; png.data[i + 2] = 255; }
fs.writeFileSync(`${OUT}/impl-perturbed.png`, PNG.sync.write(png));
await call("figma_compare", { url: URL_, nodeId: frame.id, imagePath: `${OUT}/impl-perturbed.png`, outDir: OUT }, 2500);
await c.close();
