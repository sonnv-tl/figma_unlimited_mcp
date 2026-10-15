import { connectShared, shutdownShared } from "../dist/chrome.js";
const [OUT, KEY] = process.argv.slice(2);
const b = await connectShared();
const ctx = b.contexts()[0];
const page = await ctx.newPage();
const reqs = [];
ctx.on("request", (r) => { if (r.method() !== "GET" && r.url().includes("/api/")) reqs.push(`${r.method()} ${r.url().slice(0, 150)}`); });
ctx.on("page", (p) => console.log("NEW PAGE event"));
await page.goto(`https://www.figma.com/design/${KEY}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page.waitForTimeout(6000);
await page.mouse.click(720, 450);
await page.keyboard.press("Control+/");
await page.waitForTimeout(800);
await page.keyboard.type("duplicate file", { delay: 30 });
await page.waitForTimeout(1200);
await page.keyboard.press("Enter");
for (let i = 1; i <= 8; i++) {
  await page.waitForTimeout(2500);
  console.log(`t+${i * 2.5}s pages:`, ctx.pages().map((p) => p.url().slice(0, 80)));
  if (i === 2 || i === 8) await page.screenshot({ path: `${OUT}/dup-click-${i}.png` });
}
console.log("REQUESTS:\n" + reqs.join("\n"));
await shutdownShared(b);
