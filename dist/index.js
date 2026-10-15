#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FigmaBrowser } from "./browser.js";
import { config, log } from "./config.js";
import { loadCopies, loadScratch } from "./copies.js";
import { registerSession, unregisterSession } from "./chrome.js";
import { parseFigmaRef } from "./url.js";
import { comparePngs, pngWidth } from "./compare.js";
const browser = new FigmaBrowser();
const server = new McpServer({ name: "figma-unlimited", version: "0.1.0" });
const text = (t) => ({ type: "text", text: t });
const json = (v) => text(JSON.stringify(v));
function withFile(handler, opts = {}) {
    return async (args) => {
        try {
            const ctx = await openFile(args, opts.fileLevel);
            return { content: await handler(ctx, args) };
        }
        catch (e) {
            const msg = e.message ?? String(e);
            log("tool error:", msg);
            return { content: [text(`Error: ${msg}`)], isError: true };
        }
    };
}
/** fileLevel tools (pages, search, tokens) ignore any node-id in the URL. */
async function openFile(args, fileLevel = false) {
    const ref = parseFigmaRef(args.url, args.nodeId);
    if (fileLevel)
        ref.nodeId = undefined;
    const opened = await browser.open(ref.fileKey, { refresh: args.refresh, wholeFile: args.copyWholeFile, nodeId: ref.nodeId });
    const nodeId = (await opened.resolve(ref.nodeId)) ?? undefined;
    const note = opened.mode === "node-copy"
        ? `(view-only source ${opened.sourceKey}: node ${ref.nodeId} is read from its copy ${nodeId} in your scratch file ${opened.fileKey}; child ids returned here can be passed back with the same url)`
        : opened.mode === "file-copy"
            ? `(view-only source ${opened.sourceKey} → working on whole-file drafts copy ${opened.fileKey})`
            : "";
    return { ...opened, nodeId, note };
}
const urlArg = z.string().describe("Figma file URL (may include ?node-id=) or bare file key");
const nodeArg = z.string().optional().describe('Node id like "3315:2" or "3315-2". Overrides node-id in the URL. Omit for the current page.');
const refreshArg = z.boolean().optional().describe("For view-only files: copy the node (or file) again to pick up the latest design");
const wholeFileArg = z.boolean().optional().describe("For view-only files: duplicate the ENTIRE file to your drafts instead of copying only the requested node. Only needed for whole-file operations (listing pages, searching, variables).");
const safeName = (s) => s.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/_+/g, "_").slice(0, 80) || "node";
// ---------------------------------------------------------------------------
server.registerTool("figma_get_file", {
    description: "Open a Figma file (headless, no API quota) and list its pages. For view-only files this needs copyWholeFile: true; prefer passing a node-id URL to the node tools instead, which copies just that node.",
    inputSchema: { url: urlArg, refresh: refreshArg, copyWholeFile: wholeFileArg },
}, withFile(async (f) => {
    const info = await browser.call(f.page, "info");
    return [json({ fileKey: f.fileKey, sourceKey: f.sourceKey, viaCopy: f.viaCopy, ...info })];
}, { fileLevel: true }));
server.registerTool("figma_get_node", {
    description: "Get a node subtree as compact JSON for implementing UI: geometry, auto-layout (mode/gap/padding/align/sizing/wrap) and grid layout (tracks, cells), constraints, scroll, " +
        "fills/strokes/radius/effects (hex, gradient angle, image scale mode/crop, with bound variable & style names), masks, " +
        "text content and typography (per-range font, paragraph spacing, lists, links), instance component/variant/props, and prototype reactions (hover/click → overlay/variant change, with transition). " +
        "Small vector-only groups are collapsed as icon:true (export them with figma_export). Depth is reduced automatically if output is too large. " +
        "Use figma_get_component_states for hover/pressed/disabled variants and figma_compare to verify your implementation visually.",
    inputSchema: {
        url: urlArg,
        nodeId: nodeArg,
        depth: z.number().int().min(0).max(20).optional().describe("Child levels to include (default 4)"),
        refresh: refreshArg,
    },
}, withFile(async (f, args) => {
    let depth = args.depth ?? 4;
    for (;;) {
        const node = await browser.call(f.page, "getNode", f.nodeId ?? null, depth);
        const out = JSON.stringify(node);
        if (out.length <= config.maxJsonChars || depth === 0) {
            const header = [f.note, depth !== (args.depth ?? 4) ? `depth reduced to ${depth} to fit output; query children by id for more` : ""].filter(Boolean).join(" ");
            return header ? [text(header), text(out)] : [text(out)];
        }
        depth--;
    }
}));
server.registerTool("figma_screenshot", {
    description: "Render a node (frame, component, section…) to an image and return it for visual reference. Rendered by Figma itself, no API quota.",
    inputSchema: {
        url: urlArg,
        nodeId: nodeArg,
        scale: z.number().min(0.1).max(4).optional().describe("Render scale (default 1)"),
        maxDimension: z.number().int().min(100).max(8000).optional().describe("Downscale so the longest side fits (default 1568)"),
        format: z.enum(["PNG", "JPG"]).optional(),
        savePath: z.string().optional().describe("Also write the image to this file path"),
        refresh: refreshArg,
    },
}, withFile(async (f, args) => {
    const format = args.format ?? "PNG";
    const r = await browser.call(f.page, "exportNode", f.nodeId ?? null, format, args.scale ?? 1, args.maxDimension ?? 1568);
    const out = [text(`${r.type} "${r.name}" (${r.id}) ${f.note}`.trim())];
    if (args.savePath) {
        fs.mkdirSync(path.dirname(path.resolve(args.savePath)), { recursive: true });
        fs.writeFileSync(args.savePath, Buffer.from(r.base64, "base64"));
        out.push(text(`saved: ${path.resolve(args.savePath)}`));
    }
    out.push({ type: "image", data: r.base64, mimeType: format === "PNG" ? "image/png" : "image/jpeg" });
    return out;
}));
server.registerTool("figma_export", {
    description: "Export one or more nodes to files on disk (SVG for icons/vectors, PNG/JPG for raster, PDF). Returns the written paths.",
    inputSchema: {
        url: urlArg,
        nodeIds: z.array(z.string()).min(1).describe('Node ids, e.g. ["12:34","12:35"]'),
        format: z.enum(["SVG", "PNG", "JPG", "PDF"]),
        scale: z.number().min(0.1).max(4).optional().describe("PNG/JPG scale (default 2)"),
        outDir: z.string().describe("Directory to write files into"),
        refresh: refreshArg,
    },
}, withFile(async (f, args) => {
    fs.mkdirSync(args.outDir, { recursive: true });
    const ext = args.format.toLowerCase();
    const written = [];
    for (const raw of args.nodeIds) {
        const id = raw.replace(/-/g, ":");
        const r = await browser.call(f.page, "exportNode", await f.resolve(id), args.format, args.scale ?? 2, null);
        const file = path.resolve(args.outDir, `${safeName(r.name)}_${id.replace(/[:;]/g, "-")}.${ext}`);
        fs.writeFileSync(file, Buffer.from(r.base64, "base64"));
        written.push(file);
    }
    return [json({ written, note: f.note || undefined })];
}));
server.registerTool("figma_export_images", {
    description: "Save the original bitmap images used as image fills inside a node (photos, illustrations) to disk.",
    inputSchema: { url: urlArg, nodeId: nodeArg, outDir: z.string(), refresh: refreshArg },
}, withFile(async (f, args) => {
    const imgs = await browser.call(f.page, "imageFills", f.nodeId ?? null);
    fs.mkdirSync(args.outDir, { recursive: true });
    const written = imgs.map((img) => {
        const buf = Buffer.from(img.base64, "base64");
        const ext = buf[0] === 0x89 ? "png" : buf[0] === 0xff ? "jpg" : buf.subarray(0, 4).toString() === "GIF8" ? "gif" : "bin";
        const file = path.resolve(args.outDir, `${safeName(img.nodeName)}_${img.hash.slice(0, 8)}.${ext}`);
        fs.writeFileSync(file, buf);
        return { file, hash: img.hash };
    });
    return [json({ count: written.length, written })];
}));
server.registerTool("figma_get_css", {
    description: "Get the CSS Figma generates for a node (same as Dev Mode's CSS panel).",
    inputSchema: { url: urlArg, nodeId: nodeArg, refresh: refreshArg },
}, withFile(async (f) => [json(await browser.call(f.page, "css", f.nodeId ?? null))]));
server.registerTool("figma_search", {
    description: "Find nodes by name (and optionally text content) across pages. Use to locate frames/components before calling figma_get_node.",
    inputSchema: {
        url: urlArg,
        query: z.string().describe("Case-insensitive substring; empty string matches all (combine with types)"),
        types: z.array(z.string()).optional().describe('Node types filter, e.g. ["FRAME","COMPONENT","COMPONENT_SET","INSTANCE","TEXT","SECTION"]'),
        pageId: z.string().optional().describe("Limit to one page"),
        searchText: z.boolean().optional().describe("Also match text content of TEXT nodes"),
        limit: z.number().int().min(1).max(500).optional().describe("Default 50"),
        refresh: refreshArg, copyWholeFile: wholeFileArg,
    },
}, withFile(async (f, args) => [
    json(await browser.call(f.page, "search", args.query, args.types ?? null, args.pageId ?? null, args.limit ?? 50, !!args.searchText)),
]));
server.registerTool("figma_get_variables", {
    description: "List local variables (design tokens) per collection with values for every mode; aliases are shown by name.",
    inputSchema: { url: urlArg, refresh: refreshArg, copyWholeFile: wholeFileArg },
}, withFile(async (f) => [json(await browser.call(f.page, "variables"))], { fileLevel: true }));
server.registerTool("figma_get_styles", {
    description: "List local paint, text, effect and grid styles with resolved values.",
    inputSchema: { url: urlArg, refresh: refreshArg, copyWholeFile: wholeFileArg },
}, withFile(async (f) => [json(await browser.call(f.page, "styles"))], { fileLevel: true }));
server.registerTool("figma_execute", {
    description: "Run JavaScript against the Figma Plugin API in the opened file. `code` is the body of an async function with `figma` in scope; `return` a JSON-serializable value. Use async APIs (figma.getNodeByIdAsync, page.loadAsync()). Changes affect the file that is open (for view-only sources: your drafts copy).",
    inputSchema: { url: urlArg, code: z.string(), refresh: refreshArg },
}, withFile(async (f, args) => {
    const result = await browser.execute(f.page, args.code);
    return [text(JSON.stringify(result ?? null))];
}, { fileLevel: true }));
server.registerTool("figma_compare", {
    description: "Visual QA: compare a PNG screenshot of your implementation with the Figma node rendered at the same width. " +
        "Take the screenshot of just the implemented element (e.g. a Playwright element screenshot; any device pixel ratio). " +
        "Returns the mismatch %, the worst regions in design px with the Figma layers under them, and a side-by-side image " +
        "(design | implementation | diff, red = different). Iterate: fix the listed layers, re-screenshot, compare again until the mismatch is minimal.",
    inputSchema: {
        url: urlArg,
        nodeId: nodeArg,
        imagePath: z.string().describe("Path to a PNG screenshot of the implementation"),
        threshold: z.number().min(0).max(1).optional().describe("Per-pixel colour tolerance 0–1 (default 0.1); raise to ignore antialiasing/font rendering"),
        outDir: z.string().optional().describe("Where to save design/diff/composite PNGs (default .cache/compare)"),
        refresh: refreshArg,
    },
}, withFile(async (f, args) => {
    const impl = fs.readFileSync(args.imagePath);
    const node = await browser.call(f.page, "getNode", f.nodeId ?? null, 0);
    if (!node.w)
        throw new Error(`Node ${node.id} has no size to compare`);
    const scale = pngWidth(impl) / node.w;
    const design = await browser.call(f.page, "exportNode", node.id, "PNG", scale, null);
    const r = comparePngs(Buffer.from(design.base64, "base64"), impl, scale, args.threshold ?? 0.1);
    const regions = r.regions.length ? await browser.call(f.page, "nodesAt", node.id, r.regions) : [];
    const dir = path.resolve(args.outDir ?? path.join(config.cacheDir, "compare"));
    fs.mkdirSync(dir, { recursive: true });
    const base = `${safeName(node.name).slice(0, 40)}_${node.id.replace(/[:;]/g, "-")}`;
    const files = {
        design: path.join(dir, `${base}_design.png`),
        diff: path.join(dir, `${base}_diff.png`),
        composite: path.join(dir, `${base}_composite.png`),
    };
    fs.writeFileSync(files.design, Buffer.from(design.base64, "base64"));
    fs.writeFileSync(files.diff, r.diff);
    fs.writeFileSync(files.composite, r.composite);
    const heightNote = Math.abs(r.designSize[1] - r.implSize[1]) > 2
        ? `Heights differ (design ${r.designSize[1]}px vs implementation ${r.implSize[1]}px at this scale); only the overlapping area was compared.`
        : undefined;
    return [
        json({
            node: `${node.name} (${node.id})`,
            scale: Math.round(scale * 1000) / 1000,
            mismatchPct: r.mismatchPct,
            designSize: r.designSize,
            implSize: r.implSize,
            heightNote,
            worstRegions: regions,
            files,
            note: f.note || undefined,
        }),
        { type: "image", data: r.composite.toString("base64"), mimeType: "image/png" },
    ];
}));
server.registerTool("figma_get_component_states", {
    description: "For an INSTANCE, COMPONENT or COMPONENT_SET: list every variant of its component set (e.g. State=Default/Hover/Pressed/Disabled) " +
        "with the exact property changes versus the default variant (colours, borders, text, visibility…) and prototype interactions. " +
        "Use it to implement :hover/:active/:disabled/focus styles and other states that a single frame does not show.",
    inputSchema: {
        url: urlArg,
        nodeId: nodeArg,
        depth: z.number().int().min(0).max(10).optional().describe("Layer depth compared inside each variant (default 3)"),
        refresh: refreshArg,
    },
}, withFile(async (f, args) => {
    const r = await browser.call(f.page, "componentStates", f.nodeId ?? null, args.depth ?? 3);
    const out = JSON.stringify(r);
    return [text(out.length > config.maxJsonChars ? out.slice(0, config.maxJsonChars) + " …(truncated; lower depth)" : out)];
}));
server.registerTool("figma_delete_copy", {
    description: "Delete copies this server created for VIEW-ONLY Figma files (it never touches source files or anything it did not create). " +
        "With url+nodeId: remove that node's copy from the scratch file. With url only: remove all node copies from that file and move its whole-file drafts copy (if any) to Figma's trash. With all: true: clean up everything. " +
        "Decide yourself when to call it: when you have finished the task that needed the node (e.g. the UI is implemented and verified), when the user moves on to a different design, or before re-copying a design that changed. " +
        "Do not delete while you still expect to inspect the node again in this task; reading again later just copies it anew (~20 s).",
    inputSchema: {
        url: urlArg.optional(),
        nodeId: nodeArg,
        all: z.boolean().optional().describe("Delete every copy (requires no url)"),
    },
}, async (args) => {
    try {
        if (!args.url && !args.all)
            throw new Error("Pass url (optionally with nodeId), or all: true");
        const ref = args.url ? parseFigmaRef(args.url, args.nodeId) : undefined;
        const r = await browser.deleteCopies(ref?.fileKey, ref?.nodeId);
        return { content: [json(r)], isError: r.errors.length > 0 };
    }
    catch (e) {
        return { content: [text(`Error: ${e.message}`)], isError: true };
    }
});
server.registerTool("figma_status", {
    description: "Show shared browser state, open file tabs (shared by all sessions), the scratch file with node copies, and whole-file copies.",
    inputSchema: {},
}, async () => ({
    content: [json({ connected: browser.isConnected, cdpPort: config.cdpPort, tabs: await browser.openTabs(), idleCloseMs: config.idleMs, headless: config.headless, wholeFileCopies: loadCopies(), scratch: loadScratch() })],
}));
server.registerTool("figma_close", {
    description: "Close the shared headless browser now to free memory. Affects every Claude Code session using this server (it also closes itself after the idle timeout).",
    inputSchema: {},
}, async () => {
    await browser.shutdown();
    return { content: [text("shared browser closed")] };
});
// ---------------------------------------------------------------------------
// Leave the shared browser running while other sessions exist; the last one out closes it.
let shuttingDown = false;
const shutdown = async () => {
    if (shuttingDown)
        return;
    shuttingDown = true;
    const others = unregisterSession();
    if (others === 0)
        await browser.shutdown();
    await browser.disconnect();
    process.exit(0);
};
registerSession();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);
await server.connect(new StdioServerTransport());
log("ready");
