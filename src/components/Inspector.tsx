import { useState } from "react";
import type { CaptionSettings } from "../captions/style";
import type { DecodingMethod } from "../engine";
import type { EngineState, Job } from "../lib/useTranscriber";
import { CaptionStudio } from "./CaptionStudio";
import { MethodPicker, methodTitle } from "./MethodPicker";

type Tab = "captions" | "transcribe";

export function Inspector({
  settings,
  onSettings,
  burning,
  method,
  onMethod,
  job,
  engine,
  onRestart,
  onCancel,
  autoPunct,
  onAutoPunct,
  onPunctuate,
  punctBusy,
}: {
  settings: CaptionSettings;
  onSettings: (s: CaptionSettings) => void;
  burning: boolean;
  method: DecodingMethod;
  onMethod: (m: DecodingMethod) => void;
  job: Job | null;
  engine: EngineState;
  onRestart: () => void;
  onCancel: () => void;
  autoPunct: boolean;
  onAutoPunct: (on: boolean) => void;
  onPunctuate: () => void;
  punctBusy: boolean;
}) {
  const [tab, setTab] = useState<Tab>("captions");
  const running = job?.status === "running";

  return (
    <aside className="pane inspector">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "captions"} onClick={() => setTab("captions")}>
          Altyazı
        </button>
        <button role="tab" aria-selected={tab === "transcribe"} onClick={() => setTab("transcribe")}>
          Yazıya döküm
        </button>
      </div>
      <div className="scroll pane__body">
        {tab === "captions" ? (
          <CaptionStudio settings={settings} onChange={onSettings} disabled={burning} />
        ) : (
          <div className="studio">
            <section className="section">
              <h3 className="section__title">Doğruluk</h3>
              <MethodPicker value={method} onChange={onMethod} disabled={running} />
              {job && (
                <div className="section__actions">
                  {running ? (
                    <button className="btn" onClick={onCancel}>
                      Durdur
                    </button>
                  ) : (
                    <button className="btn btn--primary" onClick={onRestart}>
                      {method === job.options.method ? "Yeniden yazıya dök" : `${methodTitle(method)} ile yeniden dök`}
                    </button>
                  )}
                </div>
              )}
            </section>
            <section className="section">
              <h3 className="section__title">Noktalama ve büyük harf</h3>
              <label className="row">
                <span className="row__label row__label--wide">Otomatik ekle</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={autoPunct}
                  onChange={(e) => onAutoPunct(e.target.checked)}
                />
              </label>
              <p className="hint">
                Yazıya döküm bitince nokta, virgül ve soru işareti eklenir; cümle başları ve özel adlar büyük harfle
                yazılır ("İstanbul'da"). ⌘Z ile geri alınır. İlk kullanımda yaklaşık 60 MB model indirilir.
              </p>
              {job && (
                <div className="section__actions">
                  <button className="btn" disabled={running || punctBusy || !job.words.length} onClick={onPunctuate}>
                    {punctBusy ? "Ekleniyor…" : "Şimdi uygula"}
                  </button>
                </div>
              )}
            </section>
            <section className="section">
              <h3 className="section__title">Model</h3>
              <dl className="facts">
                <dt>Model</dt>
                <dd>
                  <a href="https://huggingface.co/atasoglu/seda-v0.1">seda-v0.1</a>, Türkçe
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
              <p className="hint">
                Sayılar yazıyla gelir ("bin dokuz yüz yirmi üç"). Bir kelimeye tıklayınca kayıt o ana atlar.
              </p>
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}
