import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LOGO,
  DEFAULT_SETTINGS,
  presetById,
  shownPhoto,
  type CaptionSettings,
} from "./captions/style";
import { ExportMenu } from "./components/ExportMenu";
import { MenuTitle } from "./components/Menu";
import {
  Button,
  EmptyNote,
  IconButton,
  LinkButton,
  Pane,
  PaneBody,
  PaneHead,
  PaneMeta,
  PaneTitle,
  TbLabel,
  toolbarButton,
} from "./components/ui";
import { Dropzone } from "./components/Dropzone";
import { AlignBar } from "./components/AlignBar";
import { FindBar, useFind } from "./components/FindBar";
import {
  ProjectList,
  ProjectName,
  ProjectsMenu,
} from "./components/ProjectsMenu";
import {
  IconGitHub,
  IconMic,
  IconMuted,
  IconOpen,
  IconPause,
  IconPlay,
  IconScissors,
  IconSettings,
  IconSound,
  IconSearch,
  IconAlignText,
  IconUndo,
} from "./components/icons";
import { RecordButton } from "./components/RecordButton";
import { Inspector, type InspectorTab } from "./components/Inspector";
import { SHIFT, SHIFT_BIG } from "./components/TimingSection";
import { ModelMenu } from "./components/ModelMenu";
import { langProblem, VideoLang } from "./components/VideoLang";
import { MoreMenu } from "./components/MoreMenu";
import { Settings } from "./components/Settings";
import { ProviderMenu } from "./components/ProviderMenu";
import { StatusBar } from "./components/StatusBar";
import { UpdateToast } from "./components/UpdateToast";
import { Timeline, TIMELINE } from "./components/Timeline";
import { Transcript } from "./components/Transcript";
import { Viewer } from "./components/Viewer";
import type { DecodeOptions, DecodingMethod, SpeechLang, Word } from "./engine";
import { buildCues } from "./lib/cues";
import { replaceRange } from "./lib/edit";
import { retime, shiftAll, shiftSpan } from "./lib/timing";
import {
  alignText,
  applySpans,
  planSpans,
  tapAlign,
  type TextTiming,
} from "./lib/align";
import { writeNumbers, type NumberMode } from "./lib/numbers";
import { plainWord } from "./punct/turkish";
import {
  isSubtitle,
  parseSubtitles,
  readSubtitle,
  SUBTITLE_EXTS,
} from "./lib/subtitles";
import { download } from "./lib/exporters";
import { clock, duration as fmtDuration } from "./lib/format";
import {
  getDub,
  PROJECT_EXT,
  projectTitle,
  sameMedia,
  saveDub,
} from "./lib/projectStore";
import { useBurner } from "./lib/useBurner";
import { useTabProgress } from "./lib/useTabProgress";
import { useSourceInfo } from "./lib/useSourceInfo";
import { useWaveform } from "./lib/useWaveform";
import { useLogo } from "./lib/logo";
import { usePhoto } from "./lib/photo";
import { useGroundPreview } from "./lib/groundPreview";
import { DEFAULT_KINETIC } from "./render/kinetic";
import type { LogoLayer } from "./render/logoLayer";
import { framing, type Crop } from "./lib/crop";
import { wordsIn } from "./lib/trim";
import {
  DEFAULT_JUMP_CUT,
  findCuts,
  hasActiveCuts,
  keptLength,
  keptParts,
  restoreAllCuts,
  toggleAllFillers,
  toggleAllGaps,
  toggleGapCut,
  toggleWordsCut,
  wordsOutside,
  wordsThrough,
  type JumpCut,
} from "./lib/cuts";
import { readJumpCut } from "./lib/projectStore";
import {
  effectiveOutput,
  loadOutput,
  resolutionOf,
  saveOutput,
  undecodable,
  videoBitrate,
  type VideoOutput,
} from "./lib/videoOutput";
import { usePlayer } from "./lib/usePlayer";
import { useFollow } from "./lib/useFollow";
import {
  DEFAULT_VOICE,
  dubBySentence,
  dubKey,
  fitVoice,
  MAX_ORIGINAL,
  sameVoice,
  storedDub,
  textFromWords,
  useDubber,
  useDubPlayback,
  wordsFromText,
  type Voice,
} from "./lib/useDubber";
import { DUB_RATE, dubMetrics } from "./tts/dub";
import { useProjects } from "./lib/useProjects";
import {
  cachedSpeechModels,
  canResume,
  modelIsCached,
  useTranscriber,
  type TimeRange,
} from "./lib/useTranscriber";
import { warmManifests } from "./lib/modelLibrary";
import { translationLang, useTranslator } from "./lib/useTranslator";
import { useSpeakers } from "./lib/useSpeakers";
import {
  assign as assignSpeaker,
  labelWords,
  merge as mergeSpeakers,
  rename as renameSpeaker,
  type Speakers,
} from "./lib/speakers";
import { sourceKey, type Translation, type TranslationLang } from "./lib/translation";
import { DEFAULT_LANG } from "./engine/languages";
import { hasTranslation, LANG_NAMES } from "./lib/lang";
import { DEFAULT_MODEL, modelInfo, MODELS, type ModelId } from "./models";

const EMPTY_BANDS = new Float32Array(0);
const NO_CUTS: TimeRange[] = [];
/** Play and mute in the transport bar. */
const TP_BTN =
  "grid size-8 flex-none place-items-center rounded-ui border-0 bg-transparent text-fg transition-all duration-150 ease-[ease] hover:not-disabled:bg-raised hover:not-disabled:text-fg-strong disabled:opacity-35 max-[860px]:size-10";
/** TR / EN in the transcript pane's head. */
const LANG_BTN =
  "h-5 rounded-[4px] border-0 bg-transparent px-1.5 text-[10.5px] font-semibold tracking-[0.02em] text-fg-3 hover:not-disabled:text-fg aria-pressed:bg-raised aria-pressed:text-fg-strong disabled:opacity-45";
/** Welcome-screen buttons: long file names are cut; full width on phones. */
const DROP_BTN =
  "min-w-0 max-w-full truncate max-[480px]:h-11 max-[480px]:w-full [&_svg]:mr-1.5";
const ACCEPT = `audio/*,video/*,.mkv,.mov,.m4a,.flac,.ogg,.opus,${SUBTITLE_EXTS},${PROJECT_EXT}`;

type PickerWindow = Window & {
  showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]>;
};
type HandleItem = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
};
// Chromium's picker returns a handle, so a project can reopen the file later.
const PICKER_TYPES = [
  {
    description: "Video, ses, altyazı veya Harfiyen projesi",
    accept: {
      "video/*": [".mp4", ".mov", ".mkv", ".webm", ".m4v"],
      "audio/*": [".mp3", ".m4a", ".wav", ".flac", ".ogg", ".opus", ".aac"],
      "application/x-subrip": [".srt"],
      "text/vtt": [".vtt"],
      "application/json": [PROJECT_EXT],
    },
  },
];

const optionsFor = (
  method: DecodingMethod,
  lang: SpeechLang = "tr",
): DecodeOptions => ({
  method,
  lang,
  maxActivePaths: 4,
  lmScale: 0.6,
  lodrScale: -0.5,
});

function loadSettings(): CaptionSettings {
  try {
    return forNewProject({
      ...DEFAULT_SETTINGS,
      ...JSON.parse(localStorage.getItem("harfiyen.captions") ?? "{}"),
    });
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// A new project starts without "Sesle vurgula", with its captions shown (not the kinetic stage) and its picture; the rest of the look carries over.
/** The jump cut a new project starts with: off, with the lengths last used. */
function offJumpCut(): JumpCut {
  try {
    return {
      ...(readJumpCut(
        JSON.parse(localStorage.getItem("harfiyen.jumpCut") ?? "null"),
      ) ?? DEFAULT_JUMP_CUT),
      on: false,
    };
  } catch {
    return DEFAULT_JUMP_CUT;
  }
}

const forNewProject = (s: CaptionSettings): CaptionSettings => {
  const preset = presetById(s.preset).id;
  return s.voiceEmphasis ||
    s.hidden ||
    s.kinetic?.on ||
    (s.picture ?? "video") !== "video" ||
    s.preset !== preset
    ? {
        ...s,
        preset,
        voiceEmphasis: false,
        hidden: false,
        picture: "video",
        ...(s.kinetic && { kinetic: { ...s.kinetic, on: false } }),
      }
    : s;
};

function baseName(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/** Seconds of transcription work after which cancelling asks first. */
const LONG_JOB_SEC = 60;

export function App() {
  const {
    engine,
    job,
    liveWaiting,
    provider,
    setProvider,
    model,
    setModel,
    prepare,
    open,
    transcribe,
    load,
    attach,
    setSpoken,
    clear,
    startLive,
    stopLive,
    cancel,
    resume,
    setWords,
    setTranslation,
    setSpeakers,
    liveLevels,
    liveMeter,
    punctuate,
    alignAudio,
    aligning: alignProgress,
    punct,
  } = useTranscriber();
  const [autoPunct, setAutoPunct] = useState(
    () => localStorage.getItem("harfiyen.punct") !== "off",
  );
  useEffect(
    () => localStorage.setItem("harfiyen.punct", autoPunct ? "on" : "off"),
    [autoPunct],
  );
  const [numberMode, setNumberMode] = useState<NumberMode>(() => {
    const saved = localStorage.getItem("harfiyen.numbers");
    return saved === "all" || saved === "keep" ? saved : "rule";
  });
  useEffect(
    () => localStorage.setItem("harfiyen.numbers", numberMode),
    [numberMode],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [offline, setOffline] = useState(
    () => typeof navigator !== "undefined" && navigator.onLine === false,
  );
  const [cachedModels, setCachedModels] = useState<ReadonlySet<ModelId>>(
    () => new Set(),
  );
  useEffect(() => {
    warmManifests();
    const syncOnline = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    return () => {
      window.removeEventListener("online", syncOnline);
      window.removeEventListener("offline", syncOnline);
    };
  }, []);
  useEffect(() => {
    if (settingsOpen) return;
    void cachedSpeechModels().then(setCachedModels);
  }, [settingsOpen, engine.phase, model]);
  const [method, setMethod] = useState<DecodingMethod>("beam-lm");
  /** The language spoken in the media, for the next transcription; a project brings its own. */
  const [videoLang, setVideoLang] = useState<SpeechLang>(DEFAULT_LANG);
  const [settings, setSettings] = useState<CaptionSettings>(loadSettings);
  /** The part of the video shown and exported; belongs to the project, unlike the style. */
  const [crop, setCrop] = useState<Crop | null>(null);
  /** The part of the file used: transcribed, played and exported; null for all of it. Belongs to the project too. */
  const [trim, setTrim] = useState<TimeRange | null>(null);
  /** Picking the trim on the timeline ("Kes"): the range as it is being picked, kept on "Tamam". */
  const [trimming, setTrimming] = useState(false);
  const [trimDraft, setTrimDraft] = useState<TimeRange | null>(null);
  const trimAtRef = useRef<(end: "start" | "end", t: number) => void>(() => {});
  /** Cutting out the quiet between words; belongs to the project, its lengths are remembered for the next. */
  const [jumpCut, setJumpCut] = useState<JumpCut>(offJumpCut);
  useEffect(() => {
    const { gap, pad, fillers } = jumpCut;
    localStorage.setItem(
      "harfiyen.jumpCut",
      JSON.stringify({ gap, pad, fillers }),
    );
  }, [jumpCut]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const burner = useBurner();
  const [videoOutput, setVideoOutput] = useState<VideoOutput>(loadOutput);
  /** Framed for Reels: 1080×1920 is offered first; the saved size comes back without the frame. */
  const reels = crop?.aspect === "9:16";
  useEffect(
    () =>
      setVideoOutput((o) => ({
        ...o,
        resolution: reels ? "1080" : loadOutput().resolution,
      })),
    [reels],
  );
  const wave = useWaveform(job?.live ? null : (job?.file ?? null));
  const { logo: logoImage } = useLogo();
  // A video made with another logo (or none) is out of date.
  useEffect(() => burner.reset(), [logoImage, burner.reset]);
  /** The logo as drawn, when there is one and this project shows it. */
  const logoSettings = settings.logo ?? DEFAULT_LOGO;
  const logo = useMemo<LogoLayer | null>(
    () =>
      logoImage && logoSettings.on
        ? {
            image: logoImage.bitmap,
            corner: logoSettings.corner,
            size: logoSettings.size,
            opacity: logoSettings.opacity,
          }
        : null,
    [logoImage, logoSettings],
  );
  const { photo: photoImage } = usePhoto();
  useEffect(() => burner.reset(), [photoImage, burner.reset]);
  /** The photo or video still, when there is one and this project uses it in place of the aura. */
  const photo = settings.photo ? (photoImage?.bitmap ?? null) : null;
  const photoVideo = settings.photo && photoImage?.kind === "video" ? photoImage.video : null;
  const photoVideoUrl = settings.photo && photoImage?.kind === "video" ? photoImage.url : null;
  const dubber = useDubber();
  const translator = useTranslator();
  const speakerTool = useSpeakers();
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("captions");
  const [customText, setCustomText] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const spokenJob = useRef<number | null>(null);
  const autoPlay = useRef(false);
  /** Standalone text-to-speech project: the synthesized WAV is already the job's own file. */
  const isTts = job?.imported === "tts";
  const textMode = !job || isTts;
  /** Show the English translation instead of the transcript, once there is one. */
  const [showEn, setShowEn] = useState(false);
  /** Play and export the dub instead of the original sound, once there is one. */
  const [dubOn, setDubOn] = useState(true);
  const dub = dubber.state.status === "done" ? dubber.state : null;
  const dubbing = dub && dubOn ? dub : null;
  /** How loud the file's own sound stays under the dub, 0 to MAX_ORIGINAL. */
  const [dubOriginal, setDubOriginal] = useState(() => {
    const saved = Number(localStorage.getItem("harfiyen.dubOriginal"));
    return Number.isFinite(saved)
      ? Math.max(0, Math.min(MAX_ORIGINAL, saved))
      : 0;
  });
  useEffect(
    () => localStorage.setItem("harfiyen.dubOriginal", String(dubOriginal)),
    [dubOriginal],
  );
  /** A text-to-speech job's own file is already the dub in its source language. */
  const ownFileIsDub =
    isTts && dubbing?.voice.lang === (job?.options.lang ?? "tr");
  /** The part of the file used, as the jump cut sees it. */
  const span = useMemo(
    () => trim ?? { start: 0, end: job?.duration ?? job?.decoded ?? 0 },
    [trim, job?.duration, job?.decoded],
  );
  /** Why the quiet cannot be cut now; null when it can. */
  const jumpCutUnavailable = !job?.file
    ? "Önce bir video ya da ses dosyası aç."
    : job.live
      ? "Canlı kayıtta kullanılmaz."
      : job.status === "running"
        ? "Yazıya döküm bitince kullanılabilir."
        : !job.words.length
          ? "Önce yazıya dök: boşluklar transkriptten bulunur."
          : null;
  /** Where the dub's voice is heard: never cut, so no line of it is cut off. */
  const dubSpans = useMemo(
    () =>
      dubbing && !ownFileIsDub
        ? dubbing.clips.map((c) => ({
            start: c.start,
            end: c.start + c.audio.length / DUB_RATE,
          }))
        : NO_CUTS,
    [dubbing, ownFileIsDub],
  );
  /** The stretches the jump cut or transcript edits take out, in file time; none while neither is active. */
  const hasManualCuts = useMemo(
    () => !!job?.words.some((w) => w.cut !== undefined || w.cutGap !== undefined),
    [job?.words],
  );
  const cuts = useMemo(
    () =>
      !jumpCutUnavailable && job && hasActiveCuts(job.words, jumpCut)
        ? findCuts(job.words, span, jumpCut, job.loudness, dubSpans)
        : NO_CUTS,
    [jumpCut, jumpCutUnavailable, job?.words, job?.loudness, span, dubSpans],
  );
  const player = usePlayer(
    job?.file ?? null,
    trimming ? trimDraft : trim,
    trimming ? NO_CUTS : cuts,
  );
  const following = useFollow(player, job);
  useTabProgress(
    burner.state.status === "running"
      ? burner.state.progress * 100
      : job?.status === "running" && !job.live && job.duration
        ? (job.decoded / job.duration) * 100
        : null,
  );
  // The style cards show the project's ground; only made while they are on screen.
  const ground = useGroundPreview({
    active: inspectorTab === "captions" || inspectorTab === "scene",
    settings,
    video: player.isVideo && player.el ? (player.el as HTMLVideoElement) : null,
    src: player.url,
    photo,
  });
  useDubPlayback(
    player.el,
    dub?.url ?? null,
    !!dubbing && !ownFileIsDub,
    dubOriginal,
    player.volume,
  );
  const [voice, setVoice] = useState<Voice>(() => {
    try {
      return fitVoice({
        ...DEFAULT_VOICE,
        ...JSON.parse(localStorage.getItem("harfiyen.voice") ?? "{}"),
      });
    } catch {
      return DEFAULT_VOICE;
    }
  });
  useEffect(
    () => localStorage.setItem("harfiyen.voice", JSON.stringify(voice)),
    [voice],
  );
  const {
    projects: saved,
    current,
    saveable,
    noteHandle,
    open: openSaved,
    fromHandle,
    bind,
    remove,
    rename,
    importFile,
    exportText,
  } = useProjects(job, settings, crop, trim, jumpCut);
  /** A saved project opened without its media (not stored, or not found). */
  const needsMedia =
    !!job && !job.file && !job.live && (!!current || !!job.imported);
  /** The project's stored file handle, waiting for the user's permission. */
  const [pendingHandle, setPendingHandle] =
    useState<FileSystemFileHandle | null>(null);
  /** The last project file opened: picking its media starts in that folder. */
  const projectHandle = useRef<FileSystemFileHandle | null>(null);
  // Jobs already punctuated or given digits (or opened from a project): not done again.
  const punctuated = useRef(new Set<number>());

  useEffect(
    () => localStorage.setItem("harfiyen.captions", JSON.stringify(settings)),
    [settings],
  );
  // Open the model right away when it is already in the cache.
  const initialModel = useRef(model);
  useEffect(() => {
    modelIsCached(initialModel.current).then((yes) => yes && prepare());
  }, [prepare]);

  const resetBurn = burner.reset;
  // A dub belongs to its job; an export made with or without it is out of date once that changes.
  const resetDub = dubber.reset;
  useEffect(() => {
    if (job?.id !== spokenJob.current) resetDub();
  }, [job?.id, resetDub]);
  /** The project a dub was started in, which it is saved with once done (the open one may have changed by then). */
  const dubProject = useRef<string | null>(null);
  useEffect(() => {
    const targetId =
      dubProject.current ??
      (job?.id === spokenJob.current ? current?.id : null);
    if (!dub || dub.restored || !targetId) return;
    void saveDub(targetId, storedDub(dub)).catch(() => {}); // Over quota: the dub just is not kept.
  }, [dub, current?.id, job?.id]);
  useEffect(() => {
    if (!autoPlay.current || !player.el || !player.url) return;
    autoPlay.current = false;
    void player.el.play().catch(() => {});
  }, [player.el, player.url]);
  // A reopened project brings its dub back, with the voice it was made with.
  const latestJob = useRef(job);
  latestJob.current = job;
  const restoreDub = dubber.restore;
  const projectId = current?.id ?? null;
  useEffect(() => {
    if (!projectId) return;
    let gone = false;
    getDub(projectId)
      .then((d) => {
        const j = latestJob.current;
        if (gone || !d || !j) return;
        setVoice(d.voice);
        setDubOn(true);
        const read =
          d.voice.lang === (j.options.lang ?? "tr")
            ? j.words
            : j.translation?.lang === d.voice.lang
              ? j.translation.words
              : [];
        restoreDub(
          d,
          read,
          dubBySentence(d.voice.lang, j.options.lang ?? "tr"),
        );
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [projectId, restoreDub]);
  useEffect(
    () => resetBurn(),
    [dubbing, dubOriginal, settings.hidden, resetBurn],
  );
  const openProject = useCallback(
    async (id: string) => {
      try {
        const r = await openSaved(id);
        if (!r) return;
        const { project: p, file, handle } = r;
        resetBurn();
        setPendingHandle(handle);
        setNotice(
          file && !sameMedia(p.media, file)
            ? "Medya dosyası proje kaydedildikten sonra değişmiş görünüyor, zamanlar kayabilir."
            : null,
        );
        setSettings(p.settings);
        setCrop(p.crop ?? null);
        setTrim(p.trim ?? null);
        setJumpCut(p.jumpCut ?? offJumpCut());
        setMethod(p.method);
        setVideoLang(p.lang ?? "tr");
        const jobId = load({
          file,
          model: p.model ?? DEFAULT_MODEL,
          options: optionsFor(p.method, p.lang),
          duration: p.duration,
          elapsed: p.elapsed,
          stoppedAt: p.stoppedAt,
          imported: p.imported,
          words: p.words,
          peaks: p.peaks,
          bands: p.bands,
          loudness: p.loudness ?? EMPTY_BANDS,
          translation: p.translation,
          speakers: p.speakers,
        });
        punctuated.current.add(jobId);
        bind(jobId, p, file);
      } catch {
        setNotice("Proje açılamadı.");
      }
    },
    [openSaved, resetBurn, load, bind],
  );
  const importProject = useCallback(
    async (f: File) => {
      try {
        const p = await importFile(f);
        await openProject(p.id);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [importFile, openProject],
  );
  // A subtitle file becomes a new project, with the open media if there is one.
  // The transcript it replaces stays in its own project.
  const openSubtitle = useCallback(
    async (f: File) => {
      if (job?.recording) {
        setNotice("Kayıt sürerken altyazı açılamaz; önce kaydı durdur.");
        return;
      }
      let subs: Word[];
      try {
        subs = parseSubtitles(await readSubtitle(f));
      } catch (e) {
        setNotice(
          e instanceof Error ? e.message : "Altyazı dosyası okunamadı.",
        );
        return;
      }
      const media = job?.file ? job : null;
      setNotice(null);
      setPendingHandle(null);
      setSettings(forNewProject);
      resetBurn();
      const jobId = load({
        file: media?.file ?? null,
        model: job?.model ?? model,
        imported: f.name,
        options: optionsFor(method, videoLang),
        duration: media?.duration ?? null,
        elapsed: null,
        words: subs,
        peaks: media?.peaks ?? new Float32Array(0),
        bands: media?.bands ?? EMPTY_BANDS,
        loudness: media?.loudness ?? EMPTY_BANDS,
      });
      punctuated.current.add(jobId);
    },
    [job, model, method, load, resetBurn],
  );
  const openFile = useCallback(
    (f: File, handle?: FileSystemFileHandle) => {
      if (isSubtitle(f.name)) {
        void openSubtitle(f);
        return;
      }
      if (f.name.toLowerCase().endsWith(PROJECT_EXT)) {
        projectHandle.current = handle ?? null;
        void importProject(f);
        return;
      }
      if (handle) noteHandle(f, handle);
      // A project waiting for its media takes the file, if it is the one.
      if (
        needsMedia &&
        (sameMedia(current?.media ?? null, f) ||
          confirm(
            `“${f.name}”, bu projenin dosyasıyla (“${current?.media?.name}”) aynı görünmüyor. ` +
              "Yine de projeye bağlansın mı? İptal dersen yeni bir döküm başlar.",
          ))
      ) {
        setNotice(null);
        setPendingHandle(null);
        attach(f);
        return;
      }
      setPendingHandle(null);
      setSettings(forNewProject);
      resetBurn();
      setCrop(null);
      setTrim(null);
      setJumpCut(offJumpCut());
      // The language belongs to the file, not to the project before it.
      setVideoLang(DEFAULT_LANG);
      // Not transcribed yet: first the frame and the part to use, then "Yazıya dök".
      open(f, optionsFor(method, DEFAULT_LANG));
    },
    [
      open,
      method,
      resetBurn,
      openSubtitle,
      importProject,
      noteHandle,
      needsMedia,
      current,
      attach,
    ],
  );
  const pickFile = useCallback(async () => {
    const w = window as PickerWindow;
    if (!w.showOpenFilePicker) return picker.current?.click();
    try {
      const startIn = needsMedia
        ? (pendingHandle ?? projectHandle.current)
        : null;
      const [h] = await w.showOpenFilePicker({
        id: "harfiyen-media",
        types: PICKER_TYPES,
        ...(startIn && { startIn }),
      });
      openFile(await h.getFile(), h);
    } catch (e) {
      if ((e as DOMException).name !== "AbortError") picker.current?.click();
    }
  }, [openFile, needsMedia, pendingHandle]);
  const allowHandle = async () => {
    if (!pendingHandle) return;
    const file = await fromHandle(pendingHandle);
    if (file) {
      setPendingHandle(null);
      attach(file);
    } else {
      setPendingHandle(null);
      setNotice(
        "Dosyaya ulaşılamadı, taşınmış ya da silinmiş olabilir. Yeniden seç.",
      );
    }
  };
  const newProject = () => {
    setNotice(null);
    setPendingHandle(null);
    setSettings(forNewProject);
    resetBurn();
    setCrop(null);
    setTrim(null);
    setJumpCut(offJumpCut());
    setCustomText("");
    setVideoLang(DEFAULT_LANG);
    clear();
  };

  // A wrong file: stop and drop it, nothing is saved. Asks first once a
  // minute of work would be thrown away.
  const discardJob = () => {
    if (!job) return;
    const worked = job.speed > 0 ? job.decoded / job.speed : 0;
    if (
      worked >= LONG_JOB_SEC &&
      !confirm(
        `Yazıya dökme iptal edilsin mi? Şimdiye kadar dökülen ${fmtDuration(job.decoded)} silinir, proje kaydedilmez.`,
      )
    ) {
      return;
    }
    // A file opened before it was transcribed is saved already, with no words: it goes too.
    // A project transcribed before keeps its saved transcript.
    if (current && !current.words.length) void remove(current.id);
    newProject();
  };

  // Go on with a stopped transcription; the whole transcript is punctuated
  // once it is done, as if it had never stopped.
  const resumeJob = canResume(job)
    ? () => {
        punctuated.current.delete(job.id);
        resume(trim ?? undefined);
      }
    : undefined;

  /**
   * Transcribe the open file, or only the trimmed part of it, with the chosen
   * model. A transcript it replaces comes back with ⌘Z.
   */
  const transcribeJob = () => {
    if (!job?.file || job.live || job.status === "running" || langIssue) return;
    if (job.words.length) {
      history.current.push({ jobId: job.id, en: false, words: job.words });
      setCanUndo(true);
    }
    punctuated.current.delete(job.id);
    resetBurn();
    transcribe(optionsFor(method, videoLang), trim ?? undefined);
  };

  // Deleting the open project moves on to the next most recent one.
  const deleteProject = async (id: string) => {
    const wasOpen = current?.id === id;
    await remove(id);
    if (!wasOpen) return;
    const next = saved.find((p) => p.id !== id);
    if (next) void openProject(next.id);
    else newProject();
  };

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
      if (!f) return;
      // The handle has to be asked for while the drop event is running.
      const item = [...e.dataTransfer!.items].find((i) => i.kind === "file");
      const handle = (
        item as HandleItem | undefined
      )?.getAsFileSystemHandle?.();
      if (!handle) return openFile(f);
      handle.then(
        (h) =>
          openFile(
            f,
            h?.kind === "file" ? (h as FileSystemFileHandle) : undefined,
          ),
        () => openFile(f),
      );
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

  /** The transcript as spoken; dubbing, punctuation and numbers always work on it. */
  const words = job?.words ?? [];
  const translation = job?.translation;
  /** Who speaks when; the words shown carry their speaker. */
  const speakers = job?.speakers;
  const speakersNow = useRef(speakers);
  speakersNow.current = speakers;
  /** The names shown over the captions, when asked for and there is more than one speaker. */
  const captionSpeakers =
    settings.speakerNames && speakers && speakers.names.length > 1
      ? speakers.names
      : null;
  /** The language spoken in the media, as the open transcript was made in. */
  const sourceLang: SpeechLang = job ? (job.options.lang ?? "tr") : voice.lang;
  /** What the next translation is into: the pick, else the open translation's, else English (Turkish for English). */
  const [targetPick, setTargetPick] = useState<TranslationLang | null>(null);
  const targetLang: TranslationLang =
    [targetPick, translation?.lang].find((l): l is TranslationLang => !!l && l !== sourceLang) ??
    (translationLang(sourceLang) as TranslationLang);
  useEffect(() => {
    if (isTts) setCustomText(textFromWords(words));
  }, [isTts, words]);
  /** Showing the translation rather than the transcript. */
  const translated = showEn && !!translation;
  const lang = translated ? translation.lang : sourceLang;
  /** What the transcript pane, the player and the exports show: the transcript or its translation. */
  const shown = useMemo(
    () => labelWords(translated ? translation.words : words, speakers),
    [translated, translation, words, speakers],
  );
  const liveWords = useMemo(
    () =>
      translated
        ? shown
        : job?.tentative.length
          ? (job.words ?? []).concat(job.tentative)
          : shown,
    [translated, shown, job?.words, job?.tentative],
  );
  /** What the dub reads: the transcript in its own language, or the translation into the other. */
  const dubWords =
    voice.lang === sourceLang
      ? words
      : translation?.lang === voice.lang
        ? translation.words
        : [];
  const fileDuration = player.duration || job?.duration || 0;
  /** Where the dub must be over by: the trim's end, or the file's. */
  const dubEnd = trim?.end ?? fileDuration;
  const dubWordsKey = useMemo(() => dubKey(dubWords), [dubWords]);
  const textEdited =
    isTts &&
    voice.lang === sourceLang &&
    customText.trim() !== textFromWords(words).trim();
  const dubStale =
    textEdited ||
    (!!dub &&
      (dub.key !== dubWordsKey ||
        !sameVoice(dub.voice, voice) ||
        (!textMode && dub.end !== dubEnd)));
  /**
   * With the dub on and captions in its language, the captions follow the dub: its words at the times it says
   * them. The transcript pane and edits keep the spoken times.
   */
  const dubTimed =
    dubbing && !dubStale && dubbing.voice.lang === lang ? dubbing.timed : null;
  /** What the player, the timeline and the exports caption with. */
  /** A filler the jump cut takes out is not captioned either. */
  const captionWords = useMemo(
    () => wordsOutside(dubTimed ?? liveWords, cuts),
    [dubTimed, liveWords, cuts],
  );
  // Timeline blocks follow the grouping of the chosen caption style.
  const groups = useMemo(
    () => buildCues(captionWords, presetById(settings.preset).grouping),
    [captionWords, settings.preset],
  );
  const translationStale = useMemo(
    () => !!translation && translation.source !== sourceKey(words),
    [translation, words],
  );
  // A translation belongs to its job.
  const cancelTranslation = translator.cancel;
  useEffect(() => cancelTranslation(), [job?.id, cancelTranslation]);
  // A video made in the other language is out of date.
  useEffect(() => resetBurn(), [lang, resetBurn]);

  // Transcript edits, with undo (⌘Z / Ctrl+Z outside text fields). `en`: the edit was to the translation.
  // `translation`: the translation as it was, when the edit moved it too (a shift of every caption), or, with
  // `en`, when a new translation replaced it (it may have been into another language).
  // An edit of who speaks keeps the speakers as they were instead.
  const history = useRef<
    (
      | { jobId: number; en: boolean; words: Word[]; translation?: Translation }
      | { jobId: number; speakers: Speakers | undefined }
    )[]
  >([]);
  const [canUndo, setCanUndo] = useState(false);
  const editable = !!job && job.status !== "running" && shown.length > 0;
  const commitWords = useCallback(
    (next: Word[]) => {
      if (!job || next === shown) return;
      history.current.push({ jobId: job.id, en: translated, words: shown });
      setCanUndo(true);
      if (translated) setTranslation(job.id, { ...translation, words: next });
      else setWords(next);
      if (burner.state.status === "done") resetBurn();
    },
    [
      job,
      translated,
      shown,
      translation,
      setWords,
      setTranslation,
      burner.state.status,
      resetBurn,
    ],
  );
  const onEdit = useCallback(
    (first: number, count: number, text: string) =>
      commitWords(replaceRange(shown, first, count, text)),
    [shown, commitWords],
  );
  const canCutFromText = editable && !translated && !jumpCutUnavailable;
  const onToggleWords = useCallback(
    (indices: number[], force?: boolean) =>
      commitWords(toggleWordsCut(shown, indices, jumpCut, force)),
    [shown, jumpCut, commitWords],
  );
  const onToggleGap = useCallback(
    (index: number, force?: boolean) =>
      commitWords(toggleGapCut(shown, index, jumpCut, force)),
    [shown, jumpCut, commitWords],
  );
  const onToggleAllFillers = useCallback(
    () => commitWords(toggleAllFillers(shown, jumpCut)),
    [shown, jumpCut, commitWords],
  );
  const onToggleAllGaps = useCallback(
    () => commitWords(toggleAllGaps(shown, jumpCut, span.start)),
    [shown, jumpCut, span.start, commitWords],
  );
  const onRestoreManualCuts = useCallback(
    () => commitWords(restoreAllCuts(shown)),
    [shown, commitWords],
  );
  // Hand-edited times: a line or a word placed or moved in what is shown.
  const onRetime = useCallback(
    (first: number, count: number, start: number, end: number) =>
      commitWords(retime(shown, first, count, start, end)),
    [shown, commitWords],
  );
  const onShiftSpan = useCallback(
    (first: number, count: number, seconds: number) =>
      commitWords(shiftSpan(shown, first, count, seconds)),
    [shown, commitWords],
  );
  /** Every caption moved: the transcript and its translation together, so they stay in step; one undo. */
  const onShiftAll = useCallback(
    (seconds: number) => {
      if (!job) return;
      // The earliest word of either stops at 0, so both move by the same amount.
      const first = Math.min(
        words[0]?.start ?? Infinity,
        translation?.words[0]?.start ?? Infinity,
      );
      const d = Math.max(seconds, -(Number.isFinite(first) ? first : 0));
      if (!d) return;
      history.current.push({ jobId: job.id, en: false, words, translation });
      setCanUndo(true);
      setWords(shiftAll(words, d));
      if (translation)
        setTranslation(job.id, {
          ...translation,
          words: shiftAll(translation.words, d),
        });
      if (burner.state.status === "done") resetBurn();
    },
    [
      job,
      words,
      translation,
      setWords,
      setTranslation,
      burner.state.status,
      resetBurn,
    ],
  );
  const undo = useCallback(() => {
    const h = history.current;
    while (h.length && h[h.length - 1].jobId !== job?.id) h.pop();
    const prev = h.pop();
    if (prev && "speakers" in prev) {
      if (job) setSpeakers(job.id, prev.speakers);
    } else if (prev?.en && job && (prev.translation ?? job.translation)) {
      // A replaced translation comes back whole, language included; an edit only brings back its words.
      setTranslation(job.id, prev.translation ?? { ...job.translation!, words: prev.words });
      setShowEn(true);
    } else if (prev && !prev.en) {
      setWords(prev.words);
      if (prev.translation && job) setTranslation(job.id, prev.translation);
      else setShowEn(false);
    }
    setCanUndo(h.length > 0);
  }, [job?.id, job?.translation, setWords, setTranslation, setSpeakers]);
  /** A change to who speaks, with undo. */
  const commitSpeakers = useCallback(
    (next: Speakers | undefined) => {
      if (!job) return;
      history.current.push({ jobId: job.id, speakers: job.speakers });
      setCanUndo(true);
      setSpeakers(job.id, next);
      if (burner.state.status === "done") resetBurn();
    },
    [job, setSpeakers, burner.state.status, resetBurn],
  );
  const onSpeaker = useCallback(
    (start: number, end: number, speaker: number) =>
      speakers && commitSpeakers(assignSpeaker(speakers, start, end, speaker)),
    [speakers, commitSpeakers],
  );
  /** Why the speakers cannot be told apart now; null when they can. */
  const speakersUnavailable = !job?.file
    ? "Önce bir video ya da ses dosyası aç."
    : job.status === "running"
      ? "Yazıya döküm bitince kullanılabilir."
      : !job.words.length
        ? "Önce yazıya dök: konuşmacılar kelimelerin zamanından ayrılır."
        : null;
  const runSpeakers = (count: number | undefined) => {
    if (!job?.file) return;
    const id = job.id;
    const end = job.duration ?? job.decoded;
    const range = {
      start: Math.max(0, (job.words[0]?.start ?? 0) - 1),
      end: Math.min(end, (job.words.at(-1)?.end ?? end) + 1),
    };
    // Called only while the job is open (it is cancelled when another opens).
    speakerTool.diarize(job.file, range, job.words, count, (sp) => {
      history.current.push({ jobId: id, speakers: speakersNow.current });
      setCanUndo(true);
      setSpeakers(id, sp);
    });
  };
  // Who speaks belongs to its job.
  const cancelSpeakers = speakerTool.cancel;
  useEffect(() => cancelSpeakers(), [job?.id, cancelSpeakers]);
  /** `then` runs with the translation once it is made (not if it is cancelled or the job changes). */
  const translate = (then?: (t: Translation) => void, into: TranslationLang = targetLang) => {
    if (!job) return;
    const id = job.id;
    const before = job.translation;
    translator.translate(words, sourceLang, into, (t) => {
      // A new translation replaces any edits to the old one; ⌘Z brings them back.
      if (before) {
        history.current.push({ jobId: id, en: true, words: before.words, translation: before });
        setCanUndo(true);
      }
      setTranslation(id, t);
      setShowEn(true);
      then?.(t);
    });
  };
  const startDub = (read: Word[]) => {
    if (textMode && (!isTts || voice.lang === sourceLang)) {
      const trimmed = customText.trim();
      if (!trimmed) return;
      const source =
        isTts && trimmed === textFromWords(words).trim()
          ? words
          : wordsFromText(trimmed);
      const langChoice: SpeechLang = isTts ? sourceLang : voice.lang;
      dubProject.current = current?.id ?? null;
      dubber.dub(source, 0, 0, voice, true, (r) => {
        const { peaks, bands, loudness } = dubMetrics(r.clips, r.duration);
        const file = new File([r.wav], "Metin seslendirme.wav", {
          type: "audio/wav",
        });
        const opts = optionsFor(method, langChoice);
        resetBurn();
        autoPlay.current = true;
        if (isTts && job) {
          if (trimmed !== textFromWords(words).trim()) {
            history.current.push({ jobId: job.id, en: false, words });
            setCanUndo(true);
          }
          spokenJob.current = job.id;
          setSpoken({
            file,
            options: opts,
            duration: r.duration,
            elapsed: r.elapsed,
            words: r.timed,
            peaks,
            bands,
            loudness,
          });
        } else {
          setNotice(null);
          setPendingHandle(null);
          setSettings((s) => {
            const clean = forNewProject(s);
            return {
              ...clean,
              kinetic: { ...(clean.kinetic ?? DEFAULT_KINETIC), on: true },
            };
          });
          setCrop(null);
          setTrim(null);
          setJumpCut(offJumpCut());
          setVideoLang(langChoice);
          const id = load({
            file,
            model,
            imported: "tts",
            options: opts,
            duration: r.duration,
            elapsed: r.elapsed,
            words: r.timed,
            peaks,
            bands,
            loudness,
          });
          spokenJob.current = id;
          punctuated.current.add(id);
        }
      });
      return;
    }
    dubProject.current = current?.id ?? null;
    dubber.dub(
      read,
      fileDuration,
      dubEnd,
      voice,
      dubBySentence(voice.lang, sourceLang),
    );
  };
  const find = useFind(shown, lang);
  const { close: closeFind, show: showFind } = find;
  const found = useMemo(
    () =>
      find.open && editable
        ? { matches: find.matches, current: find.current }
        : undefined,
    [find.open, editable, find.matches, find.current],
  );
  // A pasted text placed on the audio in place of the transcript (song lyrics, a script). Not over a
  // translation, nor a project made from a text, whose words are already the text.
  const [aligning, setAligning] = useState(false);
  const [alignDraft, setAlignDraft] = useState("");
  const canAlign = editable && !translated && !isTts;
  /** Why Whisper cannot look for the words in the audio ("Sesle ince ayar"), or null. */
  const refineIssue = !job?.file
    ? "Bu projede ses dosyası yok."
    : modelInfo(model).engine !== "whisper"
      ? "Whisper gerekir: model menüsünden Whisper'ı seç (döküm yeniden yapılmaz)."
      : null;
  // Whisper answers later: the transcript must still be the one it was asked about.
  const latestWords = useRef(words);
  latestWords.current = words;
  /** Places the text with `time` (from the transcript, or from taps), then optionally refines it in the audio. */
  const placeText = async (
    time: (heard: Word[]) => TextTiming,
    refine: boolean,
  ): Promise<string | null> => {
    if (!job) return null;
    try {
      const timing = time(words);
      let next = timing.words;
      if (refine && job.file && !refineIssue) {
        const spans = planSpans(timing, fileDuration);
        const found = await alignAudio(
          job.file,
          sourceLang,
          spans.map((s) => ({
            start: s.start,
            end: s.end,
            words: timing.words.slice(s.first, s.last + 1).map((w) => w.text),
          })),
        );
        if (latestWords.current !== words)
          return "Transkript bu sırada değişti; yeniden hizala.";
        next = applySpans(timing, spans, found);
      }
      commitWords(next);
      setAligning(false);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const onAlign = (text: string, lines: boolean, refine: boolean) =>
    placeText((heard) => alignText(heard, text, { lines }), refine);
  const onTaps = (
    text: string,
    lines: boolean,
    taps: number[],
    refine: boolean,
  ) => placeText((heard) => tapAlign(heard, text, taps, { lines }), refine);
  /** The player, for timing by hand: from the trim's start, if there is one. */
  const tapPlayback = {
    start: () => {
      player.seek(trim?.start ?? 0);
      if (!player.playing) player.toggle();
    },
    stop: () => {
      if (player.playing) player.toggle();
    },
    toggle: player.toggle,
    seek: player.seek,
    time: () => player.el?.currentTime ?? player.time,
  };
  useEffect(() => {
    history.current = [];
    setCanUndo(false);
    closeFind();
    setAligning(false);
  }, [job?.id, closeFind]);

  const chosen = modelInfo(model);
  // Why GPU-only models cannot run here, if they cannot.
  const gpuReason =
    provider === "wasm"
      ? "İşlemci (WASM) seçili; bu model ekran kartı gerektirir."
      : !("gpu" in navigator)
        ? "Bu tarayıcı WebGPU desteklemiyor."
        : engine.phase === "ready" &&
            engine.provider === "wasm" &&
            !chosen.gpuOnly &&
            !chosen.cpuOnly
          ? (engine.fallbackReason ?? "Ekran kartı kullanılamıyor.")
          : null;
  /** Why the chosen model cannot transcribe the video's language, if it cannot. */
  const langIssue = langProblem(
    videoLang,
    chosen.name,
    chosen.langs,
    gpuReason,
  );
  const chooseVideoLang = (l: SpeechLang) => {
    setVideoLang(l);
    // Only Whisper knows the other languages: its light version, unless it cannot run here.
    if (!modelInfo(model).langs.includes(l) && !gpuReason)
      setModel("whisper-turbo-q4");
  };

  const withDigits = useCallback(
    (list: Word[]) => writeNumbers(list, numberMode),
    [numberMode],
  );
  // Punctuation and capitals, then numbers in digits, once per finished
  // transcript (one undo restores the plain text).
  const applyPunct = useCallback(async () => {
    if (!job || job.status !== "done" || !job.words.length) return;
    punctuated.current.add(job.id);
    const source = job.words;
    try {
      const written = await punctuate(
        source.map((w) => plainWord(w.text) || w.text),
      );
      // Words already in digits ("1923'te") keep their writing; only the punctuation after them changes.
      const keep = (old: string, now: string) =>
        /\d/.test(old)
          ? old.replace(/[.,;:!?…]+$/, "") +
            (/[.,;:!?…]+$/.exec(now)?.[0] ?? "")
          : now;
      history.current.push({ jobId: job.id, en: false, words: source });
      setCanUndo(true);
      setWords(
        withDigits(
          source.map((w, i) => ({ ...w, text: keep(w.text, written[i]) })),
        ),
      );
    } catch {
      // Shown in the status bar; the transcript stays as it was.
    }
  }, [job, punctuate, setWords, withDigits]);
  // Numbers on their own: for Whisper, with punctuation off, or from the button.
  const applyNumbers = useCallback(() => {
    if (
      !job ||
      job.status !== "done" ||
      !job.words.length ||
      numberMode === "keep"
    )
      return;
    punctuated.current.add(job.id);
    const next = withDigits(job.words);
    if (next.every((w, i) => w === job.words[i])) return;
    history.current.push({ jobId: job.id, en: false, words: job.words });
    setCanUndo(true);
    setWords(next);
  }, [job, numberMode, setWords, withDigits]);
  // Whisper punctuates by itself; numbers are written the chosen way for every model.
  useEffect(() => {
    if (
      job?.status !== "done" ||
      !job.words.length ||
      punctuated.current.has(job.id)
    )
      return;
    if (autoPunct && !modelInfo(job.model).punctuates) void applyPunct();
    // The number rules are Turkish.
    else if (numberMode !== "keep" && (job.options.lang ?? "tr") === "tr")
      applyNumbers();
  }, [
    autoPunct,
    numberMode,
    job?.status,
    job?.id,
    job?.model,
    job?.options.lang,
    job?.words.length,
    applyPunct,
    applyNumbers,
  ]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not behind an open window (settings).
      if ((e.target as HTMLElement).closest("dialog")) return;
      const inField = !!(e.target as HTMLElement).closest(
        "input, textarea, select, [contenteditable]",
      );
      if (
        !inField &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key.toLowerCase() === "r"
      ) {
        e.preventDefault();
        if (job?.recording || liveWaiting) void stopLive();
        else void goLiveRef.current();
        return;
      }
      // Picking the trim: Enter keeps it, Escape drops it.
      if (trimming && !inField && (e.key === "Enter" || e.key === "Escape")) {
        if (e.key === "Enter" && (e.target as HTMLElement).closest("button"))
          return;
        e.preventDefault();
        if (e.key === "Enter") finishTrimming();
        else setTrimming(false);
        return;
      }
      // I and O: the trim starts or ends at the playhead.
      const key = e.key.toLowerCase();
      if (
        !inField &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (key === "i" || key === "o")
      ) {
        if (!job?.file || job.live || job.status === "running" || !player.el)
          return;
        e.preventDefault();
        trimAtRef.current(key === "i" ? "start" : "end", player.el.currentTime);
        return;
      }
      // [ and ]: every caption earlier or later (with Shift: the bigger step).
      if (
        !inField &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        (e.code === "BracketLeft" || e.code === "BracketRight")
      ) {
        if (!editable) return;
        e.preventDefault();
        const step = e.shiftKey ? SHIFT_BIG : SHIFT;
        onShiftAll(e.code === "BracketLeft" ? -step : step);
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "f" &&
        editable
      ) {
        e.preventDefault();
        showFind();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "z"
      ) {
        if (
          (e.target as HTMLElement).closest(
            "input, textarea, [contenteditable]",
          )
        )
          return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const sourceInfo = useSourceInfo(job?.file ?? null, crop);
  // A picture this browser cannot decode (AV1 in Safari without the hardware for it): said up front, not at export.
  const badCodec = undecodable(sourceInfo);
  // Exports are of the trimmed part, less the jump cuts: subtitle times from its start, sizes for its length.
  const kept = useMemo(
    () => (cuts.length ? keptParts(span, cuts) : null),
    [span, cuts],
  );
  const exportWords = useMemo(
    () =>
      cuts.length
        ? wordsThrough(dubTimed ?? shown, span, cuts)
        : wordsIn(dubTimed ?? shown, trim, true),
    [dubTimed, shown, trim, span, cuts],
  );
  const exportSource = useMemo(
    () =>
      sourceInfo && (trim || kept)
        ? {
            ...sourceInfo,
            duration: kept ? keptLength(kept) : trim!.end - trim!.start,
          }
        : sourceInfo,
    [sourceInfo, trim, kept],
  );
  const jumpCutSummary =
    (jumpCut.on || hasManualCuts) && !jumpCutUnavailable
      ? {
          count: cuts.length,
          before: span.end - span.start,
          after: kept ? keptLength(kept) : span.end - span.start,
        }
      : null;
  // The preview draws a video at the size it is written at.
  const outputSize = useMemo(() => {
    if (!sourceInfo?.video) return null;
    const r = resolutionOf(
      effectiveOutput(videoOutput, sourceInfo),
      sourceInfo,
    );
    return { w: r.width, h: r.height };
  }, [sourceInfo, videoOutput]);
  const changeOutput = (o: VideoOutput) => {
    setVideoOutput(o);
    // A size picked for Reels stays with Reels; other videos keep the saved one.
    saveOutput(reels ? { ...o, resolution: loadOutput().resolution } : o);
    if (burner.state.status === "done" || burner.state.status === "error")
      burner.reset();
  };
  const burnVideo = () => {
    if (!job?.file) return;
    // A crop needs the picture's size; the file is read within a moment of opening.
    if (crop && !sourceInfo) return;
    const out = effectiveOutput(videoOutput, sourceInfo);
    const resolution = sourceInfo && resolutionOf(out, sourceInfo);
    const picture = sourceInfo?.video;
    const frame =
      crop && picture ? framing(crop, picture.width, picture.height) : null;
    const framed = frame && !frame.none ? frame : null;
    const encode = {
      codec: out.codec,
      bitrate: sourceInfo ? videoBitrate(out, sourceInfo) : null,
      encoder: resolution?.encoders[out.codec] ?? null,
      size: resolution && {
        width: resolution.width,
        height: resolution.height,
      },
      crop: framed?.crop ?? null,
      fit: framed && !framed.crop ? framed.placement : null,
      trim,
      cuts: cuts.length ? cuts : null,
    };
    // Translated or dub-timed words are not timed by the voice, so "Sesle vurgula" has nothing to go by.
    const loudness =
      translated || (dubTimed && !ownFileIsDub) ? EMPTY_BANDS : job.loudness;
    // Only the trimmed part's words, so no caption line reaches outside it.
    void burner.burn(
      job.file,
      wordsOutside(wordsIn(dubTimed ?? shown, trim), cuts),
      settings,
      job.bands,
      loudness,
      lang,
      captionSpeakers,
      encode,
      dubbing && !ownFileIsDub
        ? { clips: dubbing.clips, original: dubOriginal }
        : null,
      logo,
      photo,
      photoVideo,
      `${exportName}${videoSuffix}`,
    );
  };

  const changeCrop = (c: Crop | null) => {
    setCrop(c);
    if (burner.state.status === "done" || burner.state.status === "error")
      burner.reset();
  };

  const changeJumpCut = (j: JumpCut) => {
    setJumpCut(j);
    if (burner.state.status === "done" || burner.state.status === "error")
      burner.reset();
  };

  const changeTrim = (r: TimeRange | null) => {
    setTrim(r);
    if (burner.state.status === "done" || burner.state.status === "error")
      burner.reset();
  };
  const startTrimming = () => {
    setTrimDraft(trim);
    setTrimming(true);
  };
  /** The range being picked, or null when it holds the whole file (the handles keep a range while dragged). */
  const draftWhole =
    !trimDraft ||
    (trimDraft.start <= 0.01 &&
      trimDraft.end >= (player.duration || job?.duration || 0) - 0.01);
  const finishTrimming = () => {
    if (trimming) changeTrim(draftWhole ? null : trimDraft);
    setTrimming(false);
  };
  // Transcription starting, or another file, ends the picking without a change.
  const trimLocked = !job?.file || job.live || job.status === "running";
  useEffect(() => {
    if (trimLocked) setTrimming(false);
  }, [trimLocked, job?.id]);

  /** One end of the trim (or of the one being picked) at `t`; the other end stays unless it would come first. */
  trimAtRef.current = (end, t) => {
    const total = player.duration || job?.duration || 0;
    if (!total) return;
    const cur = trimming ? trimDraft : trim;
    const set = trimming ? setTrimDraft : changeTrim;
    const start = end === "start" ? t : (cur?.start ?? 0);
    const stop = end === "end" ? t : (cur?.end ?? total);
    const whole = start <= 0.01 && stop >= total - 0.01;
    if (stop - start < 0.5)
      set(end === "start" ? { start: t, end: total } : { start: 0, end: t });
    else set(whole ? null : { start, end: stop });
  };

  const changeSettings = (s: CaptionSettings) => {
    setSettings(s);
    if (burner.state.status === "done" || burner.state.status === "error")
      burner.reset();
  };

  const title = current
    ? projectTitle(current)
    : (job?.file?.name ?? (job?.live ? "Canlı kayıt" : ""));
  const name = current
    ? projectTitle(current)
    : job?.file
      ? baseName(job.file.name)
      : "canli-kayit";
  /** Exports of the translation say so in their name. */
  const exportName = translated ? `${name}.${lang}` : name;
  /** The exported video's name says what is in it: captions, or a dub without them. */
  const videoSuffix = !settings.hidden
    ? ".altyazili.mp4"
    : dubbing
      ? ".seslendirme.mp4"
      : ".mp4";
  const dubOverflow = dub?.overflow ?? null;
  /** The trim, lengthened past the end so the last line of the dub fits; null when there is no more video. */
  const longerTrim =
    trim && dubOverflow && trim.end < fileDuration - 0.05
      ? {
          start: trim.start,
          end: Math.min(fileDuration, trim.end + dubOverflow.seconds + 0.3),
        }
      : null;
  const exportProject = () => {
    const text = exportText();
    if (text) download(`${name}${PROJECT_EXT}`, text, "application/json");
  };

  // Only models that stream (seda) can transcribe the microphone.
  const micBlocked = chosen.live
    ? null
    : `Canlı kayıt ${chosen.name} ile yapılamaz; mikrofon için üst çubuktan ${modelInfo(DEFAULT_MODEL).name}'yı seç.`;
  // A finished transcript made in another language than the one chosen now.
  const otherLang =
    !!job &&
    job.status !== "running" &&
    job.status !== "idle" &&
    !!job.file &&
    !job.live &&
    !job.imported &&
    sourceLang !== videoLang;
  // A finished transcript made with another model than the one chosen now.
  const otherModel =
    job &&
    job.status !== "running" &&
    job.status !== "idle" &&
    job.file &&
    !job.imported &&
    job.model !== model
      ? modelInfo(job.model)
      : null;
  // A transcription in progress: switching model or provider would abort it.
  const engineBusy =
    job?.status === "running" ||
    punct.phase === "run" ||
    punct.phase === "download";
  const modelProps = {
    value: model,
    onChange: setModel,
    gpuReason,
    locked: engineBusy,
    lang: videoLang,
    cached: cachedModels,
    offline,
  };
  // When offline and the selected model is not cached, switch to one that is.
  useEffect(() => {
    if (!offline || engineBusy || cachedModels.has(model)) return;
    const fallback = MODELS.find(
      (m) =>
        cachedModels.has(m.id) &&
        m.langs.includes(videoLang) &&
        !(m.gpuOnly && gpuReason),
    );
    if (fallback) {
      setModel(fallback.id);
      setNotice(
        `Çevrimdışısın; bu tarayıcıda hazır olan ${fallback.name} modeline geçildi.`,
      );
    }
  }, [
    offline,
    engineBusy,
    cachedModels,
    model,
    videoLang,
    gpuReason,
    setModel,
  ]);
  const providerProps = {
    value: provider,
    engine,
    onChange: setProvider,
    cpuUnavailable: chosen.gpuOnly
      ? `${chosen.name} işlemcide çalışmaz; önce Seda'ya geç.`
      : null,
    gpuUnavailable: chosen.cpuOnly
      ? `${chosen.name} yalnızca işlemcide çalışır.`
      : null,
    locked: engineBusy,
  };
  const openTextDub = () => {
    setInspectorTab("dub");
    requestAnimationFrame(() => {
      textRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      textRef.current?.focus();
    });
  };
  const goLiveRef = useRef<() => Promise<void>>(async () => {});
  const goLive = async () => {
    setNotice(null);
    resetBurn();
    if (micBlocked) return;
    setSettings(forNewProject);
    setCrop(null);
    setTrim(null);
    setJumpCut(offJumpCut());
    try {
      // The microphone goes through Seda, which knows only Turkish.
      await startLive(optionsFor(method, "tr"));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  goLiveRef.current = goLive;

  return (
    <div
      data-dragging={dragging || undefined}
      className="group/shell grid h-full grid-rows-[46px_minmax(0,1fr)_64px_26px] max-[860px]:flex max-[860px]:h-auto max-[860px]:min-h-full max-[860px]:flex-col max-[860px]:*:flex-none"
    >
      {/* On phones only the title may shrink; buttons keep their size. */}
      <header className="flex items-center gap-2 border-b border-line-soft bg-pane pr-3 pl-3.5 select-none max-[860px]:h-11 max-[860px]:gap-1.5 max-[860px]:px-2.5 max-[860px]:*:shrink-0">
        <h1 className="m-0 mr-2.5 flex items-center max-[480px]:mr-1">
          {/* The mobile header has no room for the wordmark; show the H mark. */}
          {/* "-light" is the version for dark backgrounds. */}
          <picture className="light:hidden">
            <source
              media="(max-width: 860px)"
              srcSet={`${import.meta.env.BASE_URL}brand/harfiyen-mark-light.png`}
            />
            <img
              className="block h-5 w-auto drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]"
              src={`${import.meta.env.BASE_URL}brand/harfiyen-logo-light.png`}
              alt="Harfiyen"
            />
          </picture>
          <picture className="hidden light:block">
            <source
              media="(max-width: 860px)"
              srcSet={`${import.meta.env.BASE_URL}brand/harfiyen-mark.png`}
            />
            <img
              className="block h-5 w-auto"
              src={`${import.meta.env.BASE_URL}brand/harfiyen-logo.png`}
              alt="Harfiyen"
            />
          </picture>
        </h1>
        <a
          className="-ml-1.5 mr-2 text-[11px] tabular-nums text-fg-3 no-underline hover:text-fg-2 max-[480px]:hidden"
          href="https://github.com/ozcancelik/harfiyen/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noopener noreferrer"
          title="Bu sürümde neler var"
        >
          v{__APP_VERSION__}
        </a>
        <button
          className={toolbarButton({ compact: true })}
          onClick={pickFile}
          title="Dosya aç"
        >
          <IconOpen /> <TbLabel>Dosya aç</TbLabel>
        </button>
        <ProjectsMenu
          projects={saved}
          currentId={current?.id}
          canExport={saveable}
          onOpen={openProject}
          onDelete={deleteProject}
          onNew={newProject}
          onExport={exportProject}
          onImport={pickFile}
        />
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
        <ProjectName
          key={current?.id}
          title={title}
          onRename={current ? (n) => rename(current.id, n) : undefined}
        />
        {job && (
          <ExportMenu
            words={exportWords}
            speakers={speakers?.names}
            baseName={exportName}
            videoName={`${exportName}${videoSuffix}`}
            captions={!settings.hidden}
            kinetic={!!settings.kinetic?.on}
            photo={photo && shownPhoto(settings, true) ? (photoImage?.kind ?? "image") : null}
            meta={{
              file: title,
              model: modelInfo(job.model).spec,
              ...(job.model === "seda" && { method: job.options.method }),
            }}
            complete={job.status === "done"}
            // A video used for its sound comes out as an audio file's does.
            isVideo={player.isVideo && settings.picture !== "hidden"}
            canBurn={!!job.file}
            burn={burner.state}
            output={videoOutput}
            onOutput={changeOutput}
            source={exportSource}
            onBurn={burnVideo}
            onCancelBurn={burner.cancel}
            onResetBurn={burner.reset}
          />
        )}
        {/* Phones fold the model, provider and settings into "⋯"; GitHub is in Ayarlar → Hakkında. */}
        <div className="max-[480px]:hidden">
          <ModelMenu {...modelProps} />
        </div>
        <div className="max-[480px]:hidden">
          <ProviderMenu {...providerProps} />
        </div>
        <button
          className={`${toolbarButton({ compact: true })} max-[480px]:hidden`}
          onClick={() => setSettingsOpen(true)}
          title="Ayarlar"
        >
          <IconSettings /> <TbLabel>Ayarlar</TbLabel>
        </button>
        <a
          className={`${toolbarButton({ compact: true })} max-[480px]:hidden`}
          href="https://github.com/ozcancelik/harfiyen"
          target="_blank"
          rel="noopener noreferrer"
          title="Kaynak kodu GitHub'da"
        >
          <IconGitHub /> <TbLabel>GitHub</TbLabel>
        </a>
        <div className="hidden max-[480px]:block">
          <MoreMenu
            model={modelProps}
            provider={providerProps}
            onSettings={() => setSettingsOpen(true)}
          />
        </div>
      </header>
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <div className="grid min-h-0 grid-cols-[minmax(260px,340px)_minmax(0,1fr)_312px] max-[1100px]:grid-cols-[minmax(220px,280px)_minmax(0,1fr)_280px] max-[860px]:contents">
        <Pane side="left" label="Transkript">
          <PaneHead>
            <PaneTitle>Transkript</PaneTitle>
            {!translation && job && (
              <span
                className="mr-auto rounded-[4px] bg-well px-1.5 py-0.5 text-[10.5px] font-semibold tracking-[0.02em] text-fg-3"
                title={`${LANG_NAMES[sourceLang]} transkript`}
              >
                {sourceLang.toUpperCase()}
              </span>
            )}
            {translation && (
              <span
                className="mr-auto -my-1 flex gap-0.5 rounded-md border border-line-soft bg-well p-0.5"
                role="group"
                aria-label="Gösterilen dil"
              >
                {[
                  {
                    en: false,
                    label: sourceLang.toUpperCase(),
                    title: `${LANG_NAMES[sourceLang]} transkript`,
                  },
                  {
                    en: true,
                    label: translation.lang.toUpperCase(),
                    title: `${LANG_NAMES[translation.lang]} çeviri`,
                  },
                ].map((o) => (
                  <button
                    key={o.label}
                    className={LANG_BTN}
                    aria-pressed={translated === o.en}
                    title={o.title}
                    disabled={job?.status === "running"}
                    onClick={() => setShowEn(o.en)}
                  >
                    {o.label}
                  </button>
                ))}
              </span>
            )}
            {job && liveWords.length > 0 && (
              <PaneMeta>{liveWords.length} kelime</PaneMeta>
            )}
            {(canUndo || editable) && (
              <span className="-my-1 -mr-1 flex gap-0.5 self-center">
                {canAlign && (
                  <IconButton
                    className={aligning ? "bg-line text-fg" : ""}
                    onClick={() => setAligning(!aligning)}
                    aria-pressed={aligning}
                    title="Metni sese hizala: şarkı sözü, konuşma metni ya da şiir yapıştır"
                    aria-label="Metni sese hizala"
                  >
                    <IconAlignText />
                  </IconButton>
                )}
                {editable && (
                  <IconButton
                    className={found ? "bg-line text-fg" : ""}
                    onClick={found ? closeFind : showFind}
                    aria-pressed={!!found}
                    title="Bul ve değiştir (⌘F)"
                    aria-label="Bul ve değiştir"
                  >
                    <IconSearch />
                  </IconButton>
                )}
                {canUndo && (
                  <IconButton
                    onClick={undo}
                    title="Geri al (⌘Z)"
                    aria-label="Son düzenlemeyi geri al"
                  >
                    <IconUndo />
                  </IconButton>
                )}
              </span>
            )}
          </PaneHead>
          {aligning && canAlign && (
            <AlignBar
              text={alignDraft}
              onText={setAlignDraft}
              lang={sourceLang}
              refineIssue={refineIssue}
              progress={alignProgress}
              playback={job?.file ? tapPlayback : null}
              onAlign={onAlign}
              onTaps={onTaps}
              onClose={() => setAligning(false)}
            />
          )}
          {found && (
            <FindBar
              find={find}
              words={shown}
              onReplace={commitWords}
              onGo={(m) => player.seek(shown[m.first].start)}
            />
          )}
          {(otherModel || otherLang) && job && (
            <div className="flex flex-none items-center gap-2.5 border-b border-line-soft bg-cini-wash px-3.5 py-2 text-[12px] text-fg-2">
              <span className="min-w-0 flex-1">
                Bu döküm {modelInfo(job.model).name} ile
                {otherLang && `, ${LANG_NAMES[sourceLang]} olarak`} yapıldı.
              </span>
              <Button
                variant="primary"
                className="flex-none"
                disabled={!!langIssue}
                title={langIssue ?? undefined}
                onClick={transcribeJob}
              >
                {chosen.name} ile {otherLang && `${LANG_NAMES[videoLang]} `}
                yeniden dök
              </Button>
            </div>
          )}
          <PaneBody>
            {job?.status === "idle" ? (
              <div className="grid gap-3 px-3.5 py-4">
                <p className="m-0 text-[12.5px] leading-[1.6] text-fg-2">
                  {job.file
                    ? "Yazıya dökmeden önce istersen kadrajı ayarla ve kullanacağın bölümü seç: zaman çizelgesinin sonundaki Kes düğmesine bas, iki ucu sürükle ve Tamam de (oynatırken I ve O tuşları da olur). Yalnızca seçili bölüm dökülür."
                    : "Bu proje henüz yazıya dökülmedi. Önce medya dosyasını seç."}
                </p>
                {job.file && (
                  <p className="m-0 text-[12px] text-fg-3 tabular-nums">
                    {trim
                      ? `Seçili bölüm ${clock(trim.start)} – ${clock(trim.end)}, ${fmtDuration(trim.end - trim.start)}`
                      : `Dosyanın tamamı${player.duration ? `, ${fmtDuration(player.duration)}` : ""}`}
                  </p>
                )}
                {job.file && (
                  <VideoLang value={videoLang} onChange={chooseVideoLang} />
                )}
                {job.file && langIssue && (
                  <p className="m-0 text-[12px] leading-normal text-mercan-text">
                    {langIssue}
                  </p>
                )}
                <Button
                  variant="primary"
                  className="justify-self-start"
                  disabled={!job.file || !!langIssue}
                  onClick={transcribeJob}
                >
                  {trim ? "Seçili bölümü yazıya dök" : "Yazıya dök"}
                </Button>
              </div>
            ) : job ? (
              <Transcript
                words={shown}
                tentative={translated ? [] : job.tentative}
                lang={lang}
                running={job.status === "running"}
                waiting={
                  job.status === "running" &&
                  !job.live &&
                  engine.phase !== "ready" &&
                  engine.phase !== "error"
                }
                time={player.time}
                playing={player.playing}
                onSeek={player.seek}
                onEdit={editable ? onEdit : undefined}
                onRetime={editable ? onRetime : undefined}
                onShift={editable ? onShiftSpan : undefined}
                found={found}
                speakerNames={speakers?.names}
                onSpeaker={editable ? onSpeaker : undefined}
                jumpCut={jumpCut}
                spanStart={span.start}
                onToggleWords={canCutFromText ? onToggleWords : undefined}
                onToggleGap={canCutFromText ? onToggleGap : undefined}
                onToggleAllFillers={canCutFromText ? onToggleAllFillers : undefined}
                onToggleAllGaps={canCutFromText ? onToggleAllGaps : undefined}
                cutSummary={jumpCutSummary}
              />
            ) : (
              <EmptyNote>
                Bir dosya açtığında konuşmalar burada, zaman kodlarıyla birlikte
                belirir.
              </EmptyNote>
            )}
          </PaneBody>
        </Pane>

        {/* On phones the empty state grows to fit the welcome text instead of clipping it. */}
        <main className="flex min-h-0 min-w-0 bg-bg p-3.5 max-[860px]:order-1 max-[860px]:h-[56vw] max-[860px]:min-h-[220px] max-[860px]:has-data-dropzone:h-auto max-[480px]:p-2.5">
          <Viewer
            player={player}
            words={captionWords}
            settings={settings}
            speakers={captionSpeakers}
            liveTime={job?.live && !job.file ? job.decoded : null}
            following={following}
            crop={crop}
            onCrop={changeCrop}
            cropLocked={burner.state.status === "running"}
            logo={logo}
            photo={photo}
            photoVideo={photoVideoUrl}
            size={outputSize}
            bands={job?.bands ?? EMPTY_BANDS}
            loudness={
              (!translated && (!dubTimed || ownFileIsDub) && job?.loudness) ||
              EMPTY_BANDS
            }
            lang={lang}
            liveLevels={liveLevels}
            notice={
              badCodec &&
              `Bu video ${badCodec} ile kodlanmış ve bu tarayıcı onu oynatamıyor. Chrome'da açabilir ya da videoyu H.264 olarak kaydedip yükleyebilirsin. Yazıya döküm ve altyazı dosyaları bundan etkilenmez.`
            }
          >
            {needsMedia ? (
              <Dropzone
                title={
                  dragging
                    ? "Bırak, bağlayalım"
                    : pendingHandle
                      ? "Video hazır, bir tık kaldı"
                      : "Medya dosyasını seç"
                }
                text={
                  pendingHandle
                    ? "Transkript ve stil geri yüklendi. Tarayıcı, kayıtlı dosyayı yeniden açmak için senin onayını istiyor."
                    : current?.media
                      ? "Transkript ve stil geri yüklendi. Oynatmak ve altyazılı video oluşturmak için dosyayı yeniden seç; kelime zamanları korunur."
                      : "Altyazı yüklendi. Oynatmak ve altyazılı video oluşturmak için video ya da ses dosyasını seç."
                }
                actions={
                  pendingHandle ? (
                    <>
                      <Button
                        variant="primary"
                        size="lg"
                        className={DROP_BTN}
                        onClick={allowHandle}
                        title={pendingHandle.name}
                      >
                        “{pendingHandle.name}” dosyasını aç
                      </Button>
                      <Button size="lg" className={DROP_BTN} onClick={pickFile}>
                        Başka dosya seç
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="primary"
                      size="lg"
                      className={DROP_BTN}
                      onClick={pickFile}
                      title={current?.media?.name}
                    >
                      {current?.media
                        ? `“${current.media.name}” dosyasını seç`
                        : "Dosyayı seç"}
                    </Button>
                  )
                }
                fine="Dosyayı pencereye de sürükleyebilirsin."
              />
            ) : (
              <Dropzone
                title={
                  dragging ? "Bırak, başlayalım" : "Video ya da ses dosyası aç"
                }
                text="Konuşmayı yazıya döker, çevirir, seslendirir ve altyazıyı videonun içine yazar. Türkçe ve İngilizce desteklenir. Her şey bu bilgisayarda, ekran kartında çalışır; dosyan hiçbir yere gönderilmez."
                actions={
                  <>
                    <Button
                      variant="primary"
                      size="lg"
                      className={DROP_BTN}
                      onClick={pickFile}
                    >
                      Dosya aç
                    </Button>
                    {liveWaiting ? (
                      <Button
                        size="lg"
                        className={DROP_BTN}
                        onClick={stopLive}
                        title="Kayıt beklemesini iptal et"
                      >
                        Model hazırlanıyor, iptal et
                      </Button>
                    ) : (
                      <Button
                        size="lg"
                        className={DROP_BTN}
                        onClick={goLive}
                        disabled={!!micBlocked}
                        title={micBlocked ?? undefined}
                      >
                        <IconMic /> Mikrofonla başla
                      </Button>
                    )}
                    <Button
                      size="lg"
                      className={DROP_BTN}
                      onClick={openTextDub}
                    >
                      <IconSound /> Metin seslendir
                    </Button>
                  </>
                }
                fine={
                  <>
                    Dosyayı pencereye sürükleyebilirsin: MP4, MOV, MKV, WebM,
                    MP3, M4A, WAV, FLAC, OGG; altyazı için SRT ve VTT.{" "}
                    {cachedModels.has(model) ? (
                      <>
                        {chosen.name} modeli bu tarayıcıda hazır; internet
                        olmadan da çalışır.
                      </>
                    ) : offline ? (
                      <>
                        Çevrimdışısın ve {chosen.name} modeli henüz
                        indirilmemiş. Modeller bir kez indirildikten sonra
                        internet olmadan çalışır.
                      </>
                    ) : (
                      <>
                        İlk kullanımda yaklaşık {chosen.size} model (
                        {chosen.name}) indirilir ve saklanır.
                        {engine.phase === "idle" && (
                          <>
                            {" "}
                            <LinkButton onClick={prepare}>
                              Şimdi indir
                            </LinkButton>
                          </>
                        )}
                      </>
                    )}
                  </>
                }
              >
                {!job && saved.length > 0 && (
                  <div className="mt-2.5 grid w-full gap-0.5 border-t border-line pt-3 text-left">
                    <MenuTitle>Son projeler</MenuTitle>
                    <ProjectList
                      projects={saved}
                      onOpen={openProject}
                      onDelete={deleteProject}
                      limit={3}
                    />
                  </div>
                )}
              </Dropzone>
            )}
          </Viewer>
        </main>

        <Inspector
          settings={settings}
          ground={ground}
          onSettings={changeSettings}
          burning={burner.state.status === "running"}
          model={model}
          method={method}
          onMethod={setMethod}
          job={job}
          engine={engine}
          onRestart={transcribeJob}
          onResume={resumeJob}
          autoPunct={autoPunct}
          onAutoPunct={setAutoPunct}
          onPunctuate={applyPunct}
          numberMode={numberMode}
          onNumberMode={setNumberMode}
          onNumbers={applyNumbers}
          punctBusy={punct.phase === "run" || punct.phase === "download"}
          onCancel={cancel}
          dub={dubber.state}
          dubStale={dubStale}
          canDub={editable && !!job?.file && dubWords.length > 0}
          onDub={() => startDub(dubWords)}
          onCancelDub={dubber.cancel}
          dubOn={dubOn}
          onDubOn={setDubOn}
          dubOriginal={dubOriginal}
          onDubOriginal={setDubOriginal}
          onDubOverflow={() => {
            if (!dubOverflow) return;
            // The line as it is read: in the translation for an English dub.
            setShowEn(voice.lang !== sourceLang);
            player.seek(dubOverflow.start);
          }}
          onExtendTrim={longerTrim && (() => changeTrim(longerTrim))}
          dubName={`${voice.lang === "tr" ? name : `${name}.${voice.lang}`}.seslendirme.wav`}
          voice={voice}
          onVoice={setVoice}
          preview={dubber.preview}
          onListen={() =>
            dubber.listen(
              dubWords,
              voice,
              dubBySentence(voice.lang, sourceLang),
              textMode && (!isTts || voice.lang === sourceLang)
                ? customText
                : undefined,
            )
          }
          translate={translator.state}
          translation={!!translation}
          translationLang={translation?.lang ?? null}
          sourceLang={sourceLang}
          videoLang={videoLang}
          onVideoLang={chooseVideoLang}
          langIssue={langIssue}
          captionLang={lang}
          onShiftAll={editable ? onShiftAll : null}
          jumpCut={jumpCut}
          onJumpCut={changeJumpCut}
          jumpCutUnavailable={jumpCutUnavailable}
          jumpCutSummary={jumpCutSummary}
          hasManualCuts={hasManualCuts}
          onRestoreManualCuts={canCutFromText ? onRestoreManualCuts : undefined}
          speakers={{
            speakers,
            state: speakerTool.state,
            unavailable: speakersUnavailable,
            onRun: runSpeakers,
            onCancel: speakerTool.cancel,
            onRename: (i, name) =>
              speakers && commitSpeakers(renameSpeaker(speakers, i, name)),
            onMerge: (from, into) =>
              speakers && commitSpeakers(mergeSpeakers(speakers, from, into)),
            onClear: () => commitSpeakers(undefined),
          }}
          translationStale={translationStale}
          targetLang={targetLang}
          onTargetLang={setTargetPick}
          canTranslate={!!job && job.status !== "running" && words.length > 0 && hasTranslation(sourceLang)}
          onTranslate={() => translate()}
          onCancelTranslate={translator.cancel}
          canTranslateDub={editable && !!job?.file && words.length > 0 && hasTranslation(sourceLang)}
          onTranslateDub={() => translate((t) => startDub(t.words), voice.lang)}
          tab={inspectorTab}
          onTab={setInspectorTab}
          textMode={textMode}
          customText={customText}
          onCustomText={setCustomText}
          textRef={textRef}
          audioOnly={!player.isVideo}
        />
      </div>

      <div className="flex items-center gap-2 border-t border-line-soft bg-pane px-3.5 max-[860px]:order-2 max-[860px]:flex-wrap max-[860px]:gap-y-1 max-[860px]:px-2.5 max-[860px]:pt-2.5 max-[860px]:pb-1.5">
        <RecordButton
          recording={!!job?.recording}
          waiting={liveWaiting}
          onStart={goLive}
          disabledReason={micBlocked}
          onStop={stopLive}
        />
        <span className="mx-1 h-[22px] w-px flex-none bg-line" aria-hidden />
        <button
          className={TP_BTN}
          onClick={player.toggle}
          disabled={!job || job.recording}
          aria-label={player.playing ? "Duraklat" : "Oynat"}
        >
          {player.playing ? <IconPause /> : <IconPlay />}
        </button>
        <span className="min-w-24 flex-none text-[12px] text-fg-3 tabular-nums [font-feature-settings:'tnum'_1] max-[860px]:min-w-0 max-[860px]:flex-1 max-[860px]:text-[13px]">
          <strong className="font-semibold text-fg">
            {clock(player.time)}
          </strong>{" "}
          / {clock(player.duration || job?.duration || 0)}
        </span>
        <div className="group/vol relative flex flex-none items-center">
          <button
            className={TP_BTN}
            onClick={() => {
              if (player.muted || player.volume === 0) {
                player.setMuted(false);
                if (player.volume === 0) player.setVolume(1);
              } else player.setMuted(true);
            }}
            disabled={!job || job.recording}
            aria-label={
              player.muted || player.volume === 0 ? "Sesi aç" : "Sesi kapat"
            }
          >
            {player.muted || player.volume === 0 ? <IconMuted /> : <IconSound />}
          </button>
          {job && !job.recording && (
            <div className="pointer-events-none invisible absolute bottom-full left-1/2 z-20 -translate-x-1/2 translate-y-1 pb-1.5 opacity-0 transition-all duration-150 ease-out group-focus-within/vol:pointer-events-auto group-focus-within/vol:visible group-focus-within/vol:translate-y-0 group-focus-within/vol:opacity-100 group-hover/vol:pointer-events-auto group-hover/vol:visible group-hover/vol:translate-y-0 group-hover/vol:opacity-100">
              <div className="flex h-28 w-8 items-center justify-center rounded-[10px] border border-popover-line bg-popover shadow-[0_12px_28px_var(--shadow-pop),0_0_0_1px_var(--tint)] backdrop-blur-[16px]">
                <input
                  type="range"
                  className="slider m-0 h-[18px] w-20 flex-none -rotate-90"
                  min={0}
                  max={1}
                  step={0.01}
                  value={player.muted ? 0 : player.volume}
                  aria-label="Ses düzeyi"
                  title={`Ses: %${Math.round((player.muted ? 0 : player.volume) * 100)}`}
                  onChange={(e) => player.setVolume(Number(e.target.value))}
                />
              </div>
            </div>
          )}
        </div>
        {job ? (
          <Timeline
            peaks={wave ?? job.peaks}
            duration={player.duration || job.duration || 0}
            decoded={job.status === "idle" ? 0 : job.decoded}
            doneFrom={job.range?.start ?? 0}
            time={player.time}
            media={player.el}
            cues={groups}
            live={job.recording ? liveMeter.current : null}
            onSeek={player.seek}
            range={trimming ? trimDraft : trim}
            onRange={trimming ? setTrimDraft : undefined}
            cuts={cuts}
          />
        ) : (
          <div className={TIMELINE} />
        )}
        {job && !job.live && trimming ? (
          <div className="ml-2 flex flex-none items-center gap-1.5 max-[860px]:ml-auto">
            {/* As wide as the whole file's range (an invisible copy): text of another length would
                resize the timeline under the dragged handle. */}
            <span className="grid text-right text-[12px] text-fg-3 tabular-nums max-[1100px]:hidden">
              <span className="invisible col-start-1 row-start-1" aria-hidden>
                {`${clock(0)} – ${clock(fileDuration)}, ${fmtDuration(fileDuration)}`}
              </span>
              <span className="col-start-1 row-start-1">
                {trimDraft && !draftWhole
                  ? `${clock(trimDraft.start)} – ${clock(trimDraft.end)}, ${fmtDuration(trimDraft.end - trimDraft.start)}`
                  : "Tamamı"}
              </span>
            </span>
            {/* Always there, so the timeline keeps its width while a handle is dragged. */}
            <Button onClick={() => setTrimDraft(null)} disabled={draftWhole}>
              Sıfırla
            </Button>
            <Button onClick={() => setTrimming(false)}>Vazgeç</Button>
            <Button variant="primary" onClick={finishTrimming}>
              Tamam
            </Button>
          </div>
        ) : (
          job &&
          !job.live && (
            <button
              className={`${TP_BTN} relative ml-1`}
              onClick={startTrimming}
              disabled={trimLocked}
              aria-label="Kes"
              title={
                trim
                  ? `Kesilen bölüm ${clock(trim.start)} – ${clock(trim.end)}; değiştirmek için tıkla`
                  : "Kes: videonun kullanılacak bölümünü seç (I ve O tuşları da olur)"
              }
            >
              <IconScissors />
              {/* A part is cut out. */}
              {trim && (
                <span
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-firuze"
                  aria-hidden
                />
              )}
            </button>
          )
        )}
      </div>

      <StatusBar
        engine={engine}
        job={job}
        burn={burner.state}
        notice={notice}
        punct={punct}
        liveWaiting={liveWaiting}
        onStop={cancel}
        onDiscard={discardJob}
        onResume={resumeJob}
      />
      <UpdateToast busy={engineBusy} />
    </div>
  );
}
