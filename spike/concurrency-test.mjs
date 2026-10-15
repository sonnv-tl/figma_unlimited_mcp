// Two MCP server processes (= two Claude Code sessions) sharing one Chrome.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";

const URL_ = process.argv[2];
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const chromeProcs = () => {
  const ps = "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*figma_unlimited_mcp*' } | Measure-Object WorkingSetSize -Sum | ForEach-Object { \"$($_.Count) procs, $([math]::Round($_.Sum/1MB)) MB\" })";
  return execFileSync("powershell", ["-NoProfile", "-Command", ps]).toString().trim() || "0 procs";
};
const cdpUp = async () => { try { await fetch("http://127.0.0.1:9333/json/version"); return true; } catch { return false; } };

async function session(name) {
  const c = new Client({ name, version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env }, stderr: "inherit" }));
  const call = async (tool, args) => {
    const s = Date.now();
    const r = await c.callTool({ name: tool, arguments: args });
    const txt = r.content.filter((x) => x.type === "text").map((x) => x.text).join(" ").slice(0, 120);
    console.log(`${ts()} ${name} ${tool} ${r.isError ? "ERROR" : "ok"} ${Date.now() - s}ms ${txt}`);
    return r;
  };
  return { c, call };
}

const A = await session("A");
const B = await session("B");
console.log(`${ts()} both sessions started; CDP up: ${await cdpUp()}`);

// Concurrent first calls: only one Chrome should be spawned, one tab shared.
await Promise.all([
  A.call("figma_get_file", { url: URL_ }),
  B.call("figma_execute", { url: URL_, code: "return { page: figma.currentPage.name, styles: (await figma.getLocalTextStylesAsync()).length }" }),
]);
console.log(`${ts()} chrome: ${chromeProcs()}`);
await A.call("figma_status", {});

await A.c.close();
console.log(`${ts()} A closed; CDP up: ${await cdpUp()}`);
await B.call("figma_get_styles", { url: URL_ });

await B.c.close();
await new Promise((r) => setTimeout(r, 3000));
console.log(`${ts()} B closed (last session); CDP up: ${await cdpUp()}; chrome: ${chromeProcs()}`);
