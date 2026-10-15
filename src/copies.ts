import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** Persistent map: view-only source file key -> editable copy in the user's drafts. */
export interface CopyEntry {
  copyKey: string;
  sourceName?: string;
  createdAt: string;
}

const file = () => path.join(config.cacheDir, "copies.json");

export function loadCopies(): Record<string, CopyEntry> {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

export function saveCopy(sourceKey: string, entry: CopyEntry) {
  const all = loadCopies();
  all[sourceKey] = entry;
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

export function deleteCopy(sourceKey: string) {
  const all = loadCopies();
  delete all[sourceKey];
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}

// ---- node-level copies: single nodes from view-only files pasted into one scratch file ----

export interface NodeCopy {
  scratchId: string;
  sourceName?: string;
  copiedAt: string;
}
interface ScratchState {
  fileKey?: string;
  /** key: `${sourceKey} ${sourceNodeId}` */
  nodes: Record<string, NodeCopy>;
}

const scratchFile = () => path.join(config.cacheDir, "scratch.json");

export function loadScratch(): ScratchState {
  try {
    return { nodes: {}, ...JSON.parse(fs.readFileSync(scratchFile(), "utf8")) };
  } catch {
    return { nodes: {} };
  }
}

export function updateScratch(fn: (s: ScratchState) => void) {
  const s = loadScratch();
  fn(s);
  fs.mkdirSync(config.cacheDir, { recursive: true });
  fs.writeFileSync(scratchFile(), JSON.stringify(s, null, 2));
}

export const nodeCopyKey = (sourceKey: string, nodeId: string) => `${sourceKey} ${nodeId}`;
