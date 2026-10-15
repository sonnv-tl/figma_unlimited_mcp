// Feasibility probe: open a Figma file in (headless) Chrome and call the Plugin API via window.figma.
// Usage: node spike/probe.mjs <figma-url> [--headed] [--out <dir>]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { launch, patchUserAgent, ROOT } from "./common.mjs";

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith("http"));
const headless = !args.includes("--headed");
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, ".cache");
fs.mkdirSync(outDir, { recursive: true });

if (!url) {
  console.error("Usage: node spike/probe.mjs <figma-url> [--headed] [--out <dir>]");
  process.exit(1);
}
const nodeId = new URL(url).searchParams.get("node-id")?.replace("-", ":");

const t0 = Date.now();
const lap = (label) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

const context = await launch({ headless });
const page = context.pages()[0] ?? (await context.newPage());
page.on("console", (m) => { if (m.type() === "error") console.log("   console.error:", m.text().slice(0, 160)); });
const ua = await patchUserAgent(context, page);
lap(`launched (headless=${headless}) UA=${ua.slice(0, 80)}...`);

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  lap(`navigated -> ${page.url().slice(0, 100)}`);

  await page.waitForFunction(() => typeof window.figma !== "undefined" && !!window.figma.currentPage, null, { timeout: 120_000 });
  lap("window.figma available");

  const info = await page.evaluate(async (nodeId) => {
    const f = window.figma;
    const out = {
      fileName: f.root.name,
      currentPage: f.currentPage.name,
      pageCount: f.root.children.length,
      editorType: f.editorType,
    };
    if (nodeId) {
      let node = await f.getNodeByIdAsync(nodeId);
      if (node?.type === "PAGE") { await node.loadAsync?.(); out.page = node.name; node = node.children[0] ?? node; }
      out.node = node ? { id: node.id, name: node.name, type: node.type, w: node.width, h: node.height, children: node.children?.length } : null;
      if (node && "exportAsync" in node) {
        const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
        out.pngBase64 = f.base64Encode(bytes);
      }
    }
    return out;
  }, nodeId);
  lap("plugin API calls done");

  if (info.pngBase64) {
    const file = path.join(outDir, `node-${nodeId.replace(":", "-")}.png`);
    fs.writeFileSync(file, Buffer.from(info.pngBase64, "base64"));
    info.pngBase64 = `<saved ${file}>`;
  }
  console.log("RESULT", JSON.stringify(info, null, 2));
} catch (e) {
  console.log("FAILED:", e.message.split("\n")[0]);
  const shot = path.join(outDir, "probe-failure.png");
  await page.screenshot({ path: shot }).catch(() => {});
  console.log("Page screenshot:", shot, "| title:", await page.title().catch(() => "?"));
} finally {
  // Rough RAM of the Chrome processes using our profile dir.
  try {
    const ps = "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*figma_unlimited_mcp*' } | Measure-Object WorkingSetSize -Sum).Sum / 1MB";
    const mb = execFileSync("powershell", ["-NoProfile", "-Command", ps]).toString().trim();
    console.log(`Chrome RAM (working set): ~${Math.round(Number(mb))} MB`);
  } catch {}
  await context.close();
  lap("closed");
}
