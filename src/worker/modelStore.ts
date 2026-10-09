// Downloads model files once and keeps them in the Cache API, so later visits
// (and offline use) never touch the network.

const CACHE_NAME = "seda-models-v1";

export interface FileRequest {
  url: string;
  /** Expected size, for progress before the response headers arrive. */
  size: number;
}

export type Progress = (loaded: number, total: number, fromCache: boolean) => void;

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  } catch {
    return null; // e.g. insecure context or storage disabled
  }
}

async function readWithProgress(res: Response, onChunk: (n: number) => void): Promise<Uint8Array> {
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    onChunk(b.length);
    return b;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Fetch all files, reporting combined progress. Results keep the input order. */
export async function fetchAll(files: FileRequest[], onProgress: Progress): Promise<Uint8Array[]> {
  const cache = await openCache();
  const total = files.reduce((a, f) => a + f.size, 0);
  let loaded = 0;
  let allCached = true;

  const results = await Promise.all(
    files.map(async (f) => {
      const key = `${f.url}?size=${f.size}`;
      const hit = cache ? await cache.match(key) : undefined;
      if (hit) {
        const b = new Uint8Array(await hit.arrayBuffer());
        loaded += f.size;
        onProgress(loaded, total, allCached);
        return b;
      }
      allCached = false;
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
      let got = 0;
      const b = await readWithProgress(res, (n) => {
        got += n;
        loaded += n;
        onProgress(Math.min(loaded, total), total, false);
      });
      // Some servers report a different size (compression); settle the count.
      loaded += f.size - got;
      if (cache) {
        try {
          // Drop older versions of this file before storing the new one.
          for (const req of await cache.keys()) {
            if (req.url.startsWith(new URL(f.url, location.href).href + "?")) await cache.delete(req);
          }
          await cache.put(key, new Response(b as Uint8Array<ArrayBuffer>));
        } catch {
          // Quota exceeded: still usable for this session.
        }
      }
      return b;
    }),
  );
  onProgress(total, total, allCached);
  return results;
}
