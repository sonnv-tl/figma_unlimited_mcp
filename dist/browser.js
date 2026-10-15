import fs from "node:fs";
import path from "node:path";
import { config, log } from "./config.js";
import { loadCopies, saveCopy, deleteCopy, loadScratch, updateScratch, nodeCopyKey } from "./copies.js";
import { connectShared, shutdownShared, markActivity, idleForMs, withLock } from "./chrome.js";
const FILE_URL = (key) => `https://www.figma.com/design/${key}`;
const KEY_IN_URL = /\/(?:design|file)\/([A-Za-z0-9]+)/;
const keyOf = (u) => u.match(KEY_IN_URL)?.[1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Text Figma shows instead of the editor for deleted or inaccessible files. */
const GONE = /couldn.t find that one|may have been deleted|made unavailable|doesn.t exist|don.t have access|File not found|request access/i;
export class FileUnavailableError extends Error {
    constructor(detail) {
        super(`Cannot open file (deleted, moved or no access): ${detail}`);
    }
}
/**
 * Per-process handle on the shared Chrome. Tabs live in the browser, so every session sees and
 * reuses the same file tabs; `window.__fumLastUsed` in each tab records the last use by anyone.
 */
export class FigmaBrowser {
    browser = null;
    connecting = null;
    sweeper = null;
    opening = new Map();
    helpersSource = "";
    get isConnected() {
        return this.browser?.isConnected() ?? false;
    }
    async getContext() {
        markActivity();
        if (this.browser?.isConnected())
            return this.browser.contexts()[0];
        if (!this.connecting) {
            this.connecting = (async () => {
                const b = await connectShared();
                b.on("disconnected", () => {
                    if (this.browser === b)
                        this.browser = null;
                });
                this.browser = b;
                this.startSweeper();
                return b.contexts()[0];
            })().finally(() => (this.connecting = null));
        }
        return this.connecting;
    }
    /** Closes the shared browser once no session has used it for `idleMs`. */
    startSweeper() {
        if (this.sweeper)
            return;
        const every = Math.min(60_000, Math.max(5_000, config.idleMs / 4));
        this.sweeper = setInterval(async () => {
            if (!this.browser?.isConnected())
                return;
            if (idleForMs() < config.idleMs)
                return;
            log(`no activity from any session for ${config.idleMs}ms, closing shared browser`);
            await shutdownShared(this.browser);
            this.browser = null;
        }, every);
        this.sweeper.unref();
    }
    /** Detach this process without closing the shared browser (other sessions may be using it). */
    async disconnect() {
        if (this.sweeper)
            clearInterval(this.sweeper);
        this.sweeper = null;
        const b = this.browser;
        this.browser = null;
        // For CDP-connected browsers, close() only drops the connection.
        if (b)
            await b.close().catch(() => { });
    }
    /** Close the shared browser for every session. */
    async shutdown() {
        await shutdownShared(this.browser);
        this.browser = null;
    }
    async openTabs() {
        if (!this.browser?.isConnected())
            return [];
        const pages = this.browser.contexts()[0].pages().filter((p) => keyOf(p.url()));
        return Promise.all(pages.map(async (p) => {
            const last = await p.evaluate(() => window.__fumLastUsed).catch(() => undefined);
            return { fileKey: keyOf(p.url()), idleSec: last ? Math.round((Date.now() - last) / 1000) : null };
        }));
    }
    async newPage(ctx) {
        const page = await ctx.newPage();
        // Headless Chrome advertises "HeadlessChrome"; present a regular UA.
        const ua = await page.evaluate(() => navigator.userAgent);
        if (ua.includes("HeadlessChrome")) {
            const cdp = await ctx.newCDPSession(page);
            await cdp.send("Emulation.setUserAgentOverride", { userAgent: ua.replace("HeadlessChrome", "Chrome") });
        }
        return page;
    }
    async hasFigma(page) {
        return page.evaluate(() => typeof window.figma !== "undefined" && !!window.figma.currentPage).catch(() => false);
    }
    /** Keeps at most `maxTabs` Figma file tabs, closing the least recently used. */
    async evictIfNeeded(ctx) {
        const tabs = await Promise.all(ctx.pages().filter((p) => keyOf(p.url())).map(async (p) => ({
            p,
            last: (await p.evaluate(() => window.__fumLastUsed).catch(() => 0)) ?? 0,
        })));
        tabs.sort((a, b) => a.last - b.last);
        while (tabs.length >= config.maxTabs)
            await tabs.shift().p.close().catch(() => { });
    }
    /** Waits until the file is either editable (window.figma) or clearly view-only. */
    async waitForAccess(page, timeoutMs = 90_000) {
        const start = Date.now();
        let canvasSince = 0;
        while (Date.now() - start < timeoutMs) {
            if (/\/login|\/signup/.test(page.url())) {
                throw new Error("Not logged in to Figma. Run `npm run login` in the figma_unlimited_mcp folder first.");
            }
            const state = await page
                .evaluate(() => ({
                figma: typeof window.figma !== "undefined" && !!window.figma.currentPage,
                canvas: !!document.querySelector("canvas"),
                text: document.body?.innerText?.slice(0, 2000) ?? "",
            }))
                .catch(() => ({ figma: false, canvas: false, text: "" }));
            if (state.figma)
                return "edit";
            if (!state.canvas && GONE.test(state.text)) {
                throw new FileUnavailableError(state.text.split("\n").slice(0, 2).join(" — "));
            }
            if (state.canvas) {
                if (!canvasSince)
                    canvasSince = Date.now();
                // The editor renders the canvas a few seconds before exposing window.figma; give it time.
                if (Date.now() - canvasSince > 15_000)
                    return "view";
            }
            await sleep(500);
        }
        throw new Error(`Timed out loading Figma file ${page.url()}`);
    }
    /** Returns a tab for the file, reusing one opened by any session. Dedupes concurrent opens in this process. */
    openKey(fileKey) {
        let p = this.opening.get(fileKey);
        if (!p) {
            p = this.doOpenKey(fileKey).finally(() => this.opening.delete(fileKey));
            this.opening.set(fileKey, p);
        }
        return p;
    }
    async doOpenKey(fileKey) {
        const ctx = await this.getContext();
        // Reuse a tab any session already loaded: editable (window.figma) or marked view-only by us.
        const findReady = async () => {
            for (const page of ctx.pages()) {
                if (keyOf(page.url()) !== fileKey)
                    continue;
                if (await this.hasFigma(page))
                    return { page, access: "edit" };
                if (await page.evaluate(() => window.__fumViewOnly === true).catch(() => false))
                    return { page, access: "view" };
            }
            return null;
        };
        const ready = await findReady();
        if (ready)
            return ready;
        // Serialize opening the same file across sessions so they share one tab.
        return withLock(`open-${fileKey}`, async () => (await findReady()) ?? this.openNewTab(ctx, fileKey));
    }
    async openNewTab(ctx, fileKey) {
        await this.evictIfNeeded(ctx);
        const page = await this.newPage(ctx);
        log(`opening ${fileKey}`);
        await page.goto(FILE_URL(fileKey), { waitUntil: "domcontentloaded", timeout: 60_000 });
        const access = await this.waitForAccess(page);
        if (access === "view")
            await page.evaluate(() => (window.__fumViewOnly = true));
        return { page, access };
    }
    /**
     * Opens a file for Plugin API access and returns a resolver mapping the caller's node ids to
     * ids in the opened file.
     * - Editable files are used directly.
     * - View-only files: by default only the requested node is copied into a scratch file in your
     *   drafts (`nodeId` required); with `wholeFile` the entire file is duplicated to drafts.
     */
    async open(sourceKey, opts = {}) {
        const direct = (page, fileKey, mode) => ({
            page, fileKey, sourceKey, mode, viaCopy: mode !== "direct", resolve: async (id) => id ?? null,
        });
        // A whole-file copy made earlier keeps being used until refreshed or deleted.
        const mapped = loadCopies()[sourceKey];
        if (mapped && !(opts.refresh && opts.wholeFile)) {
            try {
                const { page, access } = await this.openKey(mapped.copyKey);
                if (access === "edit")
                    return direct(page, mapped.copyKey, "file-copy");
            }
            catch (e) {
                log(`stored copy ${mapped.copyKey} unusable (${e.message})`);
            }
            deleteCopy(sourceKey);
        }
        const { page, access } = await this.openKey(sourceKey);
        if (access === "edit")
            return direct(page, sourceKey, "direct");
        if (opts.wholeFile) {
            const sourceName = this.titleOf(await page.title());
            const copyKey = await this.duplicateToDrafts(page, sourceKey);
            saveCopy(sourceKey, { copyKey, sourceName, createdAt: new Date().toISOString() });
            log(`duplicated ${sourceKey} -> ${copyKey}`);
            const opened = await this.openKey(copyKey);
            if (opened.access !== "edit")
                throw new Error(`Duplicated file ${copyKey} is still not editable`);
            return direct(opened.page, copyKey, "file-copy");
        }
        if (!opts.nodeId) {
            throw new Error(`File ${sourceKey} is view-only for you. Pass a node id (?node-id= in the URL or nodeId) and only that node ` +
                `is copied into your scratch file, or set copyWholeFile: true to duplicate the entire file to your drafts.`);
        }
        const scratch = await this.ensureScratch();
        return {
            page: scratch.page,
            fileKey: scratch.fileKey,
            sourceKey,
            mode: "node-copy",
            viaCopy: true,
            resolve: async (id) => {
                if (!id)
                    throw new Error("A node id is required for view-only files.");
                return this.resolveNodeCopy(sourceKey, page, scratch.page, id, !!opts.refresh);
            },
        };
    }
    titleOf(title) {
        return title.replace(/\s*[–-]\s*Figma\s*$/, "");
    }
    /** The editable scratch file in your drafts that receives single-node copies (created on first use). */
    async ensureScratch() {
        return withLock("scratch", async () => {
            const known = loadScratch().fileKey;
            if (known) {
                try {
                    const { page, access } = await this.openKey(known);
                    if (access === "edit")
                        return { page, fileKey: known };
                }
                catch (e) {
                    log(`scratch file ${known} unusable (${e.message}); creating a new one`);
                }
            }
            const ctx = await this.getContext();
            await this.evictIfNeeded(ctx);
            const page = await this.newPage(ctx);
            log("creating scratch file in drafts");
            await page.goto("https://www.figma.com/file/new", { waitUntil: "domcontentloaded", timeout: 60_000 });
            if ((await this.waitForAccess(page)) !== "edit")
                throw new Error("Could not create an editable scratch file");
            const fileKey = keyOf(page.url());
            if (!fileKey)
                throw new Error(`Unexpected scratch file URL ${page.url()}`);
            updateScratch((s) => {
                s.fileKey = fileKey;
                s.nodes = {};
            });
            return { page, fileKey };
        });
    }
    /**
     * Maps a node id given for a view-only source to a node in the scratch file:
     * 1. a node copied earlier from that source id,
     * 2. an id inside such a copy (ids we returned from earlier calls),
     * 3. otherwise the node is copied now (select in source → copy → paste into scratch).
     */
    async resolveNodeCopy(sourceKey, sourcePage, scratchPage, nodeId, refresh) {
        const key = nodeCopyKey(sourceKey, nodeId);
        return withLock(`copy-${sourceKey}-${nodeId.replace(/[^\w-]/g, "_")}`, async () => {
            const state = loadScratch();
            const existing = state.nodes[key];
            if (existing) {
                const alive = await scratchPage.evaluate(async (id) => !!(await window.figma.getNodeByIdAsync(id)), existing.scratchId);
                if (alive && !refresh)
                    return existing.scratchId;
                if (alive)
                    await scratchPage.evaluate(async (id) => (await window.figma.getNodeByIdAsync(id))?.remove(), existing.scratchId);
            }
            if (!refresh) {
                const roots = Object.entries(state.nodes).filter(([k]) => k.startsWith(sourceKey + " ")).map(([, v]) => v.scratchId);
                const inside = await scratchPage.evaluate(async ([id, roots]) => {
                    let n = await window.figma.getNodeByIdAsync(id);
                    while (n) {
                        if (roots.includes(n.id))
                            return true;
                        n = n.parent;
                    }
                    return false;
                }, [nodeId, roots]);
                if (inside)
                    return nodeId;
            }
            const sourceName = this.titleOf(await sourcePage.title());
            const payload = await this.copyFromViewOnly(sourcePage, sourceKey, nodeId);
            const scratchId = await this.pasteIntoScratch(scratchPage, payload, `${sourceName} [${sourceKey}]`);
            updateScratch((s) => {
                s.nodes[key] = { scratchId, sourceName, copiedAt: new Date().toISOString() };
            });
            log(`copied ${sourceKey} ${nodeId} -> scratch ${scratchId}`);
            return scratchId;
        });
    }
    /** Selects a node in a view-only file (via ?node-id=) and captures Figma's clipboard payload. */
    async copyFromViewOnly(page, sourceKey, nodeId) {
        await page.goto(`${FILE_URL(sourceKey)}?node-id=${encodeURIComponent(nodeId.replace(/:/g, "-"))}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForSelector("canvas", { timeout: 60_000 });
        await page.evaluate(() => {
            window.__fumViewOnly = true;
            window.__fumCopied = null;
            // A bubbling listener on window runs after Figma's own handler has filled clipboardData,
            // so the OS clipboard is never read.
            window.addEventListener("copy", (e) => {
                const d = e.clipboardData;
                window.__fumCopied = { html: d.getData("text/html"), text: d.getData("text/plain") };
            });
        });
        const deadline = Date.now() + 60_000;
        await sleep(3000);
        while (Date.now() < deadline) {
            await page.keyboard.press("Control+c");
            await sleep(1500);
            const got = await page.evaluate(() => window.__fumCopied);
            if (got?.html?.includes("(figmeta)"))
                return got;
            await sleep(1000);
        }
        throw new Error(`Could not copy node ${nodeId} from ${sourceKey} (does the node exist, and may viewers copy this file?)`);
    }
    /** Pastes a captured Figma clipboard payload into the scratch file (one page per source); returns the new root id. */
    async pasteIntoScratch(page, payload, pageName) {
        await page.bringToFront();
        await page.evaluate(async (name) => {
            const f = window.figma;
            let p = f.root.children.find((c) => c.name === name);
            if (!p) {
                // Reuse an untouched default page, otherwise add one.
                const first = f.root.children[0];
                if (f.root.children.length === 1 && first.children.length === 0 && /^Page 1$/.test(first.name)) {
                    first.name = name;
                    p = first;
                }
                else {
                    p = f.createPage();
                    p.name = name;
                }
            }
            await f.setCurrentPageAsync(p);
            f.currentPage.selection = [];
        }, pageName);
        await page.mouse.click(720, 450); // focus the editor's hidden input
        const id = await page.evaluate(async ({ html, text }) => {
            const f = window.figma;
            f.currentPage.selection = []; // otherwise Figma pastes inside the selected frame
            const dt = new DataTransfer();
            dt.setData("text/html", html);
            dt.setData("text/plain", text);
            (document.activeElement || document).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
            for (let i = 0; i < 60; i++) {
                await new Promise((r) => setTimeout(r, 250));
                const sel = f.currentPage.selection;
                if (sel.length) {
                    const root = sel[0];
                    // Park new copies to the right of everything else on the page.
                    const others = f.currentPage.children.filter((c) => c !== root);
                    if (others.length && "x" in root) {
                        root.x = Math.max(...others.map((c) => c.x + c.width)) + 400;
                        root.y = 0;
                    }
                    f.currentPage.selection = [];
                    return root.id;
                }
            }
            return null;
        }, payload);
        if (!id)
            throw new Error("Paste into scratch file produced no nodes");
        // Unpublished variables in the source: import them so their names (not ids) resolve.
        const importVars = page.getByRole("button", { name: /Copy variables into this file/i });
        if (await importVars.isVisible({ timeout: 3000 }).catch(() => false))
            await importVars.click().catch(() => { });
        return id;
    }
    /**
     * Deletes copies this server made. Never touches source files or any file it did not create.
     * - sourceKey + nodeId: that node's copy in the scratch file
     * - sourceKey only: all node copies from that source, and its whole-file copy (moved to Figma trash)
     * - neither: every node copy in the scratch file, and every whole-file copy
     */
    async deleteCopies(sourceKey, nodeId) {
        const state = loadScratch();
        const result = { nodesRemoved: 0, filesTrashed: [], errors: [] };
        const nodeKeys = Object.keys(state.nodes).filter((k) => !sourceKey ? true : nodeId ? k === nodeCopyKey(sourceKey, nodeId) : k.startsWith(sourceKey + " "));
        if (nodeKeys.length && state.fileKey) {
            const { page, access } = await this.openKey(state.fileKey);
            if (access === "edit") {
                result.nodesRemoved = await page.evaluate(async (ids) => {
                    const f = window.figma;
                    let n = 0;
                    for (const id of ids) {
                        const node = await f.getNodeByIdAsync(id);
                        if (node) {
                            node.remove();
                            n++;
                        }
                    }
                    // Drop per-source pages that became empty (a file needs at least one page).
                    for (const p of [...f.root.children]) {
                        await p.loadAsync();
                        if (p.children.length === 0 && f.root.children.length > 1) {
                            if (f.currentPage === p)
                                await f.setCurrentPageAsync(f.root.children.find((x) => x !== p));
                            p.remove();
                        }
                    }
                    return n;
                }, nodeKeys.map((k) => state.nodes[k].scratchId));
            }
        }
        updateScratch((s) => nodeKeys.forEach((k) => delete s.nodes[k]));
        if (!nodeId) {
            const copies = loadCopies();
            for (const [src, entry] of Object.entries(copies)) {
                if (sourceKey && src !== sourceKey)
                    continue;
                try {
                    await this.trashFile(entry.copyKey);
                    deleteCopy(src);
                    result.filesTrashed.push(entry.copyKey);
                }
                catch (e) {
                    if (e instanceof FileUnavailableError) {
                        deleteCopy(src); // already deleted, e.g. by hand in Figma
                        result.filesTrashed.push(`${entry.copyKey} (already gone)`);
                        continue;
                    }
                    result.errors.push(`${entry.copyKey}: ${e.message.split("\n")[0]}`);
                }
            }
        }
        return result;
    }
    /** Moves a file we created to the Figma trash via the file menu (recoverable from Trash for 30 days). */
    async trashFile(fileKey) {
        const { page, access } = await this.openKey(fileKey);
        if (access !== "edit")
            throw new Error("not editable, refusing to delete");
        await page.bringToFront();
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Edit file menu" }).click({ timeout: 5000 });
        await page.getByRole("menuitem", { name: /^(Delete|Move to trash)/i }).click({ timeout: 5000 });
        // Confirmation dialog, if any.
        const confirm = page.getByRole("dialog").getByRole("button", { name: /^(Delete|Move to trash)/i });
        if (await confirm.isVisible({ timeout: 4000 }).catch(() => false))
            await confirm.click();
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && keyOf(page.url()) === fileKey && !page.isClosed())
            await sleep(500);
        if (!page.isClosed() && keyOf(page.url()) === fileKey)
            throw new Error("file still open after delete; check Figma");
        if (!page.isClosed())
            await page.close().catch(() => { });
        log(`moved ${fileKey} to trash`);
    }
    /** Drives the Figma UI to "Duplicate to your drafts" and returns the new file key. */
    async duplicateToDrafts(page, sourceKey) {
        const ctx = await this.getContext();
        const requests = [];
        const onReq = (r) => {
            if (r.method() !== "GET" && r.url().includes("figma.com/api"))
                requests.push(`${r.method()} ${r.url()}`);
        };
        ctx.on("request", onReq);
        const before = new Set(ctx.pages());
        const waitNewKey = (ms) => new Promise((resolve) => {
            const deadline = Date.now() + ms;
            const tick = () => {
                for (const p of ctx.pages()) {
                    // Only consider our tab or tabs that appeared during this duplication.
                    if (p !== page && before.has(p))
                        continue;
                    const k = keyOf(p.url());
                    if (k && k !== sourceKey) {
                        if (p !== page)
                            void p.close().catch(() => { });
                        return resolve(k);
                    }
                }
                if (Date.now() > deadline)
                    return resolve(null);
                setTimeout(tick, 500);
            };
            tick();
        });
        const DUPLICATE_ITEM = /^Duplicate (file )?to your drafts$/i;
        // Accounts in several teams get "Where do you want your duplicate?" listing each team's drafts.
        const chooseDestination = async () => {
            const prompt = page.getByText("Where do you want your duplicate?");
            try {
                await prompt.waitFor({ timeout: 5000 });
            }
            catch {
                return; // no prompt: duplication already started
            }
            const dialog = page.getByRole("dialog").filter({ hasText: "Where do you want your duplicate?" });
            const names = (await dialog.getByRole("button").allInnerTexts()).map((t) => t.trim()).filter((t) => t && !/^cancel$/i.test(t));
            if (!names.length)
                throw new Error("duplicate dialog has no destinations");
            const wanted = config.duplicateTeam.toLowerCase();
            const pick = (wanted && names.find((n) => n.toLowerCase().includes(wanted))) || names[0];
            log(`duplicate destination: ${pick} (options: ${names.join(" | ")})`);
            await dialog.getByRole("button", { name: pick, exact: true }).click();
        };
        const attempts = [
            ["file-menu", async () => {
                    await page.getByRole("button", { name: "Edit file menu" }).click({ timeout: 5000 });
                    await page.getByRole("menuitem", { name: DUPLICATE_ITEM }).click({ timeout: 5000 });
                    await chooseDestination();
                }],
            ["quick-actions", async () => {
                    await page.keyboard.press("Escape");
                    await page.keyboard.press("Control+/");
                    await sleep(800);
                    await page.keyboard.type("duplicate file to your drafts", { delay: 20 });
                    await sleep(1200);
                    await page.keyboard.press("Enter");
                    await chooseDestination();
                }],
            ["main-menu", async () => {
                    await page.keyboard.press("Escape");
                    await page.getByRole("button", { name: "Main menu" }).click({ timeout: 5000 });
                    await page.getByRole("menuitem", { name: /^File$/ }).hover({ timeout: 5000 });
                    await page.getByRole("menuitem", { name: DUPLICATE_ITEM }).click({ timeout: 5000 });
                    await chooseDestination();
                }],
        ];
        try {
            for (const [name, run] of attempts) {
                try {
                    log(`duplicate attempt: ${name}`);
                    await run();
                    const key = await waitNewKey(20_000);
                    if (key)
                        return key;
                }
                catch (e) {
                    log(`duplicate attempt ${name} failed: ${e.message.split("\n")[0]}`);
                }
            }
            fs.mkdirSync(config.cacheDir, { recursive: true });
            const shot = path.join(config.cacheDir, "duplicate-failure.png");
            await page.screenshot({ path: shot }).catch(() => { });
            throw new Error(`Could not duplicate view-only file ${sourceKey} to drafts automatically (screenshot: ${shot}). ` +
                `The owner may have disabled copying. Duplicate it manually in Figma and pass the copy's URL instead.`);
        }
        finally {
            ctx.off("request", onReq);
            fs.mkdirSync(config.cacheDir, { recursive: true });
            fs.writeFileSync(path.join(config.cacheDir, "duplicate-debug.log"), requests.join("\n"));
        }
    }
    async touchPage(page) {
        markActivity();
        await page.evaluate(() => (window.__fumLastUsed = Date.now())).catch(() => { });
    }
    /** Calls a function from page/helpers.js (installed on demand). */
    async call(page, fn, ...args) {
        await this.touchPage(page);
        if (!this.helpersSource)
            this.helpersSource = fs.readFileSync(config.helpersPath, "utf8");
        const installed = await page.evaluate(() => !!window.__fum);
        if (!installed)
            await page.evaluate(this.helpersSource);
        return page.evaluate(([name, a]) => window.__fum[name](...a), [fn, args]);
    }
    /** Runs arbitrary user code as the body of an async function with `figma` in scope. */
    async execute(page, code) {
        await this.touchPage(page);
        const wrapped = `(async () => { const figma = window.figma; ${code}\n})().then(v => v === undefined ? null : JSON.parse(JSON.stringify(v)))`;
        return page.evaluate(wrapped);
    }
}
