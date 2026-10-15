import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright-core";
import { config, log } from "./config.js";

/**
 * One shared Chrome per profile, started detached with a CDP port so that several MCP server
 * processes (one per Claude Code session) can attach to it at the same time.
 */

const CDP_URL = () => `http://127.0.0.1:${config.cdpPort}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function findChrome(): string {
  if (config.chromePath) return config.chromePath;
  if (config.channel === "chromium") return chromium.executablePath();

  const env = process.env;
  const win = (rel: string) =>
    [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean).map((base) => path.join(base!, rel));
  const candidates =
    config.channel === "msedge"
      ? os.platform() === "win32"
        ? win("Microsoft\\Edge\\Application\\msedge.exe")
        : ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/microsoft-edge"]
      : os.platform() === "win32"
        ? win("Google\\Chrome\\Application\\chrome.exe")
        : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];

  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Cannot find ${config.channel} executable. Set FIGMA_CHROME_PATH.`);
  return found;
}

/** Major version of the browser binary, without launching it. */
function browserMajor(exe: string): number | null {
  try {
    if (os.platform() === "win32") {
      // Windows installs keep a "<major>.<minor>.<build>.<patch>" folder next to the exe.
      const majors = fs.readdirSync(path.dirname(exe))
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .map((d) => Number(d.split(".")[0]));
      if (majors.length) return Math.max(...majors);
    }
    const out = execFileSync(exe, ["--version"], { timeout: 10_000 }).toString();
    const m = out.match(/(\d+)\.\d+\.\d+/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Figma's CDN rejects requests whose UA contains "HeadlessChrome" (403), including those made by
 * workers/websockets that per-page overrides don't reach, so the UA is set browser-wide at launch.
 */
function regularUserAgent(exe: string): string | null {
  const major = browserMajor(exe);
  if (!major) return null;
  const platform =
    os.platform() === "win32" ? "Windows NT 10.0; Win64; x64"
    : os.platform() === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7"
    : "X11; Linux x86_64";
  const edge = config.channel === "msedge" ? ` Edg/${major}.0.0.0` : "";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36${edge}`;
}

async function tryConnect(timeout = 2000): Promise<Browser | null> {
  try {
    return await chromium.connectOverCDP(CDP_URL(), { timeout });
  } catch {
    return null;
  }
}

function spawnChrome() {
  const exe = findChrome();
  const args = [
    `--remote-debugging-port=${config.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${config.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-blink-features=AutomationControlled",
    "--enable-unsafe-swiftshader",
    "--window-size=1440,900",
  ];
  if (config.headless) {
    args.push("--headless=new");
    const ua = regularUserAgent(exe);
    if (ua) args.push(`--user-agent=${ua}`);
    else log("could not determine browser version; relying on per-page UA override");
  }
  args.push("about:blank");
  log(`spawning shared ${config.channel} on CDP port ${config.cdpPort} (headless=${config.headless})`);
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

/** Connects to the shared Chrome, starting it if nobody has yet. Safe to call from many processes. */
export async function connectShared(): Promise<Browser> {
  const existing = await tryConnect();
  if (existing) return existing;

  fs.mkdirSync(config.cacheDir, { recursive: true });
  const lock = path.join(config.cacheDir, "launch.lock");
  let owner = false;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
    owner = true;
  } catch {
    // Someone else is launching; if their lock is stale, take over.
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > 30_000) {
      fs.writeFileSync(lock, String(process.pid));
      owner = true;
    }
  }

  try {
    if (owner) spawnChrome();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const b = await tryConnect(1500);
      if (b) return b;
      await sleep(500);
    }
    throw new Error(
      `Could not connect to Chrome on port ${config.cdpPort}. Is another program using that port, ` +
        `or is a Chrome window open with the same profile (e.g. \`npm run login\`)?`,
    );
  } finally {
    if (owner) fs.rmSync(lock, { force: true });
  }
}

/** Shuts the shared Chrome down (affects every session). */
export async function shutdownShared(browser?: Browser | null) {
  const b = browser ?? (await tryConnect());
  if (!b) return false;
  try {
    const s = await b.newBrowserCDPSession();
    await s.send("Browser.close");
  } catch {}
  return true;
}

// ---- shared activity clock (any session's tool call keeps the browser alive) ----

const activityFile = () => path.join(config.cacheDir, "last-activity");

export function markActivity() {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  const f = activityFile();
  const now = new Date();
  try {
    fs.utimesSync(f, now, now);
  } catch {
    fs.writeFileSync(f, "");
  }
}

export function idleForMs(): number {
  try {
    return Date.now() - fs.statSync(activityFile()).mtimeMs;
  } catch {
    return Infinity;
  }
}

// ---- session registry: the last MCP process to exit shuts the shared browser down ----

const sessionsDir = () => path.join(config.cacheDir, "sessions");

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function registerSession() {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(), String(process.pid)), new Date().toISOString());
}

/** Removes this process from the registry (and dead ones); returns how many other sessions remain. */
export function unregisterSession(): number {
  const dir = sessionsDir();
  fs.rmSync(path.join(dir, String(process.pid)), { force: true });
  let others = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const pid = Number(name);
    if (pid && isAlive(pid)) others++;
    else fs.rmSync(path.join(dir, name), { force: true });
  }
  return others;
}

/** Cross-process mutex via an exclusive lock file; stale locks (crashed holder) are taken over. */
export async function withLock<T>(name: string, fn: () => Promise<T>, staleMs = 120_000): Promise<T> {
  fs.mkdirSync(config.cacheDir, { recursive: true });
  const lock = path.join(config.cacheDir, `${name}.lock`);
  const deadline = Date.now() + staleMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between our attempts
      }
      if (age > staleMs || Date.now() > deadline) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      await sleep(300);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
