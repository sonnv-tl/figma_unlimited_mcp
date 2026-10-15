import { chromium } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILE_DIR = path.join(ROOT, ".profile");

export async function launch({ headless }) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless,
    viewport: { width: 1440, height: 900 },
    args: ["--enable-unsafe-swiftshader", "--disable-blink-features=AutomationControlled"],
  });
  return context;
}

// Headless Chrome advertises "HeadlessChrome" in its UA; rewrite it per page.
export async function patchUserAgent(context, page) {
  const ua = await page.evaluate(() => navigator.userAgent);
  if (!ua.includes("HeadlessChrome")) return ua;
  const fixed = ua.replace("HeadlessChrome", "Chrome");
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: fixed });
  return fixed;
}
