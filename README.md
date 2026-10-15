# figma-unlimited-mcp

MCP server that reads Figma designs through a **headless Chrome** session on figma.com and the
in-page Plugin API (`window.figma`). No Figma Desktop, no REST API, so no 6-calls/month quota.

```
Claude Code ──MCP(stdio)──► node dist/index.js ──Playwright──► Chrome headless (figma.com)
                                                                └─ window.figma.* (Plugin API)
```

## Setup

```powershell
npm install
npm run build
npm run login        # one time: log in to Figma in the window that opens
claude mcp add figma-unlimited -s user -- node C:/laragon/www/figma_unlimited_mcp/dist/index.js
```

The login session is stored in `.profile/` (contains your Figma cookies — never commit or share it).

## How it works

- **One shared Chrome for all sessions.** The first tool call (from any Claude Code session) starts a
  detached headless Chrome with a CDP port on `127.0.0.1:9333`; every MCP server process attaches to
  it. Sessions share tabs, so the same file is loaded once. RAM while open: ~1.5 GB per open file.
- **Closing:** the browser shuts down when no session has called a tool for `FIGMA_IDLE_MS`
  (5 min), or immediately when the last Claude Code session using the server exits.
- Figma's CDN rejects `HeadlessChrome` user agents, so the browser is started with a regular UA.
- `window.figma` only exists for files you can **edit**. For **view-only** files (e.g. team files):
  - **Default: only the requested node is copied.** The server opens the source with `?node-id=`,
    captures Figma's own copy payload (the OS clipboard is not used), and pastes it into one
    *scratch file* in your drafts (one page per source file). The first copy of a node takes
    ~30–60 s; afterwards reads take milliseconds. Child ids returned by the tools can be passed back
    with the original URL. State lives in `.cache/scratch.json`. Unpublished variables are imported
    into the scratch file so their names resolve.
  - `copyWholeFile: true` duplicates the entire file to your drafts instead (needed only for
    page listing / search / tokens of a view-only file).
  - `figma_delete_copy` removes node copies (per node, per source, or all) and moves whole-file
    copies to Figma's trash. The agent decides when to call it (after finishing with a design).
  - Drafts are private to you; copies don't inherit the source file's sharing.

## Tools

| Tool | Purpose |
|---|---|
| `figma_get_file` | Open a file, list pages |
| `figma_get_node` | Compact JSON tree: auto-layout/grid, constraints, fills (gradient angle, image crop), effects, masks, typography (lists, links), variables/styles names, instances, prototype reactions |
| `figma_get_component_states` | All variants (Hover/Pressed/Disabled…) of an instance's component set with property changes vs default |
| `figma_compare` | Visual QA: implementation screenshot vs Figma render → mismatch %, worst regions + layers, side-by-side diff image |
| `figma_screenshot` | Render a node to PNG/JPG (returned as an image) |
| `figma_export` | Export nodes to SVG/PNG/JPG/PDF files |
| `figma_export_images` | Save original bitmap image fills |
| `figma_get_css` | Dev Mode–style CSS for a node |
| `figma_search` | Find nodes by name / text |
| `figma_get_variables` / `figma_get_styles` | Local design tokens and styles |
| `figma_execute` | Run arbitrary Plugin API code |
| `figma_delete_copy` | Delete node copies / whole-file copies made for view-only files |
| `figma_status` / `figma_close` | Inspect / close the browser |

All tools take `url` (Figma URL with optional `?node-id=`, or a bare file key) and an optional `nodeId`.

## Environment variables

| Variable | Default | |
|---|---|---|
| `FIGMA_IDLE_MS` | `300000` | Close the shared browser after no session used it for this long |
| `FIGMA_CDP_PORT` | `9333` | Port of the shared browser (localhost only) |
| `FIGMA_DUPLICATE_TEAM` | first team | Team whose drafts receive copies, if you belong to several |
| `FIGMA_CHROME_PATH` | auto | Browser executable override |
| `FIGMA_HEADLESS` | `true` | `false` to watch the browser (debugging) |
| `FIGMA_BROWSER_CHANNEL` | `chrome` | `chrome`, `msedge` or `chromium` |
| `FIGMA_MAX_TABS` | `3` | Files kept open at once |
| `FIGMA_MAX_JSON_CHARS` | `80000` | `figma_get_node` reduces depth beyond this |
| `FIGMA_PROFILE_DIR` / `FIGMA_CACHE_DIR` | `.profile` / `.cache` | |

## Limitations

- `npm run login` closes the shared browser first (the profile can be used by one Chrome at a time).
- `figma_get_variables` lists **local** variables; library variables still show up by name on nodes.
- Uses the Figma web app in an automated way — this is not an official Figma API; UI changes may
  break the automatic duplication step (it saves `.cache/duplicate-failure.png` when it fails).
- In node-copy mode, prototype links that point outside the copied node are lost (use `copyWholeFile`).
- `spike/` contains the feasibility probes and smoke-test clients used during development.
