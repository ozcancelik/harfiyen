import { useMemo, useState, type ComponentProps, type RefObject } from "react";
import type { CaptionSettings } from "../captions/style";
import type { JumpCut } from "../lib/cuts";
import type { GroundPreview } from "../lib/groundPreview";
import type { DecodingMethod, SpeechLang } from "../engine";
import { LANG_NAMES } from "../lib/lang";
import { writeNumbers, type NumberMode } from "../lib/numbers";
import type { DubState, PreviewState, Voice } from "../lib/useDubber";
import type { EngineState, Job } from "../lib/useTranscriber";
import { translateProgress, translationLang as targetOf, type TranslateState } from "../lib/useTranslator";
import { modelInfo, type ModelId } from "../models";
import { CaptionStudio, STUDIO } from "./CaptionStudio";
import { DubPanel } from "./DubPanel";
import { SceneStudio } from "./SceneStudio";
import { JumpCutSection, type JumpCutSummary } from "./JumpCutSection";
import { SpeakersSection } from "./SpeakersSection";
import { TimingSection } from "./TimingSection";
import { VideoLang } from "./VideoLang";
import { Progress } from "./Indicators";
import { MethodPicker, methodTitle } from "./MethodPicker";
import { OPT, OPT_NOTE, OPT_TEXT, OPT_TITLE, Select } from "./Select";
import {
  Button,
  Hint,
  Pane,
  PaneBody,
  Row,
  RowLabel,
  Section,
  SectionActions,
  Switch,
} from "./ui";

const TAB =
  "h-[26px] flex-1 rounded-[5px] border-0 bg-transparent text-[12px] font-medium tracking-[-0.01em] text-fg-2 transition-all duration-150 ease-[ease] hover:not-aria-selected:text-fg aria-selected:bg-raised aria-selected:font-[550] aria-selected:text-fg-strong aria-selected:shadow-[0_1px_3px_var(--shadow-pop),inset_0_1px_0_var(--tint)]";

export type InspectorTab = "captions" | "scene" | "transcribe" | "dub";

// Each option shows its result rather than its rule.
const NUMBER_MODES: { value: NumberMode; label: string; sample: string }[] = [
  {
    value: "rule",
    label: "Kurala göre",
    sample: "Saat 15.30'da 15 kişi geldi, üç kişi kaldı.",
  },
  {
    value: "all",
    label: "Hepsi rakamla",
    sample: "Saat 15.30'da 15 kişi geldi, 3 kişi kaldı.",
  },
  {
    value: "keep",
    label: "Dokunma",
    sample: "Sayılara dokunulmaz. Önceki düzenleme ⌘Z ile geri alınır.",
  },
];

export function Inspector({
  settings,
  ground,
  onSettings,
  burning,
  model,
  method,
  onMethod,
  job,
  engine,
  onRestart,
  onResume,
  onCancel,
  autoPunct,
  onAutoPunct,
  onPunctuate,
  punctBusy,
  numberMode,
  onNumberMode,
  onNumbers,
  dub,
  dubStale,
  canDub,
  onDub,
  onCancelDub,
  dubOn,
  onDubOn,
  dubOriginal,
  onDubOriginal,
  onDubOverflow,
  onExtendTrim,
  dubName,
  voice,
  onVoice,
  preview,
  onListen,
  translate,
  translation,
  translationLang,
  translationStale,
  canTranslate,
  onTranslate,
  onCancelTranslate,
  canTranslateDub,
  onTranslateDub,
  sourceLang,
  videoLang,
  onVideoLang,
  langIssue,
  onShiftAll,
  jumpCut,
  onJumpCut,
  jumpCutUnavailable,
  jumpCutSummary,
  hasManualCuts,
  onRestoreManualCuts,
  speakers,
  captionLang,
  tab: controlledTab,
  onTab,
  textMode,
  customText,
  onCustomText,
  textRef,
  audioOnly = false,
}: {
  settings: CaptionSettings;
  /** The project's ground, behind the style cards. */
  ground?: GroundPreview;
  onSettings: (s: CaptionSettings) => void;
  burning: boolean;
  model: ModelId;
  method: DecodingMethod;
  onMethod: (m: DecodingMethod) => void;
  job: Job | null;
  engine: EngineState;
  onRestart: () => void;
  /** Go on with a stopped transcription; missing when it cannot. */
  onResume?: () => void;
  onCancel: () => void;
  autoPunct: boolean;
  onAutoPunct: (on: boolean) => void;
  onPunctuate: () => void;
  punctBusy: boolean;
  numberMode: NumberMode;
  onNumberMode: (m: NumberMode) => void;
  onNumbers: () => void;
  dub: DubState;
  dubStale: boolean;
  canDub: boolean;
  onDub: () => void;
  onCancelDub: () => void;
  dubOn: boolean;
  onDubOn: (on: boolean) => void;
  /** How loud the file's own sound stays under the dub. */
  dubOriginal: number;
  onDubOriginal: (v: number) => void;
  /** Shows the line of the dub that runs past the end. */
  onDubOverflow: () => void;
  /** Lengthens the trim so the dub fits; null when that is not possible. */
  onExtendTrim: (() => void) | null;
  dubName: string;
  voice: Voice;
  onVoice: (v: Voice) => void;
  preview: PreviewState;
  onListen: () => void;
  translate: TranslateState;
  /** The job has a translation. */
  translation: boolean;
  /** The transcript changed after it was translated. */
  translationStale: boolean;
  canTranslate: boolean;
  onTranslate: () => void;
  onCancelTranslate: () => void;
  /** The dub needs the translation first: it is made, then read. */
  canTranslateDub: boolean;
  onTranslateDub: () => void;
  /** The language of the open transcript, and of its translation if there is one. */
  sourceLang: SpeechLang;
  translationLang: string | null;
  /** The language spoken in the media, for the next transcription. */
  videoLang: SpeechLang;
  onVideoLang: (l: SpeechLang) => void;
  /** Why the chosen model cannot transcribe `videoLang`, if it cannot. */
  langIssue: string | null;
  /** Moves every caption by `seconds`; null when there is nothing to move. */
  onShiftAll: ((seconds: number) => void) | null;
  jumpCut: JumpCut;
  onJumpCut: (j: JumpCut) => void;
  /** Why the quiet cannot be cut now; null when it can. */
  jumpCutUnavailable: string | null;
  jumpCutSummary: JumpCutSummary | null;
  hasManualCuts?: boolean;
  onRestoreManualCuts?: () => void;
  /** Telling who speaks when. */
  speakers: ComponentProps<typeof SpeakersSection>;
  /** The language of the captions shown. */
  captionLang: string;
  tab?: InspectorTab;
  onTab?: (t: InspectorTab) => void;
  textMode?: boolean;
  customText?: string;
  onCustomText?: (text: string) => void;
  textRef?: RefObject<HTMLTextAreaElement | null>;
  audioOnly?: boolean;
}) {
  const [innerTab, setInnerTab] = useState<InspectorTab>("captions");
  const tab = controlledTab ?? innerTab;
  const setTab = onTab ?? setInnerTab;
  const running = job?.status === "running";
  const translating = translateProgress(translate);
  const info = modelInfo(model);
  // Whisper punctuates by itself: the section is for Seda, or for a Seda transcript that is open.
  const sedaJob = !!job && !modelInfo(job.model).punctuates;
  const showPunct = !info.punctuates || sedaJob;
  // A dry run on the open transcript: how many words "Şimdi uygula" would change.
  const numberChanges = useMemo(() => {
    if (!job || job.status !== "done" || numberMode === "keep") return 0;
    const before = new Set(job.words);
    return writeNumbers(job.words, numberMode).filter((w) => !before.has(w))
      .length;
  }, [job, numberMode]);
  const otherLang = !!job && sourceLang !== videoLang;
  // What a new run would change: the language, the model, or (seda only) the method.
  const differs =
    job &&
    (otherLang ||
      model !== job.model ||
      (model === "seda" && method !== job.options.method));
  const restartLabel =
    job?.status === "idle"
      ? "Yazıya dök"
      : !differs
        ? "Yeniden yazıya dök"
        : otherLang
          ? `${LANG_NAMES[videoLang]} olarak yeniden dök`
          : model !== job.model
            ? `${info.name} ile yeniden dök`
            : `${methodTitle(method)} ile yeniden dök`;
  const numbersApply = sourceLang === "tr";
  const targetLang = targetOf(sourceLang);
  const mtModel = `opus-mt-tc-big-${sourceLang}-${targetLang}`;

  return (
    <Pane side="right">
      <div
        className="mx-3 mt-2.5 mb-1.5 flex gap-0.5 rounded-lg border border-line-soft bg-well p-0.75"
        role="tablist"
      >
        <button
          className={TAB}
          role="tab"
          aria-selected={tab === "captions"}
          onClick={() => setTab("captions")}
        >
          Altyazı
        </button>
        <button
          className={TAB}
          role="tab"
          aria-selected={tab === "scene"}
          onClick={() => setTab("scene")}
        >
          Sahne
        </button>
        <button
          className={TAB}
          role="tab"
          aria-selected={tab === "transcribe"}
          onClick={() => setTab("transcribe")}
        >
          Metin
        </button>
        <button
          className={TAB}
          role="tab"
          aria-selected={tab === "dub"}
          onClick={() => setTab("dub")}
        >
          Seslendirme
        </button>
      </div>
      <PaneBody>
        {tab === "captions" ? (
          <CaptionStudio
            settings={settings}
            ground={ground}
            onChange={onSettings}
            disabled={burning}
            lang={captionLang}
            onScene={() => setTab("scene")}
            speakerCount={speakers.speakers?.names.length}
          />
        ) : tab === "scene" ? (
          <SceneStudio
            settings={settings}
            ground={ground}
            onChange={onSettings}
            onCaptions={() => setTab("captions")}
            video={!audioOnly}
            disabled={burning}
          />
        ) : tab === "dub" ? (
          <DubPanel
            state={dub}
            stale={dubStale}
            canDub={canDub}
            busy={burning}
            onDub={onDub}
            onCancel={onCancelDub}
            on={dubOn}
            onOn={onDubOn}
            original={dubOriginal}
            onOriginal={onDubOriginal}
            onOverflow={onDubOverflow}
            onExtendTrim={onExtendTrim}
            fileName={dubName}
            voice={voice}
            onVoice={onVoice}
            preview={preview}
            onListen={onListen}
            translation={translation}
            translationLang={translationLang}
            sourceLang={sourceLang}
            translationStale={translationStale}
            translate={translate}
            canTranslateDub={canTranslateDub}
            onTranslateDub={onTranslateDub}
            onCancelTranslate={onCancelTranslate}
            textMode={textMode}
            customText={customText}
            onCustomText={onCustomText}
            textRef={textRef}
          />
        ) : (
          <div className={STUDIO}>
            <Section title="Dil">
              <VideoLang value={videoLang} onChange={onVideoLang} disabled={running} />
              {langIssue ? (
                <Hint>{langIssue}</Hint>
              ) : (
                <Hint>
                  Videoda konuşulan dil. İngilizceyi yalnızca Whisper anlar; İngilizce seçilince model Whisper'a geçer.
                </Hint>
              )}
            </Section>
            <TimingSection onShiftAll={onShiftAll} />
            <JumpCutSection
              value={jumpCut}
              onChange={onJumpCut}
              unavailable={jumpCutUnavailable}
              summary={jumpCutSummary}
              hasManualCuts={hasManualCuts}
              onRestoreManual={onRestoreManualCuts}
            />
            <SpeakersSection {...speakers} />
            <Section title="Doğruluk">
              {info.id === "seda" ? (
                <MethodPicker
                  value={method}
                  onChange={onMethod}
                  disabled={running}
                />
              ) : info.id === "mihu" ? (
                <Hint>
                  {info.name} sesi 0,32 saniyelik parçalarla çok yollu aramayla işler; kelimeler konuşurken gelir.
                  Model seçimi üst çubukta.
                </Hint>
              ) : (
                <Hint>
                  {info.name} sesi {info.engine === "duyu" ? "12–15" : "30"} saniyelik parçalar hâlinde işler;
                  kelimeler her parça bitince gelir. Model seçimi üst çubukta.
                </Hint>
              )}
              {job && (
                <SectionActions>
                  {running ? (
                    <Button onClick={onCancel}>Durdur</Button>
                  ) : onResume ? (
                    <>
                      <Button variant="primary" onClick={onResume}>
                        Devam et
                      </Button>
                      <Button disabled={!!langIssue} onClick={onRestart}>
                        {restartLabel}
                      </Button>
                    </>
                  ) : (
                    <Button variant="primary" disabled={!!langIssue} onClick={onRestart}>
                      {restartLabel}
                    </Button>
                  )}
                </SectionActions>
              )}
            </Section>
            {showPunct && (
              <Section title="Noktalama ve büyük harf">
                <Row>
                  <RowLabel wide>Otomatik ekle</RowLabel>
                  <Switch
                    checked={autoPunct}
                    onChange={(e) => onAutoPunct(e.target.checked)}
                  />
                </Row>
                <Hint>
                  Döküm bitince nokta, virgül ve soru işareti eklenir; cümle
                  başları ve özel adlar büyük harfle yazılır ("İstanbul'da"). ⌘Z
                  ile geri alınır. İlk kullanımda yaklaşık 30 MB model
                  indirilir.
                </Hint>
                {/* Not on a Whisper transcript: it would replace Whisper's own punctuation with a weaker one. */}
                {sedaJob && (
                  <SectionActions>
                    <Button
                      disabled={running || punctBusy || !job.words.length}
                      onClick={onPunctuate}
                    >
                      {punctBusy ? "Ekleniyor…" : "Şimdi uygula"}
                    </Button>
                  </SectionActions>
                )}
              </Section>
            )}
            {/* The number rules are Turkish. */}
            {numbersApply && (
              <Section title="Sayı yazımı">
                <Select<NumberMode>
                  label="Sayı yazımı"
                  value={numberMode}
                  options={NUMBER_MODES}
                  onChange={onNumberMode}
                  render={(o, inList) => (
                    <span className={OPT}>
                      <span className={OPT_TEXT}>
                        <span className={OPT_TITLE}>{o.label}</span>
                        {inList && (
                          <span className={OPT_NOTE}>
                            {
                              NUMBER_MODES.find((m) => m.value === o.value)!
                                .sample
                            }
                          </span>
                        )}
                      </span>
                    </span>
                  )}
                />
                <Hint>
                  {NUMBER_MODES.find((m) => m.value === numberMode)!.sample}
                  {numberMode !== "keep" &&
                    ' Döküm bitince her modelde uygulanır; tarih ve saat hep rakamla yazılır ("23 Nisan", "saat 15.30"). ⌘Z ile geri alınır.'}
                </Hint>
                {job && numberMode !== "keep" && (
                  <SectionActions>
                    <Button
                      disabled={running || !numberChanges}
                      onClick={onNumbers}
                    >
                      {running
                        ? "Şimdi uygula"
                        : numberChanges
                          ? `${numberChanges} sayıyı düzenle`
                          : "Değişecek sayı yok"}
                    </Button>
                  </SectionActions>
                )}
              </Section>
            )}
            <Section title={`${LANG_NAMES[targetLang]} çeviri`}>
              <Hint>
                Transkript cümle cümle {LANG_NAMES[targetLang]}ye çevrilir; her cümle aslının
                zamanında görünür. Transkriptin üstündeki {sourceLang.toUpperCase()} / {targetLang.toUpperCase()} ile
                altyazı, dışa aktarma ve video için dil seçilir; çeviri de düzenlenebilir. İlk kullanımda yaklaşık 360 MB
                model indirilir.
              </Hint>
              {translating && <Progress {...translating} />}
              {translate.status === "error" && (
                <Hint>Çevrilemedi: {translate.message}</Hint>
              )}
              {translation && translationStale && translate.status === "idle" && (
                <Hint>
                  Transkript çeviriden sonra değişti. Yeniden çevirirsen
                  çeviride yaptığın düzeltmeler gider (⌘Z ile geri gelir).
                </Hint>
              )}
              <SectionActions>
                {translating ? (
                  <Button onClick={onCancelTranslate}>Durdur</Button>
                ) : (
                  <Button
                    variant={translation && !translationStale ? "default" : "primary"}
                    disabled={!canTranslate || running}
                    onClick={onTranslate}
                  >
                    {translation ? "Yeniden çevir" : `${LANG_NAMES[targetLang]}ye çevir`}
                  </Button>
                )}
              </SectionActions>
              <Hint>
                <a href={`https://huggingface.co/Helsinki-NLP/${mtModel}`}>{mtModel}</a> (Helsinki-NLP, CC-BY 4.0), bu
                bilgisayarda çalışır. Yemek adları, özel adlar ve argo yanlış çevrilebilir; paylaşmadan önce göz at.
              </Hint>
            </Section>
            <Section title="Model">
              <dl className="m-0 grid grid-cols-[88px_1fr] gap-x-2.5 gap-y-1.5 text-[12.5px] [&_dd]:m-0 [&_dt]:text-fg-3">
                <dt>Model</dt>
                <dd>
                  <a href={info.link}>{info.spec}</a>
                  {info.engine === "seda"
                    ? ", Türkçe"
                    : info.engine === "duyu"
                      ? ", Türkçe ve İngilizce (Türkçe seçili)"
                      : ", çok dilli (Türkçe seçili)"}
                </dd>
                <dt>Çalıştığı yer</dt>
                <dd>
                  {engine.phase === "ready"
                    ? engine.provider === "webgpu"
                      ? `WebGPU${engine.gpu ? `, ${engine.gpu}` : ""}`
                      : "İşlemci (WASM)"
                    : "Henüz yüklenmedi"}
                </dd>
                <dt>Gizlilik</dt>
                <dd>Ses ve video bu bilgisayardan çıkmaz.</dd>
              </dl>
              <Hint>
                {info.engine === "seda" &&
                  'Sayılar yazıyla gelir ("bin dokuz yüz yirmi üç"). '}
                {info.id === "mihu" && "Powered by mihu. "}
                Bir kelimeye tıklayınca kayıt o ana atlar.
              </Hint>
            </Section>
          </div>
        )}
      </PaneBody>
    </Pane>
  );
}
