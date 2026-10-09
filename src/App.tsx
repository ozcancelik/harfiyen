import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SETTINGS, presetById, type CaptionSettings } from "./captions/style";
import { ExportMenu } from "./components/ExportMenu";
import { IconMic, IconMuted, IconOpen, IconPause, IconPlay, IconSound, IconUndo } from "./components/icons";
import { RecordButton } from "./components/RecordButton";
import { Inspector } from "./components/Inspector";
import { StatusBar } from "./components/StatusBar";
import { Timeline } from "./components/Timeline";
import { Transcript } from "./components/Transcript";
import { Viewer } from "./components/Viewer";
import type { DecodeOptions, DecodingMethod, Word } from "./engine";
import { buildCues } from "./lib/cues";
import { replaceRange } from "./lib/edit";
import { plainWord } from "./punct/turkish";
import { clock } from "./lib/format";
import { useBurner } from "./lib/useBurner";
import { usePlayer } from "./lib/usePlayer";
import { useTranscriber } from "./lib/useTranscriber";

const EMPTY_BANDS = new Float32Array(0);
const ACCEPT = "audio/*,video/*,.mkv,.mov,.m4a,.flac,.ogg,.opus";

const optionsFor = (method: DecodingMethod): DecodeOptions => ({
  method,
  maxActivePaths: 4,
  lmScale: 0.6,
  lodrScale: -0.5,
});

/** Open the model right away when it is already in the cache. */
async function modelIsCached() {
  try {
    const c = await caches.open("seda-models-v1");
    return (await c.keys()).length >= 7;
  } catch {
    return false;
  }
}

function loadSettings(): CaptionSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("harfiyen.captions") ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function baseName(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function App() {
  const { engine, job, prepare, start, startLive, stopLive, cancel, setWords, liveLevels, liveMeter, punctuate, punct } =
    useTranscriber();
  const [autoPunct, setAutoPunct] = useState(() => localStorage.getItem("harfiyen.punct") !== "off");
  useEffect(() => localStorage.setItem("harfiyen.punct", autoPunct ? "on" : "off"), [autoPunct]);
  const [notice, setNotice] = useState<string | null>(null);
  const [method, setMethod] = useState<DecodingMethod>("beam-lm");
  const [settings, setSettings] = useState<CaptionSettings>(loadSettings);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const burner = useBurner();
  const player = usePlayer(job?.file ?? null);

  useEffect(() => localStorage.setItem("harfiyen.captions", JSON.stringify(settings)), [settings]);
  useEffect(() => {
    modelIsCached().then((yes) => yes && prepare());
  }, [prepare]);

  const resetBurn = burner.reset;
  const openFile = useCallback(
    (f: File) => {
      resetBurn();
      start(f, optionsFor(method));
    },
    [start, method, resetBurn],
  );

  // The whole window is a drop target.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer!.files[0];
      if (f) openFile(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [openFile]);

  const words = job?.words ?? [];
  const liveWords = useMemo(
    () => (job?.tentative.length ? (job.words ?? []).concat(job.tentative) : (job?.words ?? [])),
    [job?.words, job?.tentative],
  );
  // Timeline blocks follow the grouping of the chosen caption style.
  const groups = useMemo(() => buildCues(liveWords, presetById(settings.preset).grouping), [liveWords, settings.preset]);

  // Transcript edits, with undo (⌘Z / Ctrl+Z outside text fields).
  const history = useRef<{ jobId: number; words: Word[] }[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const editable = !!job && job.status !== "running" && words.length > 0;
  const onEdit = useCallback(
    (first: number, count: number, text: string) => {
      if (!job) return;
      history.current.push({ jobId: job.id, words: job.words });
      setCanUndo(true);
      setWords(replaceRange(job.words, first, count, text));
      if (burner.state.status === "done") resetBurn();
    },
    [job, setWords, burner.state.status, resetBurn],
  );
  const undo = useCallback(() => {
    const h = history.current;
    while (h.length && h[h.length - 1].jobId !== job?.id) h.pop();
    const prev = h.pop();
    if (prev) setWords(prev.words);
    setCanUndo(h.length > 0);
  }, [job?.id, setWords]);
  useEffect(() => {
    history.current = [];
    setCanUndo(false);
  }, [job?.id]);

  // Punctuation and capitals, once per finished transcript (undo restores the plain text).
  const punctuated = useRef(new Set<number>());
  const applyPunct = useCallback(async () => {
    if (!job || job.status !== "done" || !job.words.length) return;
    punctuated.current.add(job.id);
    const source = job.words;
    try {
      const written = await punctuate(source.map((w) => plainWord(w.text) || w.text));
      history.current.push({ jobId: job.id, words: source });
      setCanUndo(true);
      setWords(source.map((w, i) => ({ ...w, text: written[i] })));
    } catch {
      // Shown in the status bar; the transcript stays as it was.
    }
  }, [job, punctuate, setWords]);
  useEffect(() => {
    if (autoPunct && job?.status === "done" && job.words.length && !punctuated.current.has(job.id)) void applyPunct();
  }, [autoPunct, job?.status, job?.id, job?.words.length, applyPunct]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = !!(e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      if (!inField && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (job?.recording) void stopLive();
        else void goLiveRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, job?.recording, stopLive]);

  const changeSettings = (s: CaptionSettings) => {
    setSettings(s);
    if (burner.state.status === "done" || burner.state.status === "error") burner.reset();
  };

  const title = job?.file?.name ?? (job?.live ? "Canlı kayıt" : "");
  const name = job?.file ? baseName(job.file.name) : "canli-kayit";

  const goLiveRef = useRef<() => Promise<void>>(async () => {});
  const goLive = async () => {
    setNotice(null);
    resetBurn();
    try {
      await startLive(optionsFor(method));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  goLiveRef.current = goLive;

  return (
    <div className={`shell${dragging ? " shell--drag" : ""}`}>
      <header className="toolbar">
        <h1 className="brand">
          <img src={`${import.meta.env.BASE_URL}brand/harfiyen-logo-light.png`} alt="Harfiyen" />
        </h1>
        <button className="tb-btn" onClick={() => picker.current?.click()}>
          <IconOpen /> Dosya aç
        </button>
        <input
          ref={picker}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
            e.target.value = "";
          }}
        />
        <div className="toolbar__title" title={title}>
          {title || "Yeni proje"}
        </div>
        {job && (
          <ExportMenu
            words={words}
            baseName={name}
            meta={{ file: title, model: "seda-v0.1", method: job.options.method }}
            complete={job.status === "done"}
            isVideo={player.isVideo}
            canBurn={!!job.file}
            burn={burner.state}
            onBurn={() => job.file && burner.burn(job.file, words, settings, job.bands)}
            onCancelBurn={burner.cancel}
          />
        )}
      </header>

      <div className="workspace">
        <section className="pane transcript-pane" aria-label="Transkript">
          <div className="pane__head">
            <h2 className="pane__title">Transkript</h2>
            {job && liveWords.length > 0 && <span className="pane__meta">{liveWords.length} kelime</span>}
            {canUndo && (
              <button className="icon-btn" onClick={undo} title="Geri al (⌘Z)" aria-label="Son düzenlemeyi geri al">
                <IconUndo />
              </button>
            )}
          </div>
          <div className="scroll pane__body">
            {job ? (
              <Transcript
                words={words}
                tentative={job.tentative}
                running={job.status === "running"}
                time={player.time}
                playing={player.playing}
                onSeek={player.seek}
                onEdit={editable ? onEdit : undefined}
              />
            ) : (
              <p className="empty-note">Bir dosya açtığında konuşmalar burada, zaman kodlarıyla birlikte belirir.</p>
            )}
          </div>
        </section>

        <main className="viewer">
          <Viewer
            player={player}
            words={liveWords}
            settings={settings}
            liveTime={job?.live && !job.file ? job.decoded : null}
            bands={job?.bands ?? EMPTY_BANDS}
            liveLevels={liveLevels}
          >
            <div className="dropzone">
              <img
                className="dropzone__mark"
                src={`${import.meta.env.BASE_URL}brand/harfiyen-mark-light.png`}
                alt=""
              />
              <h2 className="dropzone__title">{dragging ? "Bırak, başlayalım" : "Video ya da ses dosyası aç"}</h2>
              <p className="dropzone__text">
                Türkçe konuşmayı yazıya döker, altyazıyı videonun içine yazar. Her şey bu bilgisayarda, ekran kartında
                çalışır; dosyan hiçbir yere gönderilmez.
              </p>
              <div className="dropzone__actions">
                <button className="btn btn--primary btn--large" onClick={() => picker.current?.click()}>
                  Dosya aç
                </button>
                <button className="btn btn--large" onClick={goLive}>
                  <IconMic /> Mikrofonla başla
                </button>
              </div>
              <p className="dropzone__fine">
                Dosyayı pencereye sürükleyebilirsin: MP4, MOV, MKV, WebM, MP3, M4A, WAV, FLAC, OGG. İlk kullanımda yaklaşık 105 MB model indirilir ve
                saklanır.
                {engine.phase === "idle" && (
                  <>
                    {" "}
                    <button className="link" onClick={prepare}>
                      Şimdi indir
                    </button>
                  </>
                )}
              </p>
            </div>
          </Viewer>
        </main>

        <Inspector
          settings={settings}
          onSettings={changeSettings}
          burning={burner.state.status === "running"}
          method={method}
          onMethod={setMethod}
          job={job}
          engine={engine}
          onRestart={() => job?.file && openFile(job.file)}
          autoPunct={autoPunct}
          onAutoPunct={setAutoPunct}
          onPunctuate={applyPunct}
          punctBusy={punct.phase === "run" || punct.phase === "download"}
          onCancel={cancel}
        />
      </div>

      <div className="transport">
        <RecordButton recording={!!job?.recording} onStart={goLive} onStop={stopLive} />
        <span className="transport__sep" aria-hidden />
        <button
          className="tp-btn"
          onClick={player.toggle}
          disabled={!job || job.recording}
          aria-label={player.playing ? "Duraklat" : "Oynat"}
        >
          {player.playing ? <IconPause /> : <IconPlay />}
        </button>
        <span className="tp-time">
          <strong>{clock(player.time)}</strong> / {clock(player.duration || job?.duration || 0)}
        </span>
        <button
          className="tp-btn"
          onClick={() => player.setMuted(!player.muted)}
          disabled={!job || job.recording}
          aria-label={player.muted ? "Sesi aç" : "Sesi kapat"}
        >
          {player.muted ? <IconMuted /> : <IconSound />}
        </button>
        {job ? (
          <Timeline
            peaks={job.peaks}
            duration={player.duration || job.duration || 0}
            decoded={job.decoded}
            time={player.time}
            media={player.el}
            cues={groups}
            live={job.recording ? liveMeter.current : null}
            onSeek={player.seek}
          />
        ) : (
          <div className="timeline timeline--empty" />
        )}
      </div>

      <StatusBar engine={engine} job={job} burn={burner.state} notice={notice} punct={punct} />
    </div>
  );
}
