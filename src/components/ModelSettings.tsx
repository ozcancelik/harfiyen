import { useCallback, useEffect, useRef, useState } from "react";
import type { PackKind } from "../models";
import { fileSize } from "../lib/format";
import {
  clearStale,
  downloadPacks,
  gpuSupport,
  keyBytes,
  loadLibrary,
  missingBytes,
  removalKeys,
  removePack,
  storageInfo,
  unavailable,
  type GpuSupport,
  type Library,
  type PackState,
  type StorageInfo,
} from "../lib/modelLibrary";
import { IconDownload, IconTrash } from "./icons";
import { Button, Hint } from "./ui";

// Settings → Modeller: what is downloaded, download or remove a model, free space.

const GROUPS: { title: string; kinds: PackKind[] }[] = [
  { title: "Yazıya dökme", kinds: ["asr"] },
  { title: "Noktalama ve çeviri", kinds: ["punct", "mt"] },
  { title: "Konuşmacılar", kinds: ["speakers"] },
  { title: "Seslendirme", kinds: ["tts"] },
];

interface Download {
  ids: string[];
  /** "Hepsini indir": progress shows once, above the list. */
  all: boolean;
  loaded: number;
  total: number;
}

/** `active` while the settings are open: the list is read again each time. */
export function ModelSettings({ active }: { active: boolean }) {
  const [lib, setLib] = useState<Library | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [gpu, setGpu] = useState<GpuSupport | null>(null);
  const [download, setDownload] = useState<Download | null>(null);
  /** The pack being removed, or "stale" for the old files. */
  const [removing, setRemoving] = useState<string | null>(null);
  /** The pack whose Sil asks for confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const [l, s] = await Promise.all([loadLibrary(), storageInfo()]);
    setLib(l);
    setStorage(s);
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    if (!gpu) void gpuSupport().then(setGpu);
  }, [active, refresh, gpu]);

  const start = async (states: PackState[], all = false) => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setError(null);
    setDownload({ ids: states.map((s) => s.pack.id), all, loaded: 0, total: 0 });
    try {
      await downloadPacks(states, (loaded, total) => setDownload((d) => d && { ...d, loaded, total }), ctrl.signal);
    } catch (e) {
      if (!ctrl.signal.aborted)
        setError(
          // fetch's own failure: the connection dropped.
          e instanceof TypeError
            ? "Bağlantı kesildi. Yeniden indirince kaldığı yerden devam eder."
            : e instanceof Error
              ? e.message
              : String(e),
        );
    } finally {
      abort.current = null;
      setDownload(null);
      await refresh();
    }
  };

  const remove = async (what: string, action: () => Promise<void>) => {
    setConfirming(null);
    setRemoving(what);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
      await refresh();
    }
  };

  if (!lib || !gpu) return <Hint>Modeller okunuyor…</Hint>;

  const busy = !!download || !!removing;
  const available = lib.packs.filter((s) => !unavailable(s.pack, gpu));
  const toGet = available.filter((s) => s.status !== "ready");
  const toGetBytes = missingBytes(lib, toGet);
  const staleBytes = lib.stale.reduce((a, c) => a + c.bytes, 0);

  return (
    <div className="grid gap-5">
      <div className="grid gap-3 rounded-[10px] border border-line-soft bg-pane-2 p-3.5">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <Stat label="Modeller" value={fileSize(lib.bytes)} />
          {storage && <Stat label="Sitenin toplam kullanımı" value={fileSize(storage.usage)} />}
          {storage && !!storage.quota && <Stat label="Tarayıcının ayırdığı alan" value={fileSize(storage.quota)} />}
        </div>
        {storage && (
          <Hint>
            {storage.persisted
              ? "Kalıcı depolama açık: tarayıcı yer daraldığında bu siteyi kendiliğinden temizlemez."
              : "Kalıcı depolama kapalı: disk dolarsa tarayıcı bu sitenin verilerini silebilir. Bir model indirildiğinde kalıcılık istenir."}
          </Hint>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || !toGet.length || lib.offline} onClick={() => start(toGet, true)}>
            <IconDownload size={14} />
            {toGet.length ? `Uygun olanların hepsini indir (${fileSize(toGetBytes)})` : "Bu cihaza uygun modellerin hepsi indirildi"}
          </Button>
          {lib.stale.length > 0 && (
            <Button disabled={busy} onClick={() => remove("stale", () => clearStale(lib))}>
              {removing === "stale" ? <Spinner /> : null}
              {removing === "stale" ? "Temizleniyor…" : `Eski dosyaları temizle (${fileSize(staleBytes)})`}
            </Button>
          )}
        </div>
        {download?.all && <Progress download={download} onCancel={() => abort.current?.abort()} />}
        {lib.offline && (
          <Hint>
            Çevrimdışı görünüyorsun (sunucuya ulaşılamadı); şu an yeni model indirilemez ama &ldquo;İndirildi&rdquo; olanlar internet
            olmadan çalışır.
          </Hint>
        )}
        {error && <p className="m-0 text-[12px] text-mercan">{error}</p>}
      </div>

      {GROUPS.map((g) => (
        <section key={g.title} className="grid gap-1.5">
          <h3 className="m-0 text-[11px] font-semibold tracking-[0.05em] text-fg-3 uppercase">{g.title}</h3>
          <div className="grid divide-y divide-line-soft rounded-[10px] border border-line-soft">
            {lib.packs
              .filter((s) => g.kinds.includes(s.pack.kind))
              .map((s) => (
                <PackRow
                  key={s.pack.id}
                  state={s}
                  why={unavailable(s.pack, gpu)}
                  freed={keyBytes(lib, removalKeys(lib, s.pack.id))}
                  download={download && !download.all && download.ids.includes(s.pack.id) ? download : null}
                  busy={busy}
                  offline={lib.offline}
                  onDownload={() => start([s])}
                  onCancel={() => abort.current?.abort()}
                  confirming={confirming === s.pack.id}
                  removing={removing === s.pack.id}
                  onAskRemove={() => setConfirming(s.pack.id)}
                  onKeep={() => setConfirming(null)}
                  onRemove={() => remove(s.pack.id, () => removePack(lib, s.pack.id))}
                />
              ))}
          </div>
        </section>
      ))}

      <Hint>
        Modeller tarayıcının bu siteye ayırdığı alanda (Cache Storage) tutulur; ilk kullanımda kendiliğinden de iner.
        Tarayıcı ayarlarından site verilerini silmek projeleri de siler; yalnızca modellerden yer açmak için buradan silin.
      </Hint>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <span className="text-[12px] text-fg-3">
    {label} <span className="text-[13px] font-medium text-fg tabular-nums">{value}</span>
  </span>
);

const STATUS: Record<PackState["status"], { label: string; tone: string }> = {
  ready: { label: "İndirildi", tone: "text-firuze" },
  update: { label: "Yeni sürümü var", tone: "text-wave-played" },
  partial: { label: "Kısmen indirildi", tone: "text-wave-played" },
  none: { label: "İndirilmedi", tone: "text-fg-3" },
};

const ACTION: Record<Exclude<PackState["status"], "ready">, string> = {
  update: "Güncelle",
  partial: "Devam et",
  none: "İndir",
};

function PackRow({
  state,
  why,
  freed,
  download,
  busy,
  offline,
  onDownload,
  onCancel,
  confirming,
  removing,
  onAskRemove,
  onKeep,
  onRemove,
}: {
  state: PackState;
  /** Why it cannot run on this device, if it cannot. */
  why: string | null;
  /** Bytes removing it frees. */
  freed: number;
  download: Download | null;
  busy: boolean;
  offline: boolean;
  onDownload: () => void;
  onCancel: () => void;
  /** Sil was pressed: ask in the row before removing. */
  confirming: boolean;
  removing: boolean;
  onAskRemove: () => void;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const { pack, status } = state;
  const st = STATUS[status];

  return (
    <div className="grid gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="grid min-w-[200px] flex-1 gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-fg">{pack.name}</span>
            <span className="text-[11.5px] text-fg-3 tabular-nums">
              {status === "partial" ? `${fileSize(state.have)} / ${fileSize(state.total)}` : fileSize(state.total)}
            </span>
            <span className={`text-[11.5px] ${st.tone}`}>{st.label}</span>
          </span>
          <span className={`text-[12px] leading-normal ${why ? "text-mercan" : "text-fg-3"}`}>{why ?? pack.note}</span>
        </div>
        {download ? (
          <Button onClick={onCancel}>Durdur</Button>
        ) : removing ? (
          <Button disabled>
            <Spinner /> Siliniyor…
          </Button>
        ) : confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-fg-2">
              {freed ? `${fileSize(freed)} yer açılır.` : "Dosyalarını başka modeller de kullanıyor."} Silinsin mi?
            </span>
            <Button onClick={onKeep}>Vazgeç</Button>
            <Button variant="danger" onClick={onRemove}>
              <IconTrash size={14} /> Sil
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            {status !== "ready" && (
              <Button disabled={busy || !!why || offline} onClick={onDownload}>
                <IconDownload size={14} /> {ACTION[status]}
              </Button>
            )}
            {status !== "none" && (
              <Button disabled={busy} onClick={onAskRemove}>
                <IconTrash size={14} /> Sil
              </Button>
            )}
          </div>
        )}
      </div>
      {download && <Progress download={download} />}
    </div>
  );
}

const Spinner = () => (
  <span
    aria-hidden
    className="inline-block size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent motion-reduce:animate-none"
  />
);

function Progress({ download, onCancel }: { download: Download; onCancel?: () => void }) {
  const pct = download.total ? Math.round((download.loaded / download.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2.5 text-[12px] text-fg-2">
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-cini transition-[width] duration-150" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums">
        {fileSize(download.loaded)} / {fileSize(download.total)}
      </span>
      {onCancel && <Button onClick={onCancel}>Durdur</Button>}
    </div>
  );
}
