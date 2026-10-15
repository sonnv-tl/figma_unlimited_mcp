import { connectShared, shutdownShared } from "../dist/chrome.js";
const [OUT, KEY] = process.argv.slice(2);
const b = await connectShared();
const ctx = b.contexts()[0];
const page = await ctx.newPage();
await page.goto(`https://www.figma.com/design/${KEY}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: OUT + "/dup-1-loaded.png" });
// Inventory of buttons in the top-left area
const btns = await page.evaluate(() => [...document.querySelectorAll("button,[role=button]")].map((e) => {
  const r = e.getBoundingClientRect();
  return { label: e.getAttribute("aria-label"), testid: e.getAttribute("data-testid"), text: e.innerText?.slice(0, 40), x: Math.round(r.x), y: Math.round(r.y) };
}).filter((e) => e.y < 120 && e.x < 400));
console.log(JSON.stringify(btns, null, 1));
await page.mouse.click(720, 450);
await page.keyboard.press("Control+/");
await page.waitForTimeout(1000);
await page.screenshot({ path: OUT + "/dup-2-quick.png" });
await page.keyboard.type("duplicate", { delay: 30 });
await page.waitForTimeout(1500);
await page.screenshot({ path: OUT + "/dup-3-typed.png" });
await page.keyboard.press("Escape");
await shutdownShared(b);
