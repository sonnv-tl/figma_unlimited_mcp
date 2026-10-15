// Opens a visible Chrome window so you can log in to Figma once.
// The session is stored in .profile/ and reused by headless runs.
import { launch } from "./common.mjs";

const context = await launch({ headless: false });
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.figma.com/login");
console.log("Waiting for login (5 min max)...");

const deadline = Date.now() + 5 * 60_000;
let loggedIn = false;
while (Date.now() < deadline) {
  const cookies = await context.cookies("https://www.figma.com");
  if (cookies.some((c) => c.name.includes("authn"))) { loggedIn = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(loggedIn ? "LOGIN_OK" : "LOGIN_TIMEOUT");
await new Promise((r) => setTimeout(r, 3000));
await context.close();
