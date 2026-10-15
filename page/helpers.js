// Injected into figma.com via page.evaluate(). Runs in the page's main world where
// `window.figma` (the Plugin API) is exposed for files the user can edit.
// Installs `window.__fum` once; re-evaluating is a no-op.
(() => {
  if (window.__fum) return "already-installed";
  const f = window.figma;
  if (!f) throw new Error("window.figma is not available (file not editable?)");
  const MIXED = f.mixed;

  const r2 = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);
  const hex = (c, extraAlpha = 1) => {
    const h = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
    const a = (c.a ?? 1) * extraAlpha;
    return ("#" + h(c.r) + h(c.g) + h(c.b) + (a < 1 ? h(a) : "")).toUpperCase();
  };
  const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined

  // ---------- name caches ----------
  const varCache = new Map();
  async function varName(id) {
    if (!id) return undefined;
    if (!varCache.has(id)) {
      let name = id;
      try {
        const v = await f.variables.getVariableByIdAsync(id);
        if (v) name = v.name;
      } catch {}
      varCache.set(id, name);
    }
    return varCache.get(id);
  }
  const styleCache = new Map();
  async function styleName(id) {
    if (!id || id === MIXED || typeof id !== "string") return undefined;
    if (!styleCache.has(id)) {
      let name;
      try {
        const s = await f.getStyleByIdAsync(id);
        name = s ? s.name : undefined;
      } catch {}
      styleCache.set(id, name);
    }
    return styleCache.get(id);
  }

  // ---------- value formatters ----------
  // gradientTransform maps node space (0..1) to gradient space; invert it to get the handles.
  function gradientGeometry(t, w, h) {
    if (!t) return undefined;
    const [[a, b, c], [d, e, f]] = t;
    const det = a * e - b * d;
    if (!det) return undefined;
    const inv = (x, y) => [(e * (x - c) - b * (y - f)) / det, (-d * (x - c) + a * (y - f)) / det];
    const [x0, y0] = inv(0, 0.5);
    const [x1, y1] = inv(1, 0.5);
    const dx = (x1 - x0) * (w || 1), dy = (y1 - y0) * (h || 1);
    const cssAngle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360; // CSS: 0deg = to top, clockwise
    return { angle: r2(cssAngle), from: [r2(x0), r2(y0)], to: [r2(x1), r2(y1)] };
  }

  async function paint(p, w, h) {
    if (!p || p.visible === false) return null;
    const out = { type: p.type };
    if (p.type === "SOLID") out.color = hex(p.color, p.opacity ?? 1);
    else if (p.type.startsWith("GRADIENT")) {
      out.stops = p.gradientStops.map((s) => ({ pos: r2(s.position), color: hex(s.color) }));
      const g = gradientGeometry(p.gradientTransform, w, h);
      if (g) {
        if (p.type === "GRADIENT_LINEAR") out.angle = g.angle; // CSS linear-gradient(<angle>, …)
        out.handles = { from: g.from, to: g.to }; // normalized 0..1 in the node box
      }
      if (p.opacity !== undefined && p.opacity !== 1) out.opacity = r2(p.opacity);
    } else if (p.type === "IMAGE") {
      out.imageHash = p.imageHash;
      out.scaleMode = p.scaleMode; // FILL=cover, FIT=contain, CROP=imageTransform, TILE=repeat
      if (p.scaleMode === "CROP" && p.imageTransform) out.imageTransform = p.imageTransform.map((r) => r.map(r2));
      if (p.scaleMode === "TILE" && p.scalingFactor) out.tileScale = r2(p.scalingFactor);
      if (p.rotation) out.rotation = p.rotation;
      if (p.filters && Object.values(p.filters).some((v) => v)) out.filters = p.filters;
      if (p.opacity !== undefined && p.opacity !== 1) out.opacity = r2(p.opacity);
    }
    if (p.blendMode && p.blendMode !== "NORMAL") out.blendMode = p.blendMode;
    if (p.boundVariables?.color) out.variable = await varName(p.boundVariables.color.id);
    if (out.type === "SOLID") return out.variable ? { color: out.color, variable: out.variable } : out.color;
    return out;
  }
  async function paints(arr, w, h) {
    if (arr === MIXED) return "mixed";
    if (!arr || !arr.length) return undefined;
    const r = (await Promise.all(arr.map((p) => paint(p, w, h)))).filter(Boolean);
    return r.length ? r : undefined;
  }
  const lineHeight = (lh) =>
    !lh || lh === MIXED ? undefined : lh.unit === "AUTO" ? "auto" : lh.unit === "PERCENT" ? r2(lh.value) + "%" : r2(lh.value);
  const letterSpacing = (ls) =>
    !ls || ls === MIXED || !ls.value ? undefined : ls.unit === "PERCENT" ? r2(ls.value) + "%" : r2(ls.value);

  async function boundVars(node) {
    const bv = node.boundVariables;
    if (!bv) return undefined;
    const out = {};
    for (const [k, v] of Object.entries(bv)) {
      if (k === "fills" || k === "strokes") continue; // reported on the paints themselves
      if (Array.isArray(v)) {
        const names = await Promise.all(v.map((x) => varName(x?.id)));
        out[k] = names.length === 1 ? names[0] : names;
      } else if (v?.id) out[k] = await varName(v.id);
    }
    return Object.keys(out).length ? out : undefined;
  }

  // ---------- prototype interactions ----------
  async function nodeLabel(id) {
    if (!id) return undefined;
    try {
      const n = await f.getNodeByIdAsync(id);
      if (!n) return id;
      if (n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET") return `${n.parent.name} / ${n.name}`;
      return `${n.name} (${n.id})`;
    } catch {
      return id;
    }
  }
  async function reactions(node) {
    if (!("reactions" in node) || !node.reactions?.length) return undefined;
    const out = [];
    for (const r of node.reactions) {
      const acts = r.actions ?? (r.action ? [r.action] : []);
      for (const a of acts) {
        if (!a) continue;
        const item = { on: r.trigger?.type, delayMs: r.trigger?.timeout ? Math.round(r.trigger.timeout * 1000) : r.trigger?.delay || undefined };
        if (a.type === "NODE") {
          item.action = a.navigation; // NAVIGATE | OVERLAY | SWAP | SCROLL_TO | CHANGE_TO (variant swap, e.g. hover state)
          item.to = await nodeLabel(a.destinationId);
          if (a.transition) {
            item.transition = {
              type: a.transition.type,
              ms: a.transition.duration ? Math.round(a.transition.duration * 1000) : undefined,
              easing: a.transition.easing?.type,
              direction: a.transition.direction,
            };
          }
          if (a.navigation === "OVERLAY" && a.destinationId) {
            const dest = await f.getNodeByIdAsync(a.destinationId).catch(() => null);
            if (dest && "overlayPositionType" in dest) {
              item.overlay = { position: dest.overlayPositionType, background: dest.overlayBackground?.type, closeOnClickOutside: dest.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE" };
            }
            if (a.overlayRelativePosition) item.overlay = { ...(item.overlay || {}), offset: a.overlayRelativePosition };
          }
        } else if (a.type === "URL") {
          item.action = "URL";
          item.to = a.url;
        } else item.action = a.type; // BACK, CLOSE, SET_VARIABLE, CONDITIONAL, ...
        out.push(item);
      }
    }
    return out.length ? out : undefined;
  }

  /** Property-level differences between two serialized trees (children matched by position). */
  function diffTrees(a, b, path, isRoot = true) {
    const out = [];
    const skip = new Set(["id", "name", "children", "childCount"]);
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      if (skip.has(k)) continue;
      if (isRoot && (k === "x" || k === "y")) continue; // variant's position inside the set is irrelevant
      const va = a?.[k], vb = b?.[k];
      if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ path, prop: k, from: va, to: vb });
    }
    const ac = a?.children || [], bc = b?.children || [];
    for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
      const ca = ac[i], cb = bc[i];
      const p = `${path} > ${(cb || ca).name}`;
      if (!ca || !cb) out.push({ path: p, prop: "(layer)", from: ca ? "present" : "absent", to: cb ? "present" : "absent" });
      else out.push(...diffTrees(ca, cb, p, false));
    }
    return out;
  }

  const VECTOR_TYPES = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE", "ELLIPSE"]);
  function isIcon(node) {
    if (!("children" in node) || !node.children.length) return false;
    if (node.width > 96 || node.height > 96) return false;
    let leaves = 0;
    const walk = (n) => {
      if ("children" in n && n.type !== "BOOLEAN_OPERATION") {
        for (const c of n.children) if (!walk(c)) return false;
        return true;
      }
      leaves++;
      return VECTOR_TYPES.has(n.type);
    };
    return walk(node) && leaves > 0;
  }

  // ---------- node serializer ----------
  async function ser(node, depth) {
    const o = { id: node.id, name: node.name, type: node.type };
    if (node.visible === false) o.visible = false;
    if ("width" in node && node.type !== "PAGE") {
      o.x = r2(node.x); o.y = r2(node.y); o.w = r2(node.width); o.h = r2(node.height);
      if (node.rotation) o.rotation = r2(node.rotation);
    }
    if ("opacity" in node && node.opacity !== 1) o.opacity = r2(node.opacity);
    if ("blendMode" in node && !["PASS_THROUGH", "NORMAL"].includes(node.blendMode)) o.blendMode = node.blendMode;

    if (node.isMask) o.mask = node.maskType || true; // this layer masks the siblings above it
    if ("fills" in node && node.type !== "PAGE") {
      const v = await paints(node.fills, node.width, node.height);
      if (v) o.fills = v;
      const s = await styleName(node.fillStyleId);
      if (s) o.fillStyle = s;
    }
    if ("strokes" in node) {
      const v = await paints(node.strokes, node.width, node.height);
      if (v) {
        o.strokes = v;
        o.strokeWeight = node.strokeWeight === MIXED
          ? [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight]
          : r2(node.strokeWeight);
        if (node.strokeAlign && node.strokeAlign !== "INSIDE") o.strokeAlign = node.strokeAlign;
        if (node.dashPattern?.length) o.dash = node.dashPattern;
        const s = await styleName(node.strokeStyleId);
        if (s) o.strokeStyle = s;
      }
    }
    if ("cornerRadius" in node) {
      if (node.cornerRadius === MIXED) o.radius = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius].map(r2);
      else if (node.cornerRadius) o.radius = r2(node.cornerRadius);
      if (node.cornerSmoothing) o.cornerSmoothing = r2(node.cornerSmoothing); // squircle corners (iOS-style)
    }
    if ("effects" in node && node.effects?.length) {
      const eff = node.effects.filter((e) => e.visible !== false).map((e) => ({
        type: e.type, color: e.color ? hex(e.color) : undefined,
        x: e.offset?.x, y: e.offset?.y, blur: e.radius, spread: e.spread || undefined,
      }));
      if (eff.length) o.effects = eff;
      const s = await styleName(node.effectStyleId);
      if (s) o.effectStyle = s;
    }
    if ("clipsContent" in node && node.clipsContent && node.type !== "PAGE") o.clips = true;

    if ("layoutMode" in node && node.layoutMode === "GRID") {
      const track = (t) => (t.type === "FIXED" ? r2(t.value) : t.type === "FLEX" ? `${t.value ?? 1}fr` : "auto");
      o.layout = {
        mode: "GRID",
        rows: node.gridRowCount, columns: node.gridColumnCount,
        rowGap: r2(node.gridRowGap), columnGap: r2(node.gridColumnGap),
        padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(r2),
      };
      try {
        o.layout.rowSizes = node.gridRowSizes.map(track);
        o.layout.columnSizes = node.gridColumnSizes.map(track);
      } catch {}
    } else if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
      o.layout = {
        mode: node.layoutMode,
        gap: node.primaryAxisAlignItems === "SPACE_BETWEEN" ? "auto" : r2(node.itemSpacing),
        padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map(r2),
        main: node.primaryAxisAlignItems,
        cross: node.counterAxisAlignItems,
      };
      if (node.layoutWrap === "WRAP") { o.layout.wrap = true; o.layout.crossGap = r2(node.counterAxisSpacing); }
      if (node.itemReverseZIndex) o.layout.reverseZ = true;
    }
    if (node.parent?.layoutMode === "GRID") {
      try {
        o.gridCell = { row: node.gridRowAnchorIndex, column: node.gridColumnAnchorIndex, rowSpan: node.gridRowSpan, columnSpan: node.gridColumnSpan };
      } catch {}
    }
    if ("overflowDirection" in node && node.overflowDirection && node.overflowDirection !== "NONE") o.scroll = node.overflowDirection;
    // Constraints matter only where the parent does not lay children out (no auto-layout, or absolute child).
    const parent = node.parent;
    const freeLayout = parent && ["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(parent.type) &&
      (!parent.layoutMode || parent.layoutMode === "NONE" || node.layoutPositioning === "ABSOLUTE");
    if (freeLayout && "constraints" in node) {
      const c = node.constraints;
      if (c.horizontal !== "MIN" || c.vertical !== "MIN") o.constraints = [c.horizontal, c.vertical];
    }
    try {
      if ("layoutSizingHorizontal" in node) o.sizing = [node.layoutSizingHorizontal, node.layoutSizingVertical];
    } catch {}
    if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") o.absolute = true;
    for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) if (k in node && node[k] != null) o[k] = r2(node[k]);

    if (node.type === "TEXT") {
      o.text = node.characters;
      const base = ["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "fills", "textDecoration", "textCase", "textStyleId"];
      const extra = ["paragraphSpacing", "paragraphIndent", "listOptions", "indentation", "hyperlink"];
      let segs;
      try {
        segs = node.getStyledTextSegments([...base, ...extra]);
      } catch {
        segs = node.getStyledTextSegments(base); // older API without the extra fields
      }
      const out = await Promise.all(segs.map(async (s) => ({
        start: s.start, end: s.end,
        font: s.fontName.family, style: s.fontName.style, weight: s.fontWeight, size: r2(s.fontSize),
        lineHeight: lineHeight(s.lineHeight), letterSpacing: letterSpacing(s.letterSpacing),
        color: await paints(s.fills),
        decoration: s.textDecoration !== "NONE" ? s.textDecoration : undefined,
        case: s.textCase !== "ORIGINAL" ? s.textCase : undefined,
        textStyle: await styleName(s.textStyleId),
        paragraphSpacing: s.paragraphSpacing || undefined,
        paragraphIndent: s.paragraphIndent || undefined,
        list: s.listOptions && s.listOptions.type !== "NONE" ? s.listOptions.type : undefined,
        indent: s.indentation || undefined,
        link: s.hyperlink ? (s.hyperlink.type === "URL" ? s.hyperlink.value : `node:${s.hyperlink.value}`) : undefined,
      })));
      if (out.length === 1) { const { start, end, ...rest } = out[0]; o.font = rest; }
      else o.segments = out;
      o.align = [node.textAlignHorizontal, node.textAlignVertical];
      o.autoResize = node.textAutoResize;
      if (node.textTruncation === "ENDING") o.truncate = node.maxLines ?? true;
    }

    if (node.type === "INSTANCE") {
      try {
        const mc = await node.getMainComponentAsync();
        if (mc) {
          const inSet = mc.parent?.type === "COMPONENT_SET";
          o.component = inSet ? mc.parent.name : mc.name;
          if (inSet) o.variant = mc.name;
        }
      } catch {}
      const props = {};
      for (const [k, v] of Object.entries(node.componentProperties || {})) props[k.replace(/#[\d:]+$/, "")] = v.value;
      if (Object.keys(props).length) o.props = props;
    }
    if ((node.type === "COMPONENT" || node.type === "COMPONENT_SET") && node.description) o.description = node.description;

    const bv = await boundVars(node);
    if (bv) o.vars = bv;
    const rx = await reactions(node);
    if (rx) o.reactions = rx;

    if ("children" in node) {
      if (node.type !== "PAGE" && node.type !== "DOCUMENT" && isIcon(node)) o.icon = true;
      else if (depth > 0) {
        o.children = [];
        for (const c of node.children) o.children.push(await ser(c, depth - 1));
      } else if (node.children.length) o.childCount = node.children.length;
    }
    return o;
  }

  async function resolve(id) {
    if (!id) return f.currentPage;
    const node = await f.getNodeByIdAsync(id);
    if (!node) throw new Error(`Node ${id} not found`);
    if (node.type === "PAGE") await node.loadAsync();
    return node;
  }

  // ---------- public API ----------
  window.__fum = {
    async info() {
      return {
        fileName: f.root.name,
        currentPage: { id: f.currentPage.id, name: f.currentPage.name },
        pages: f.root.children.map((p) => ({ id: p.id, name: p.name })),
      };
    },

    async getNode(id, depth) {
      const node = await resolve(id);
      return clean(await ser(node, depth));
    },

    async exportNode(id, format, scale, maxDim) {
      const node = await resolve(id);
      if (!("exportAsync" in node)) throw new Error(`Node ${node.id} (${node.type}) cannot be exported`);
      const settings = { format };
      if (format === "PNG" || format === "JPG") {
        let s = scale || 1;
        if (maxDim && "width" in node) {
          const longest = Math.max(node.width, node.height) * s;
          if (longest > maxDim) s = s * (maxDim / longest);
        }
        settings.constraint = { type: "SCALE", value: Math.max(0.01, s) };
      }
      if (format === "SVG") settings.svgIdAttribute = false;
      const bytes = await node.exportAsync(settings);
      return { id: node.id, name: node.name, type: node.type, base64: f.base64Encode(bytes) };
    },

    /** All variants of the component set behind an instance/component, each with its diff vs the default variant. */
    async componentStates(id, depth) {
      const node = await resolve(id);
      let set = null, current = null;
      if (node.type === "INSTANCE") current = await node.getMainComponentAsync();
      else if (node.type === "COMPONENT") current = node;
      else if (node.type === "COMPONENT_SET") set = node;
      else throw new Error(`Node ${node.id} is a ${node.type}; pass an INSTANCE, COMPONENT or COMPONENT_SET`);
      if (!set && current?.parent?.type === "COMPONENT_SET") set = current.parent;
      if (!set) {
        return clean({
          component: current?.name,
          note: "Not part of a component set (or the library set is not accessible): no variants to compare.",
          reactions: current ? await reactions(current) : undefined,
        });
      }
      const axes = {};
      for (const [k, v] of Object.entries(set.componentPropertyDefinitions || {})) {
        if (v.type === "VARIANT") axes[k] = v.variantOptions;
        else axes[k.replace(/#[\d:]+$/, "")] = { type: v.type, default: v.defaultValue };
      }
      const def = set.defaultVariant || set.children[0];
      const defTree = await ser(def, depth);
      const variants = [];
      for (const v of set.children) {
        if (v.type !== "COMPONENT") continue;
        const tree = v === def ? defTree : await ser(v, depth);
        variants.push({
          name: v.name,
          id: v.id,
          isDefault: v === def || undefined,
          isCurrent: v === current || undefined,
          reactions: tree.reactions,
          changesFromDefault: v === def ? undefined : diffTrees(defTree, tree, v.name),
        });
      }
      return clean({ componentSet: set.name, remote: set.remote || undefined, axes, default: def.name, current: current?.name, defaultTree: defTree, variants });
    },

    /** For each rect (root-relative px), the deepest visible layers covering its centre. */
    async nodesAt(id, rects) {
      const root = await resolve(id);
      const rb = root.absoluteBoundingBox || { x: root.x, y: root.y };
      const items = [];
      const walk = (n, depth, trail) => {
        if (n.visible === false) return;
        const b = n.absoluteBoundingBox;
        if (b) items.push({ n, depth, trail, x: b.x - rb.x, y: b.y - rb.y, w: b.width, h: b.height });
        if ("children" in n && depth < 30) for (const c of n.children) walk(c, depth + 1, trail.concat(n.name));
      };
      walk(root, 0, []);
      return rects.map((r) => {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const hits = items
          .filter((i) => cx >= i.x && cx <= i.x + i.w && cy >= i.y && cy <= i.y + i.h)
          .sort((a, b) => b.depth - a.depth)
          .slice(0, 3)
          .map((i) => ({ id: i.n.id, name: i.n.name, type: i.n.type, path: i.trail.slice(-3).concat(i.n.name).join(" > ") }));
        return { ...r, layers: hits };
      });
    },

    async css(id) {
      const node = await resolve(id);
      return { id: node.id, name: node.name, css: await node.getCSSAsync() };
    },

    async search(query, types, pageId, limit, searchText) {
      const q = String(query || "").toLowerCase();
      const typeSet = types?.length ? new Set(types) : null;
      const pages = pageId ? [await f.getNodeByIdAsync(pageId)] : f.root.children;
      const results = [];
      for (const page of pages) {
        await page.loadAsync();
        const found = page.findAll((n) => {
          if (typeSet && !typeSet.has(n.type)) return false;
          if (!q) return true;
          if (n.name.toLowerCase().includes(q)) return true;
          return searchText && n.type === "TEXT" && n.characters.toLowerCase().includes(q);
        });
        for (const n of found) {
          results.push({
            id: n.id, name: n.name, type: n.type, page: page.name,
            parent: n.parent && n.parent.type !== "PAGE" ? n.parent.name : undefined,
            w: "width" in n ? r2(n.width) : undefined, h: "height" in n ? r2(n.height) : undefined,
            text: n.type === "TEXT" ? n.characters.slice(0, 80) : undefined,
          });
          if (results.length >= limit) return clean({ results, truncated: true });
        }
      }
      return clean({ results, truncated: false });
    },

    async variables() {
      const collections = await f.variables.getLocalVariableCollectionsAsync();
      const out = [];
      for (const c of collections) {
        const modes = c.modes.map((m) => ({ id: m.modeId, name: m.name }));
        const vars = [];
        for (const id of c.variableIds) {
          const v = await f.variables.getVariableByIdAsync(id);
          if (!v) continue;
          const values = {};
          for (const m of modes) {
            const val = v.valuesByMode[m.id];
            if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") values[m.name] = { alias: await varName(val.id) };
            else if (val && typeof val === "object" && "r" in val) values[m.name] = hex(val);
            else values[m.name] = val;
          }
          vars.push({ name: v.name, type: v.resolvedType, values, description: v.description || undefined, codeSyntax: Object.keys(v.codeSyntax || {}).length ? v.codeSyntax : undefined });
        }
        out.push({ collection: c.name, modes: modes.map((m) => m.name), variables: vars });
      }
      return clean(out);
    },

    async styles() {
      const [paintS, textS, effectS, gridS] = await Promise.all([
        f.getLocalPaintStylesAsync(), f.getLocalTextStylesAsync(),
        f.getLocalEffectStylesAsync(), f.getLocalGridStylesAsync(),
      ]);
      return clean({
        paint: await Promise.all(paintS.map(async (s) => ({ name: s.name, paints: await paints(s.paints), description: s.description || undefined }))),
        text: textS.map((s) => ({
          name: s.name, font: s.fontName.family, style: s.fontName.style, size: s.fontSize,
          lineHeight: lineHeight(s.lineHeight), letterSpacing: letterSpacing(s.letterSpacing),
          case: s.textCase !== "ORIGINAL" ? s.textCase : undefined,
          decoration: s.textDecoration !== "NONE" ? s.textDecoration : undefined,
        })),
        effect: effectS.map((s) => ({ name: s.name, effects: s.effects.map((e) => ({ type: e.type, color: e.color ? hex(e.color) : undefined, x: e.offset?.x, y: e.offset?.y, blur: e.radius, spread: e.spread })) })),
        grid: gridS.map((s) => ({ name: s.name, grids: s.layoutGrids })),
      });
    },

    async imageFills(id) {
      const node = await resolve(id);
      const hashes = new Map();
      const visit = (n) => {
        if ("fills" in n && Array.isArray(n.fills)) {
          for (const p of n.fills) if (p.type === "IMAGE" && p.imageHash && !hashes.has(p.imageHash)) hashes.set(p.imageHash, n.name);
        }
        if ("children" in n) n.children.forEach(visit);
      };
      visit(node);
      const out = [];
      for (const [hash, nodeName] of hashes) {
        const img = f.getImageByHash(hash);
        if (!img) continue;
        out.push({ hash, nodeName, base64: f.base64Encode(await img.getBytesAsync()) });
      }
      return out;
    },
  };
  return "installed";
})();
