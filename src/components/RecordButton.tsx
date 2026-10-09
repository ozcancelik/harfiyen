import { useEffect, useState } from "react";
import { clock } from "../lib/format";

/** Transport-bar record control; shows the elapsed time while recording. */
export function RecordButton({
  recording,
  onStart,
  onStop,
}: {
  recording: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const [since, setSince] = useState(0);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!recording) return;
    const t0 = Date.now();
    setSince(t0);
    setNow(t0);
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [recording]);

  return recording ? (
    <button className="rec-btn rec-btn--on" onClick={onStop} title="Kaydı durdur (R)" aria-label="Kaydı durdur">
      <span className="rec-btn__stop" aria-hidden />
      <span className="rec-btn__time">{clock((now - since) / 1000)}</span>
    </button>
  ) : (
    <button className="rec-btn" onClick={onStart} title="Mikrofondan kaydet (R)" aria-label="Mikrofondan kaydet">
      <span className="rec-btn__dot" aria-hidden />
    </button>
  );
}
