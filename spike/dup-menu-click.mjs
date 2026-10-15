import { connectShared, shutdownShared } from "../dist/chrome.js";
const [OUT, KEY] = process.argv.slice(2);
const b = await connectShared();
const ctx = b.contexts()[0];
for (const p of ctx.pages()) if (p.url().includes(KEY)) await p.close();
const page = await ctx.newPage();
const reqs = [];
ctx.on("request", (r) => { const u = r.url(); if (r.method() !== "GET" && u.includes("/api/") && !/logger|figment-proxy|sentry|design_systems/.test(u)) reqs.push(`${r.method()} ${u.slice(0, 160)}`); });
ctx.on("page", (p) => console.log("NEW PAGE event"));
await page.goto(`https://www.figma.com/design/${KEY}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas", { timeout: 60000 });
await page.waitForTimeout(6000);
await page.getByRole("button", { name: "Edit file menu" }).click();
await page.waitForTimeout(800);
await page.getByRole("menuitem", { name: "Duplicate to your drafts" }).click();
await page.getByText("Where do you want your duplicate?").waitFor({ timeout: 10000 });
const dialog = page.getByRole("dialog");
console.log("dialog count:", await dialog.count());
const btns = await page.evaluate(() => {
  const root = [...document.querySelectorAll('[role=dialog], [class*=modal]')].find((d) => d.innerText.includes("Where do you want")) || document.body;
  return [...root.querySelectorAll("button,[role=button],[role=option],[role=menuitem],a,[tabindex]")].map((e) => ({ tag: e.tagName, role: e.getAttribute("role"), label: e.getAttribute("aria-label"), text: (e.innerText||"").trim().slice(0,50) }));
});
console.log(JSON.stringify(btns));
const row = page.getByText("L'équipe de nguyen.van.son", { exact: true }).first();
await row.click();
for (let i = 1; i <= 10; i++) {
  await page.waitForTimeout(2000);
  const urls = ctx.pages().map((p) => p.url().slice(0, 70));
  console.log(`t+${i * 2}s`, urls);
  if (i === 1 || i === 4) await page.screenshot({ path: `${OUT}/dup-after-team-${i}.png` });
  if (urls.some((u) => /design\/[A-Za-z0-9]+/.test(u) && !u.includes(KEY))) break;
}
console.log("REQUESTS:\n" + reqs.join("\n"));
await shutdownShared(b);
