import { clock, duration as fmtDuration, megabytes } from "../lib/format";
import type { BurnState } from "../lib/useBurner";
import type { EngineState, Job, PunctState } from "../lib/useTranscriber";

function EngineItem({ engine }: { engine: EngineState }) {
  switch (engine.phase) {
    case "idle":
      return <span className="sb-item">Model ilk dosyada indirilecek</span>;
    case "downloading": {
      const pct = engine.total ? engine.loaded / engine.total : 0;
      return (
        <span className="sb-item" role="status">
          {engine.fromCache ? "Model önbellekten açılıyor" : `Model indiriliyor ${megabytes(engine.loaded)} / ${megabytes(engine.total)} MB`}
          <span className="meter" aria-hidden>
            <span style={{ transform: `scaleX(${pct})` }} />
          </span>
        </span>
      );
    }
    case "compiling":
      return <span className="sb-item">Model hazırlanıyor</span>;
    case "ready":
      return (
        <span className="sb-item" title={engine.gpu ?? engine.fallbackReason ?? undefined}>
          <span className={`dot${engine.provider === "webgpu" ? "" : " dot--cpu"}`} aria-hidden />
          {engine.provider === "webgpu" ? "WebGPU" : "İşlemci (WASM)"}
          {engine.gpu && <span className="sb-dim">{engine.gpu}</span>}
          {engine.provider === "wasm" && engine.fallbackReason && <span className="sb-dim">{engine.fallbackReason}</span>}
        </span>
      );
    case "error":
      return (
        <span className="sb-item sb-item--error" role="alert">
          Model yüklenemedi: {engine.message}
        </span>
      );
  }
}

function JobItem({ job, engine, liveWaiting }: { job: Job | null; engine: EngineState; liveWaiting: boolean }) {
  // The model progress is on the right; the job itself has not started yet.
  if (liveWaiting) return <span className="sb-item" role="status">Model hazır olunca kayıt başlayacak</span>;
  if (!job) return null;
  if (job.status === "running" && !job.live && engine.phase !== "ready" && engine.phase !== "error") {
    return <span className="sb-item" role="status">Model hazır olunca yazıya dökme başlayacak</span>;
  }
  if (job.live && job.status === "running") {
    return (
      <span className="sb-item" role="status">
        {job.recording ? (
          <>
            <span className="rec-dot" aria-hidden /> Dinleniyor, {clock(job.decoded)} yazıya döküldü
          </>
        ) : (
          "Son kelimeler yazılıyor"
        )}
      </span>
    );
  }
  switch (job.status) {
    case "running": {
      const pct = job.duration ? Math.min(99, Math.floor((job.decoded / job.duration) * 100)) : 0;
      return (
        <span className="sb-item" role="status">
          Yazıya dökülüyor %{pct}
          <span className="meter" aria-hidden>
            <span style={{ transform: `scaleX(${pct / 100})` }} />
          </span>
          {job.speed > 0.5 && <span className="sb-dim">{job.speed.toFixed(1)}× hız</span>}
        </span>
      );
    }
    case "done":
      return (
        <span className="sb-item">
          {job.words.length} kelime
          <span className="sb-dim">
            {fmtDuration(job.duration ?? job.decoded)} kayıt, {fmtDuration(job.elapsed ?? 0)} içinde
          </span>
        </span>
      );
    case "cancelled":
      return <span className="sb-item">Durduruldu, {clock(job.decoded)} konumuna kadar yazıya döküldü</span>;
    case "error":
      return (
        <span className="sb-item sb-item--error" role="alert">
          {job.error}
        </span>
      );
  }
}

function PunctItem({ punct }: { punct: PunctState }) {
  if (punct.phase === "idle") return null;
  if (punct.phase === "error") {
    return (
      <span className="sb-item sb-item--error" role="alert">
        Noktalama eklenemedi: {punct.message}
      </span>
    );
  }
  const pct = punct.total ? punct.done / punct.total : 0;
  return (
    <span className="sb-item" role="status">
      {punct.phase === "download"
        ? `Noktalama modeli indiriliyor ${megabytes(punct.done)} / ${megabytes(punct.total)} MB`
        : "Noktalama ekleniyor"}
      <span className="meter" aria-hidden>
        <span style={{ transform: `scaleX(${pct})` }} />
      </span>
    </span>
  );
}

function BurnItem({ burn }: { burn: BurnState }) {
  if (burn.status !== "running") return null;
  return (
    <span className="sb-item" role="status">
      Video oluşturuluyor %{Math.floor(burn.progress * 100)}
      <span className="meter" aria-hidden>
        <span style={{ transform: `scaleX(${burn.progress})` }} />
      </span>
    </span>
  );
}

export function StatusBar({
  engine,
  job,
  burn,
  notice,
  punct,
  liveWaiting,
}: {
  engine: EngineState;
  job: Job | null;
  liveWaiting: boolean;
  burn: BurnState;
  punct: PunctState;
  /** One-off problem to show, e.g. microphone permission denied. */
  notice: string | null;
}) {
  return (
    <footer className="statusbar">
      {notice && (
        <span className="sb-item sb-item--error" role="alert">
          {notice}
        </span>
      )}
      <JobItem job={job} engine={engine} liveWaiting={liveWaiting} />
      <PunctItem punct={punct} />
      <BurnItem burn={burn} />
      <span className="statusbar__spacer" />
      <EngineItem engine={engine} />
    </footer>
  );
}
