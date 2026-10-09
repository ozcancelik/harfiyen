// Microphone capture: raw PCM chunks for the recognizer (AudioWorklet) and a
// compressed recording of the same stream (MediaRecorder) for playback and
// export afterwards.

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10); // ~100 ms
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      const k = ch.length;
      const frames = ch[0].length;
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < k; c++) s += ch[c][i];
        this.buf[this.n++] = s / k;
        if (this.n === this.size) {
          // Transferring detaches buf (its length becomes 0), hence this.size.
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("harfiyen-tap", Tap);
`;

export class MicError extends Error {}

export interface Microphone {
  sampleRate: number;
  /** Stop capturing; resolves with the recording (null if the recorder failed). */
  stop(): Promise<File | null>;
}

function recordingName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Kayıt ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

export async function startMicrophone(onChunk: (pcm: Float32Array) => void): Promise<Microphone> {
  if (!navigator.mediaDevices?.getUserMedia) throw new MicError("Bu tarayıcı mikrofon erişimini desteklemiyor.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError") throw new MicError("Mikrofon izni verilmedi. Adres çubuğundaki izinlerden açabilirsin.");
    if (name === "NotFoundError") throw new MicError("Bağlı bir mikrofon bulunamadı.");
    throw new MicError(`Mikrofon açılamadı (${name ?? e}).`);
  }

  const ctx = new AudioContext();
  // Started after waiting for the model, i.e. outside the click; some
  // browsers then create the context suspended.
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "harfiyen-tap", { numberOfOutputs: 0 });
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data);
  source.connect(tap);

  const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  let recorder: MediaRecorder | null = null;
  const parts: Blob[] = [];
  try {
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data);
    recorder.start(1000);
  } catch {
    recorder = null; // live captions still work without a recording
  }

  return {
    sampleRate: ctx.sampleRate,
    async stop() {
      const done = recorder
        ? new Promise<void>((r) => {
            recorder!.onstop = () => r();
            recorder!.stop();
          })
        : Promise.resolve();
      await done;
      source.disconnect();
      tap.port.onmessage = null;
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      if (!recorder || !parts.length) return null;
      const mime = recorder.mimeType || "audio/webm";
      const ext = mime.includes("mp4") ? "m4a" : "webm";
      return new File(parts, `${recordingName()}.${ext}`, { type: mime.split(";")[0] });
    },
  };
}
