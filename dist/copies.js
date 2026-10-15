import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
const file = () => path.join(config.cacheDir, "copies.json");
export function loadCopies() {
    try {
        return JSON.parse(fs.readFileSync(file(), "utf8"));
    }
    catch {
        return {};
    }
}
export function saveCopy(sourceKey, entry) {
    const all = loadCopies();
    all[sourceKey] = entry;
    fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}
export function deleteCopy(sourceKey) {
    const all = loadCopies();
    delete all[sourceKey];
    fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(all, null, 2));
}
const scratchFile = () => path.join(config.cacheDir, "scratch.json");
export function loadScratch() {
    try {
        return { nodes: {}, ...JSON.parse(fs.readFileSync(scratchFile(), "utf8")) };
    }
    catch {
        return { nodes: {} };
    }
}
export function updateScratch(fn) {
    const s = loadScratch();
    fn(s);
    fs.mkdirSync(config.cacheDir, { recursive: true });
    fs.writeFileSync(scratchFile(), JSON.stringify(s, null, 2));
}
export const nodeCopyKey = (sourceKey, nodeId) => `${sourceKey} ${nodeId}`;
