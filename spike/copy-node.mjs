// Feasibility: copy one node from a view-only file and paste it into a scratch file, via
// intercepted copy/paste events (no OS clipboard).
import { connectShared, shutdownShared } from "../dist/chrome.js";
const [OUT, SRC, NODE] = process.argv.slice(2);
const t0 = Date.now(); const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const b = await connectShared();
const ctx = b.contexts()[0];

// 1) source, view-only, with node selected via URL
const src = await ctx.newPage();
await src.goto(`https://www.figma.com/design/${SRC}/x?node-id=${NODE.replace(":", "-")}`, { waitUntil: "domcontentloaded" });
await src.waitForSelector("canvas", { timeout: 60000 });
await src.waitForTimeout(8000);
lap("source loaded");
await src.evaluate(() => {
  window.__copied = null;
  window.addEventListener("copy", (e) => {
    const d = e.clipboardData;
    window.__copied = { types: [...d.types], html: d.getData("text/html"), text: d.getData("text/plain") };
  }); // bubbling on window: runs after Figma's handler filled clipboardData
});
await src.keyboard.press("Control+c");
await src.waitForTimeout(3000);
const copied = await src.evaluate(() => window.__copied && { types: window.__copied.types, htmlLen: window.__copied.html.length, head: window.__copied.html.slice(0, 160), text: window.__copied.text.slice(0, 80) });
lap("copy event: " + JSON.stringify(copied));
await src.screenshot({ path: OUT + "/copy-src.png" });
if (!copied?.htmlLen) { await shutdownShared(b); process.exit(1); }
const html = await src.evaluate(() => window.__copied.html);
const text = await src.evaluate(() => window.__copied.text);

// 2) scratch file
const dst = await ctx.newPage();
await dst.goto("https://www.figma.com/file/new", { waitUntil: "domcontentloaded" });
await dst.waitForFunction(() => typeof window.figma !== "undefined" && !!window.figma.currentPage, null, { timeout: 90000 });
lap("scratch file: " + dst.url().slice(0, 80));
await dst.waitForTimeout(2000);
await dst.mouse.click(720, 450);
const res = await dst.evaluate(async ([html, text]) => {
  const dt = new DataTransfer();
  dt.setData("text/html", html);
  dt.setData("text/plain", text);
  const target = document.activeElement || document;
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 5000));
  const sel = figma.currentPage.selection;
  return { active: target.tagName, selection: sel.map((n) => ({ id: n.id, name: n.name, type: n.type, w: n.width, h: n.height, kids: n.children?.length })), pageChildren: figma.currentPage.children.length };
}, [html, text]);
lap("paste result: " + JSON.stringify(res));
await dst.screenshot({ path: OUT + "/copy-dst.png" });
await shutdownShared(b);
