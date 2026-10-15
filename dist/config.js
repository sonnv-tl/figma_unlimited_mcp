import path from "node:path";
import { fileURLToPath } from "node:url";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
export const config = {
    profileDir: env.FIGMA_PROFILE_DIR || path.join(ROOT, ".profile"),
    cacheDir: env.FIGMA_CACHE_DIR || path.join(ROOT, ".cache"),
    helpersPath: path.join(ROOT, "page", "helpers.js"),
    /** Close the shared browser after this many ms without tool calls from any session. */
    idleMs: Number(env.FIGMA_IDLE_MS || 5 * 60_000),
    headless: env.FIGMA_HEADLESS !== "false",
    /** "chrome" | "msedge" | "chromium" (bundled, needs `npx playwright install chromium`). */
    channel: env.FIGMA_BROWSER_CHANNEL || "chrome",
    /** CDP port of the shared Chrome that all MCP sessions attach to. */
    cdpPort: Number(env.FIGMA_CDP_PORT || 9333),
    /** Explicit browser executable (otherwise resolved from channel). */
    chromePath: env.FIGMA_CHROME_PATH || "",
    /** When duplicating view-only files and you belong to several teams: substring of the team to use (default: first listed). */
    duplicateTeam: env.FIGMA_DUPLICATE_TEAM || "",
    /** Max open file tabs kept warm; least recently used is closed beyond this. */
    maxTabs: Number(env.FIGMA_MAX_TABS || 3),
    /** Max characters of JSON returned by figma_get_node before depth is reduced automatically. */
    maxJsonChars: Number(env.FIGMA_MAX_JSON_CHARS || 80_000),
};
export const log = (...args) => console.error("[figma-unlimited]", ...args);
