// What of each model is in the browser, and downloading or removing it from settings.
// The workers fill the same cache on first use (worker/modelStore.ts).

import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { PACKS, packFileUrl, type ModelPack } from "../models";
import { complete, fetchManifest, listCached, removeCached, storeFile, type CachedFile, type FileRequest } from "../worker/modelStore";
import { fileSize } from "./format";
import { askPersist } from "./projectStore";

/** The ONNX runtime every model needs; approximate, as in the workers. */
const RUNTIME: FileRequest = { url: new URL(ortWasmUrl, location.href).href, size: 26_800_000, approx: true };

export type PackStatus = "ready" | "update" | "partial" | "none";

export interface PackState {
  pack: ModelPack;
  /** The pack's files and the runtime, with absolute URLs. */
  files: FileRequest[];
  status: PackStatus;
  /** Bytes of every file. */
  total: number;
  /** Bytes of it stored, finished parts of a half-downloaded file included. */
  have: number;
}

export interface Library {
  packs: PackState[];
  /** Stored entries (versions, parts) by URL. */
  stored: Map<string, CachedFile[]>;
  /** Stored files no model uses any more: older versions, an older runtime. */
  stale: CachedFile[];
  /** Everything in the model cache. */
  bytes: number;
  /** Some manifests could not be read (offline): sizes are unknown there. */
  offline: boolean;
}

const manifests = new Map<string, Record<string, number>>();

/** File sizes from the pack's manifest (network or cache), and whether the network could not be reached. */
async function sizesOf(p: ModelPack): Promise<{ files: Record<string, number> | null; offline: boolean }> {
  const url = packFileUrl(p, p.manifest);
  const { data, offline } = await fetchManifest<{ files?: Record<string, number> }>(url);
  if (data?.files) {
    manifests.set(url, data.files);
    return { files: data.files, offline };
  }
  return { files: manifests.get(url) ?? null, offline };
}

/** Cache every model's manifest in the background so sizes and configs are ready offline. */
export function warmManifests(): void {
  void Promise.all(PACKS.map(sizesOf)).catch(() => {});
}

/** A stored entry counts if its size matches; without a known size (runtime, offline) any entry does. */
const matches = (f: FileRequest, c: CachedFile) => f.approx || !f.size || c.size === f.size;

/** How much of a file is stored: all of it, or the bytes of its finished parts. */
function fileState(stored: Map<string, CachedFile[]>, f: FileRequest) {
  const all = stored.get(f.url) ?? [];
  const current = all.filter((c) => matches(f, c));
  const done = complete(current);
  return {
    done,
    have: done ? f.size : current.reduce((a, c) => a + c.bytes, 0),
    present: all.length > 0,
    outdated: all.length > 0 && !current.length,
    current,
  };
}

export async function loadLibrary(): Promise<Library> {
  const [manifestsResult, cached] = await Promise.all([Promise.all(PACKS.map(sizesOf)), listCached()]);
  const sizes = manifestsResult.map((r) => r.files);
  const stored = new Map<string, CachedFile[]>();
  for (const c of cached) stored.set(c.url, [...(stored.get(c.url) ?? []), c]);

  const used = new Set<string>();
  const packs = PACKS.map((pack, i): PackState => {
    const files: FileRequest[] = [
      ...pack.files.map((n) => ({ url: new URL(packFileUrl(pack, n), location.href).href, size: sizes[i]?.[n] ?? 0 })),
      RUNTIME,
    ];
    // Counted on the pack's own files: the shared runtime alone does not make every pack partial.
    let present = 0;
    let outdated = 0;
    let lacking = 0;
    let have = 0;
    files.forEach((f, j) => {
      const st = fileState(stored, f);
      for (const c of st.current) used.add(c.key);
      if (!st.done) lacking++;
      have += st.have;
      if (j === pack.files.length) return;
      if (st.present) present++;
      if (st.outdated) outdated++;
    });
    const status: PackStatus = !lacking
      ? "ready"
      : !present
        ? "none"
        : present === pack.files.length && outdated
          ? "update"
          : "partial";
    return { pack, files, status, total: files.reduce((a, f) => a + f.size, 0), have };
  });

  return {
    packs,
    stored,
    stale: cached.filter((c) => !used.has(c.key)),
    bytes: cached.reduce((a, c) => a + c.bytes, 0),
    offline: navigator.onLine === false || manifestsResult.every((r) => r.offline),
  };
}

/** Cache keys removing this pack frees: files no other pack with something stored still needs. */
export function removalKeys(lib: Library, id: string): string[] {
  const target = lib.packs.find((p) => p.pack.id === id);
  if (!target) return [];
  const needed = new Set(
    lib.packs.filter((p) => p.pack.id !== id && p.status !== "none").flatMap((p) => p.files.map((f) => f.url)),
  );
  return target.files.filter((f) => !needed.has(f.url)).flatMap((f) => (lib.stored.get(f.url) ?? []).map((c) => c.key));
}

/** Bytes a set of cache keys holds. */
export function keyBytes(lib: Library, keys: string[]): number {
  const set = new Set(keys);
  let n = 0;
  for (const copies of lib.stored.values()) for (const c of copies) if (set.has(c.key)) n += c.bytes;
  return n;
}

/** Bytes downloading these packs takes, counting shared files once. */
export function missingBytes(lib: Library, states: PackState[]): number {
  const files = new Map(states.flatMap((s) => s.files.map((f) => [f.url, f] as const)));
  let n = 0;
  for (const f of files.values()) n += f.size - fileState(lib.stored, f).have;
  return n;
}

export const removePack = (lib: Library, id: string) => removeCached(removalKeys(lib, id));

export const clearStale = (lib: Library) => removeCached(lib.stale.map((c) => c.key));

export interface StorageInfo {
  usage: number;
  quota: number;
  /** The browser promised not to evict this site's data. */
  persisted: boolean;
}

export async function storageInfo(): Promise<StorageInfo | null> {
  try {
    const [{ usage = 0, quota = 0 }, persisted] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted?.() ?? false,
    ]);
    return { usage, quota, persisted };
  } catch {
    return null;
  }
}

/**
 * Download the files of these packs that are missing or outdated, one at a
 * time. Shared files (the runtime, Whisper's decoder) are fetched once; a
 * half-downloaded file resumes. Progress counts what is already stored.
 */
export async function downloadPacks(
  states: PackState[],
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const files = new Map(states.flatMap((s) => s.files.map((f) => [f.url, f] as const)));
  // Against the cache as it is now: a worker may have stored some meanwhile.
  const lib = await loadLibrary();
  const all = [...files.values()];
  const need = all.filter((f) => !fileState(lib.stored, f).done);
  const total = all.reduce((a, f) => a + f.size, 0);
  let loaded = all.reduce((a, f) => a + fileState(lib.stored, f).have, 0);

  const info = await storageInfo();
  const want = total - loaded;
  if (info && info.quota && info.quota - info.usage < want * 1.1 + 50_000_000) {
    throw new Error(`Yer yetmiyor: ${fileSize(want)} gerekiyor, tarayıcının ayırdığı alanda ${fileSize(Math.max(0, info.quota - info.usage))} boş.`);
  }

  askPersist();
  onProgress(loaded, total);
  for (const f of need) {
    await storeFile(
      f,
      (n) => {
        loaded += n;
        onProgress(Math.min(loaded, total), total);
      },
      signal,
    );
  }
}

export interface GpuSupport {
  /** Why GPU-only packs cannot run here, or null. */
  gpu: string | null;
  /** Why packs needing 16-bit float shaders cannot run here, or null. */
  f16: string | null;
}

/** What this device can run, checked on the page (the worker checks again before loading). */
export async function gpuSupport(): Promise<GpuSupport> {
  if (!("gpu" in navigator) || !navigator.gpu) {
    const why = "Bu tarayıcı WebGPU desteklemiyor.";
    return { gpu: why, f16: why };
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null);
  if (!adapter) {
    const why = "Uygun bir ekran kartı bulunamadı.";
    return { gpu: why, f16: why };
  }
  return { gpu: null, f16: adapter.features.has("shader-f16") ? null : "Ekran kartı 16 bit hesaplamayı desteklemiyor." };
}

export const unavailable = (p: ModelPack, gpu: GpuSupport) => (p.gpuOnly ? gpu.gpu : null) ?? (p.needsF16 ? gpu.f16 : null);
