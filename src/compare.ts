import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export interface Region {
  /** Region in design pixels (node-relative, scale 1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Share of differing pixels inside the region, 0–100. */
  pct: number;
}

export interface CompareResult {
  designSize: [number, number];
  implSize: [number, number];
  comparedSize: [number, number];
  mismatchPct: number;
  regions: Region[];
  /** Side-by-side PNG: design | implementation | diff (red = different). */
  composite: Buffer;
  diff: Buffer;
}

function crop(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, 0, 0, w, h, 0, 0);
  return out;
}

/** Nearest-neighbour downscale, good enough for a preview. */
function downscale(src: PNG, factor: number): PNG {
  if (factor >= 1) return src;
  const w = Math.max(1, Math.round(src.width * factor));
  const h = Math.max(1, Math.round(src.height * factor));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / factor));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / factor));
      src.data.copy(out.data, (y * w + x) * 4, (sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4);
    }
  }
  return out;
}

/**
 * Compares a design render with a screenshot of the implementation. Both should show the same
 * element; the design is expected to be rendered at the screenshot's pixel width.
 * `designScale` converts compared pixels back to design pixels for the reported regions.
 */
export function comparePngs(designBuf: Buffer, implBuf: Buffer, designScale: number, threshold = 0.1): CompareResult {
  const design = PNG.sync.read(designBuf);
  const impl = PNG.sync.read(implBuf);
  const w = Math.min(design.width, impl.width);
  const h = Math.min(design.height, impl.height);
  const a = crop(design, w, h);
  const b = crop(impl, w, h);
  const diff = new PNG({ width: w, height: h });
  const diffColor: [number, number, number] = [255, 0, 0];
  const count = pixelmatch(a.data, b.data, diff.data, w, h, { threshold, diffColor, aaColor: [255, 210, 0], alpha: 0.2 });

  // Grid of roughly square cells; report the worst ones.
  const cols = 8;
  const cell = Math.max(8, Math.ceil(w / cols));
  const rows = Math.ceil(h / cell);
  const regions: Region[] = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = gx * cell, y0 = gy * cell;
      const x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
      if (x1 <= x0 || y1 <= y0) continue;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) n++;
        }
      }
      const pct = (n / ((x1 - x0) * (y1 - y0))) * 100;
      if (pct >= 1) {
        regions.push({
          x: Math.round(x0 / designScale), y: Math.round(y0 / designScale),
          w: Math.round((x1 - x0) / designScale), h: Math.round((y1 - y0) / designScale),
          pct: Math.round(pct * 10) / 10,
        });
      }
    }
  }
  regions.sort((p, q) => q.pct - p.pct);

  // Composite preview, at most ~1568 px wide.
  const gap = 8;
  const factor = Math.min(1, (1568 - 2 * gap) / (3 * w));
  const [pa, pb, pd] = [a, b, diff].map((p) => downscale(p, factor));
  const comp = new PNG({ width: pa.width * 3 + gap * 2, height: pa.height });
  comp.data.fill(255);
  PNG.bitblt(pa, comp, 0, 0, pa.width, pa.height, 0, 0);
  PNG.bitblt(pb, comp, 0, 0, pb.width, pb.height, pa.width + gap, 0);
  PNG.bitblt(pd, comp, 0, 0, pd.width, pd.height, (pa.width + gap) * 2, 0);

  return {
    designSize: [design.width, design.height],
    implSize: [impl.width, impl.height],
    comparedSize: [w, h],
    mismatchPct: Math.round((count / (w * h)) * 10000) / 100,
    regions: regions.slice(0, 10),
    composite: PNG.sync.write(comp),
    diff: PNG.sync.write(diff),
  };
}

export function pngWidth(buf: Buffer): number {
  // IHDR width lives at byte 16; avoids decoding the whole image.
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") throw new Error("Implementation screenshot must be a PNG file");
  return buf.readUInt32BE(16);
}
