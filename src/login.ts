// One-time interactive login. Opens a visible browser with the same profile the MCP server uses.
import { chromium } from "playwright-core";
import { config } from "./config.js";
import { shutdownShared } from "./chrome.js";

// The profile can only be used by one Chrome at a time; stop the shared MCP browser first.
if (await shutdownShared()) {
  console.log("Closed the running shared browser so the profile can be used for login.");
  await new Promise((r) => setTimeout(r, 2000));
}

const ctx = await chromium.launchPersistentContext(config.profileDir, {
  channel: config.channel === "chromium" ? undefined : config.channel,
  headless: false,
  viewport: null,
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://www.figma.com/login");
console.log("Log in to Figma in the opened window (5 min max)...");

const deadline = Date.now() + 5 * 60_000;
let ok = false;
while (Date.now() < deadline && !ok) {
  ok = (await ctx.cookies("https://www.figma.com")).some((c) => c.name.includes("authn"));
  if (!ok) await new Promise((r) => setTimeout(r, 2000));
}
console.log(ok ? "Logged in. Session saved to " + config.profileDir : "Timed out waiting for login.");
await new Promise((r) => setTimeout(r, 2000));
await ctx.close();
process.exit(ok ? 0 : 1);
