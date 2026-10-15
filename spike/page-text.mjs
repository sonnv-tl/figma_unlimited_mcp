import { connectShared, shutdownShared } from "../dist/chrome.js";
const b = await connectShared();
const page = await b.contexts()[0].newPage();
await page.goto(`https://www.figma.com/design/${process.argv[2]}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
console.log(page.url());
console.log(JSON.stringify(await page.evaluate(() => ({ title: document.title, canvas: !!document.querySelector("canvas"), text: document.body.innerText.slice(0, 600) }))));
await shutdownShared(b);
