// Downloads model files once and keeps them in the Cache API, so later visits
// (and offline use) never touch the network.
//
// Every file is checked before use, from the cache or the network: its size
// against model.json, and an .onnx file's first byte. A bad cached copy (a
// download cut short, a browser that stored the stream wrongly) is dropped
// and fetched again; a bad download is retried once, bypassing the HTTP cache.
//
// Files over PART are stored in parts of that size (`?size=N&part=i`), each
// as soon as it arrives, so a download cut short resumes at its first missing
// part with a Range request. Smaller files, and those stored whole before
// parts existed, are one entry (`?size=N`).

const CACHE_NAME = "seda-models-v1";

/** Files larger than this are stored in parts of this size. */
const PART = 32 * 1024 * 1024;

export interface FileRequest {
  url: string;
  /** Exact size, checked once downloaded; also gives progress before the response headers arrive. */
  size: number;
  /** The size is only an estimate (the wasm runtime): not checked. */
  approx?: boolean;
}

export type Progress = (loaded: number, total: number, fromCache: boolean) => void;

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  } catch {
    return null; // e.g. insecure context or storage disabled
  }
}

const cacheKey = (f: FileRequest) => `${f.url}?size=${f.size}`;
const isParted = (f: FileRequest) => !f.approx && f.size > PART;
const partCount = (size: number) => Math.ceil(size / PART);
const partKey = (f: FileRequest, i: number) => `${cacheKey(f)}&part=${i}`;
const partLength = (size: number, i: number) => Math.min(PART, size - i * PART);

/** A cache entry: the file's address without the query, the file size it was stored under and, for a parted file, which part. */
export interface CachedFile {
  url: string;
  size: number;
  part: number | null;
  /** Bytes this entry holds. */
  bytes: number;
  /** The cache key, to delete it by. */
  key: string;
}

function parseKey(key: string): CachedFile {
  const u = new URL(key);
  const size = Number(u.searchParams.get("size")) || 0;
  const p = u.searchParams.get("part");
  const part = p === null ? null : Number(p);
  u.search = "";
  return { url: u.href, size, part, bytes: part === null ? size : partLength(size, part), key };
}

/** True if these entries of one file hold all of it: one whole entry, or every part of one version. */
export function complete(entries: CachedFile[]): boolean {
  const parts = new Map<number, Set<number>>();
  for (const e of entries) {
    if (e.part === null) return true;
    parts.set(e.size, (parts.get(e.size) ?? new Set()).add(e.part));
  }
  for (const [size, got] of parts) if (got.size === partCount(size)) return true;
  return false;
}

/** Every stored entry of this file, in any version. */
async function entriesOf(cache: Cache, f: FileRequest): Promise<CachedFile[]> {
  return (await cache.keys(new URL(f.url, location.href).href, { ignoreSearch: true }))
    .map((r) => parseKey(r.url))
    .filter((c) => c.size > 0);
}

async function dropAll(cache: Cache, f: FileRequest) {
  for (const e of await entriesOf(cache, f)) await cache.delete(e.key);
}

/** True if every file is in the cache, in any version (works on the page too). */
export async function allCached(urls: string[]): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  for (const url of urls) if (!complete(await entriesOf(cache, { url, size: 0 }))) return false;
  return true;
}

/**
 * Read a body into one buffer. With the expected size the buffer is
 * allocated once, so a 1.3 GB model does not need twice its size in memory.
 */
async function readWithProgress(res: Response, expected: number, onChunk: (n: number) => void): Promise<Uint8Array> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    onChunk(b.length);
    return b;
  }
  const reader = res.body.getReader();
  let out = new Uint8Array(expected);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > out.length) {
      const next = new Uint8Array(Math.max(out.length * 2, size + value.length));
      next.set(out.subarray(0, size));
      out = next;
    }
    out.set(value, size);
    size += value.length;
    onChunk(value.length);
  }
  return size === out.length ? out : out.slice(0, size);
}

/** Why a file of this size and first byte is not the expected one, or null when it looks right. */
function problem(f: FileRequest, size: number, first: number | undefined): string | null {
  if (!f.approx && size !== f.size) return `${size} bayt geldi, ${f.size} bekleniyordu`;
  // An ONNX model is a protobuf that starts with its IR version (field 1, varint): 0x08.
  if (new URL(f.url, location.href).pathname.endsWith(".onnx") && first !== 0x08)
    return first === 0x3c ? "model yerine bir web sayfası geldi" : "dosya bir ONNX modeli değil";
  return null;
}

const bytesProblem = (f: FileRequest, b: Uint8Array) => problem(f, b.length, b[0]);

/** Drop the stored versions of this file of another size. */
async function dropVersions(cache: Cache, f: FileRequest) {
  for (const e of await entriesOf(cache, f)) if (e.size !== f.size) await cache.delete(e.key);
}

const fileName = (f: FileRequest) => new URL(f.url, location.href).pathname.split("/").pop();

/** The file is not what was expected: its parts are dropped and it is fetched again. */
class BadFile extends Error {}

const isQuota = (e: unknown) => e instanceof DOMException && e.name === "QuotaExceededError";

const OFFLINE_ERR =
  "İnternet bağlantısı yok (veya sunucuya ulaşılamıyor) ve bu model henüz indirilmemiş. Modeller bir kez indirildikten sonra çevrimdışı çalışır.";

async function netFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof TypeError) throw new Error(OFFLINE_ERR);
    throw e;
  }
}

/**
 * Read a model's JSON manifest: from the network when reachable (updating the
 * cached copy), or from the cache when offline.
 */
export async function fetchManifest<T = unknown>(url: string): Promise<{ data: T | null; offline: boolean }> {
  const full = new URL(url, location.href).href;
  const cache = await openCache();
  let offline = false;
  try {
    const res = await fetch(full, { cache: "no-cache" });
    if (res.ok) {
      const clone = res.clone();
      const data = (await res.json()) as T;
      await cache?.put(full, clone).catch(() => {});
      return { data, offline: false };
    }
  } catch {
    // Network unreachable: fall back to the cached copy below.
    offline = true;
  }
  const pathname = new URL(full).pathname;
  const hit =
    (await cache?.match(full)) ??
    (typeof caches !== "undefined" ? ((await caches.match(full)) ?? (await caches.match(pathname))) : undefined);
  if (!hit) return { data: null, offline };
  try {
    return { data: (await hit.json()) as T, offline };
  } catch {
    return { data: null, offline };
  }
}

async function put(cache: Cache, key: string, body: BodyInit) {
  try {
    await cache.put(key, new Response(body));
  } catch (e) {
    if (isQuota(e)) throw new Error("Tarayıcıda yer kalmadı.");
    throw e;
  }
}

/**
 * A parted file: the parts already stored are kept (and read into `out`),
 * and one request from the first missing part fetches the rest, storing each
 * part as it completes. Returns true if anything came from the network.
 * `onBytes` counts new bytes, and stored ones too with `countStored`.
 */
async function fetchParted(
  cache: Cache,
  f: FileRequest,
  onBytes: (n: number) => void,
  o: { reload: boolean; countStored: boolean; out?: Uint8Array; signal?: AbortSignal },
): Promise<boolean> {
  const n = partCount(f.size);
  const have = new Set<number>();
  for (const e of await entriesOf(cache, f)) {
    // Another version, or this one stored whole and found bad by the caller.
    if (e.size !== f.size || e.part === null) await cache.delete(e.key);
    else have.add(e.part);
  }
  if (o.out) {
    for (const i of [...have]) {
      const hit = await cache.match(partKey(f, i));
      const b = hit && new Uint8Array(await hit.arrayBuffer());
      if (b?.length === partLength(f.size, i)) o.out.set(b, i * PART);
      else {
        await cache.delete(partKey(f, i));
        have.delete(i);
      }
    }
  }
  if (o.countStored) for (const i of have) onBytes(partLength(f.size, i));

  let i = 0;
  while (i < n && have.has(i)) i++;
  if (i === n) return false;

  const start = i * PART;
  const res = await netFetch(f.url, {
    signal: o.signal,
    cache: o.reload ? "reload" : undefined,
    headers: start ? { Range: `bytes=${start}-` } : undefined,
  });
  if (!res.ok || !res.body) throw new Error(`${fileName(f)}: HTTP ${res.status}`);
  // A server that ignores Range sends the whole file: skip what is stored.
  let skip = start && res.status !== 206 ? start : 0;
  let part = new Uint8Array(partLength(f.size, i));
  let fill = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let off = Math.min(skip, value.length);
      skip -= off;
      while (off < value.length) {
        if (i === n) throw new BadFile(`${f.size} bayttan uzun geldi`);
        const take = Math.min(part.length - fill, value.length - off);
        part.set(value.subarray(off, off + take), fill);
        fill += take;
        off += take;
        if (!have.has(i)) onBytes(take);
        if (fill < part.length) continue;
        if (i === 0) {
          const why = problem({ ...f, approx: true }, f.size, part[0]);
          if (why) throw new BadFile(why);
        }
        o.out?.set(part, i * PART);
        if (!have.has(i)) await put(cache, partKey(f, i), part);
        have.add(i);
        if (++i < n) {
          part = new Uint8Array(partLength(f.size, i));
          fill = 0;
        }
      }
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  // Cut short: the stored parts stay, the next try resumes after them.
  if (i < n) throw new Error(`${fileName(f)} yarıda kesildi; yeniden denenince kaldığı yerden devam eder.`);
  return true;
}

/** fetchParted, and once more past the HTTP cache if the file is bad. `onBytes` may go negative on a retry. */
async function fetchPartedChecked(
  cache: Cache,
  f: FileRequest,
  onBytes: (n: number) => void,
  o: { countStored: boolean; out?: Uint8Array; signal?: AbortSignal },
): Promise<boolean> {
  let counted = 0;
  const count = (n: number) => {
    counted += n;
    onBytes(n);
  };
  for (const reload of [false, true]) {
    try {
      const fetched = await fetchParted(cache, f, count, { ...o, reload });
      const why = o.out && problem(f, o.out.length, o.out[0]);
      if (why) throw new BadFile(why);
      return fetched;
    } catch (e) {
      if (!(e instanceof BadFile)) throw e;
      await dropAll(cache, f);
      onBytes(-counted);
      counted = 0;
      if (reload) throw new Error(`${fileName(f)} indirilemedi: ${e.message}.`);
    }
  }
  return true;
}

/** Fetch all files, reporting combined progress. Results keep the input order. */
export async function fetchAll(files: FileRequest[], onProgress: Progress): Promise<Uint8Array[]> {
  const cache = await openCache();
  const total = files.reduce((a, f) => a + f.size, 0);
  let loaded = 0;
  let allCached = true;

  async function download(f: FileRequest, key: string, reload: boolean): Promise<Uint8Array> {
    const res = await netFetch(f.url, reload ? { cache: "reload" } : undefined);
    if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
    // The cache gets its own copy of the stream instead of the finished buffer.
    let body = res;
    let stored: Promise<void> = Promise.resolve();
    if (cache && res.body) {
      const [mine, theirs] = res.body.tee();
      body = new Response(mine);
      stored = (async () => {
        // Drop older versions of this file before storing the new one.
        await dropVersions(cache, f);
        await cache.put(key, new Response(theirs));
      })().catch(() => {
        // Quota exceeded: still usable for this session. Stop the copy
        // from buffering the rest of the download.
        theirs.cancel().catch(() => {});
      });
    }
    let got = 0;
    const b = await readWithProgress(body, f.size, (n) => {
      got += n;
      loaded += n;
      onProgress(Math.min(loaded, total), total, false);
    });
    // Some servers report a different size (compression); settle the count.
    loaded += f.size - got;
    await stored;
    return b;
  }

  const results = await Promise.all(
    files.map(async (f) => {
      const key = cacheKey(f);
      const hit = cache ? await cache.match(key) : undefined;
      if (hit) {
        const b = new Uint8Array(await hit.arrayBuffer());
        if (!bytesProblem(f, b)) {
          loaded += f.size;
          onProgress(loaded, total, allCached);
          return b;
        }
        await cache!.delete(key);
      }
      if (cache && isParted(f)) {
        if (!complete(await entriesOf(cache, f))) allCached = false;
        const out = new Uint8Array(f.size);
        await fetchPartedChecked(cache, f, (n) => {
          loaded += n;
          onProgress(Math.min(Math.max(loaded, 0), total), total, allCached);
        }, { countStored: true, out });
        return out;
      }
      allCached = false;
      let b = await download(f, key, false);
      let why = bytesProblem(f, b);
      if (why) {
        // Once more, past the browser's HTTP cache, which may hold the same bad copy.
        await cache?.delete(key);
        loaded -= f.size;
        b = await download(f, key, true);
        why = bytesProblem(f, b);
      }
      if (why) {
        await cache?.delete(key);
        throw new Error(`${fileName(f)} indirilemedi: ${why}.`);
      }
      return b;
    }),
  );
  onProgress(total, total, allCached);
  return results;
}

// ---- managed from the page (settings) ----

export async function listCached(): Promise<CachedFile[]> {
  const cache = await openCache();
  if (!cache) return [];
  return (await cache.keys()).map((req) => parseKey(req.url)).filter((c) => c.size > 0);
}

export async function removeCached(keys: string[]): Promise<void> {
  const cache = await openCache();
  if (cache) for (const k of keys) await cache.delete(k);
}

/**
 * Download one file straight into the cache, for later use: unlike fetchAll
 * it never holds the whole file in memory, and a parted file resumes where
 * it stopped. Checked like fetchAll's files, retried once past the HTTP
 * cache. `onBytes` counts new bytes only, and may go negative on a retry.
 */
export async function storeFile(f: FileRequest, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
  const cache = await openCache();
  if (!cache) throw new Error("Bu tarayıcı dosya saklamaya izin vermiyor.");
  if (isParted(f)) {
    await fetchPartedChecked(cache, f, onBytes, { countStored: false, signal });
    return;
  }
  const key = cacheKey(f);
  for (const reload of [false, true]) {
    const res = await netFetch(f.url, { signal, ...(reload && { cache: "reload" as const }) });
    if (!res.ok || !res.body) throw new Error(`${fileName(f)}: HTTP ${res.status}`);
    let size = 0;
    let first: number | undefined;
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, out) {
          first ??= chunk[0];
          size += chunk.length;
          onBytes(chunk.length);
          out.enqueue(chunk);
        },
      }),
      { signal },
    );
    await dropVersions(cache, f);
    await put(cache, key, counted);
    const why = problem(f, size, first);
    if (!why) return;
    await cache.delete(key);
    onBytes(-size);
    if (reload) throw new Error(`${fileName(f)} indirilemedi: ${why}.`);
  }
}
