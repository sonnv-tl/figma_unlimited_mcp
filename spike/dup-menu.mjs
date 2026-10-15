import { connectShared, shutdownShared } from "../dist/chrome.js";
const [OUT, KEY] = process.argv.slice(2);
const b = await connectShared();
const ctx = b.contexts()[0];
for (const p of ctx.pages()) if (p.url().includes(KEY)) await p.close();
const page = await ctx.newPage();
await page.goto(`https://www.figma.com/design/${KEY}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page.waitForTimeout(6000);
await page.getByRole("button", { name: "Edit file menu" }).click();
await page.waitForTimeout(1000);
await page.screenshot({ path: OUT + "/dup-menu.png" });
const items = await page.evaluate(() => [...document.querySelectorAll('[role=menuitem],[role=option],li,[data-testid*=dropdown] *')]
  .map((e) => ({ role: e.getAttribute("role"), testid: e.getAttribute("data-testid"), text: (e.innerText || "").trim().split("\n")[0] }))
  .filter((e) => e.text && e.role).slice(0, 40));
console.log(JSON.stringify(items));
await shutdownShared(b);
