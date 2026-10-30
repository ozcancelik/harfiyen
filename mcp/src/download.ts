// Downloads the models the web app serves from its bucket (scripts/upload_models.py). Each folder has a manifest,
// model.json, that lists its files with their sizes; the files come first and the manifest last, so a folder with
// its manifest is whole. A file is written beside its place as `.part`, resumed after a break, and moved in place
// only when its size is the manifest's.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CANCELLED, signal, throwIfCancelled } from "./jobs";
import { downloadRoot, isReady, UNITS, type Unit } from "./models";
import type { Progress } from "./pipeline";

const DEFAULT_BASE = "https://pub-f6683caf7c8940f089ebbc5928720bc1.r2.dev/models";
const base = () => (process.env.HARFIYEN_MODELS_URL || DEFAULT_BASE).replace(/\/+$/, "");

interface Item {
  url: string;
  path: string;
  size: number;
}

export interface Plan {
  units: Unit[];
  /** Everything still to fetch, the manifests last in each folder. */
  items: Item[];
  bytes: number;
  root: string;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function manifest(unit: Unit): Promise<Record<string, number>> {
  const url = `${base()}/${unit.dir}/${unit.probe}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch((e) => {
    throw new Error(`Model sunucusuna ulaşılamadı (${url}): ${reason(e)}. İnternet bağlantısını kontrol et.`);
  });
  if (!res.ok) throw new Error(`${unit.name} model sunucusunda bulunamadı (${res.status}): ${url}`);
  const files = ((await res.json()) as { files?: Record<string, number> }).files;
  if (!files) throw new Error(`${unit.name} için dosya listesi okunamadı.`);
  return files;
}

const sizeOf = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
};

/** What downloading these units would fetch. Units already on disk are left out. */
export async function plan(ids: string[]): Promise<Plan> {
  const root = downloadRoot();
  const units = [...new Set(ids)].map((id) => UNITS[id]).filter((u) => !isReady(u.id));
  const items: Item[] = [];
  for (const unit of units) {
    const files = await manifest(unit);
    const names = unit.files ?? Object.keys(files);
    for (const n of names) {
      if (!(n in files)) throw new Error(`${unit.name}: ${n} model sunucusundaki listede yok.`);
      const path = join(root, unit.dir, n);
      if (sizeOf(path) !== files[n]) items.push({ url: `${base()}/${unit.dir}/${n}`, path, size: files[n] });
    }
    const path = join(root, unit.dir, unit.probe);
    items.push({ url: `${base()}/${unit.dir}/${unit.probe}`, path, size: -1 });
  }
  return { units, items, bytes: items.reduce((n, i) => n + Math.max(0, i.size), 0), root };
}

const freeBytes = (dir: string) => {
  try {
    mkdirSync(dir, { recursive: true });
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
};

/** One file, resumed from its `.part` if there is one. Throws when the size is not the manifest's. */
async function fetchFile(item: Item, onBytes: (n: number) => void): Promise<void> {
  mkdirSync(dirname(item.path), { recursive: true });
  const part = `${item.path}.part`;
  let have = sizeOf(part);
  if (item.size >= 0 && have > item.size) have = -1;
  if (item.size >= 0 && have === item.size) return void renameSync(part, item.path);
  const res = await fetch(item.url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, signal: signal() });
  if (!res.ok || !res.body) throw new Error(`${item.url} indirilemedi (${res.status}).`);
  const resumed = res.status === 206 && have > 0;
  if (resumed) onBytes(have);
  const out = createWriteStream(part, { flags: resumed ? "a" : "w" });
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (c: Buffer) => onBytes(c.length));
  await pipeline(body, out);
  const got = sizeOf(part);
  if (item.size >= 0 && got !== item.size) throw new Error(`${item.url}: beklenen ${item.size} bayt, gelen ${got}.`);
  renameSync(part, item.path);
}

/** Downloads the plan. The manifest of a folder is its last file, so a break leaves no folder that looks whole. */
export async function download(p: Plan, progress: Progress): Promise<void> {
  const need = p.bytes * 1.1;
  const free = freeBytes(p.root);
  if (free < need) {
    throw new Error(`Diskte yer yok: ${Math.ceil(need / 1e6)} MB gerekiyor, ${Math.floor(free / 1e6)} MB boş (${p.root}).`);
  }
  let done = 0;
  for (const item of p.items) {
    throwIfCancelled();
    const before = done;
    let tries = 0;
    for (;;) {
      done = before;
      try {
        await fetchFile(item, (n) => {
          done += n;
          progress(Math.min(1, done / Math.max(1, p.bytes)), `model indiriliyor (${Math.round(done / 1e6)} / ${Math.round(p.bytes / 1e6)} MB)`);
        });
        break;
      } catch (e) {
        if (signal()?.aborted) throw new Error(CANCELLED);
        if (++tries >= 3) throw new Error(`İndirme yarıda kaldı: ${reason(e)}. Aynı komut tekrar çalıştırılırsa kaldığı yerden devam eder.`);
      }
    }
    if (item.size < 0) done = before;
    if (!existsSync(item.path)) throw new Error(`${item.path} yazılamadı.`);
  }
}
