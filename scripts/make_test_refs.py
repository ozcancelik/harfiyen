"""Reference outputs for tests/engine.node.ts, produced with sherpa-onnx.

For every *.wav in DIR this writes <name>.greedy.json, <name>.beam.json and
<name>.lm.json (original int8 model, same settings as the model card), and
for the first file also <name>.feats.f32 (kaldi-native-fbank features).

    python scripts/make_test_refs.py DIR [--model .cache/seda-v0.1]

16 kHz mono 16-bit WAV files work best; a 44.1 kHz stereo file named
long.wav exercises the resampler and endpointing (it is compared against
the concatenated t1/t2 references).
"""

import argparse
import json
from pathlib import Path

import kaldi_native_fbank as knf
import numpy as np
import sherpa_onnx
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent


def recognizer(d: Path, method: str):
    kw = {"decoding_method": "greedy_search"}
    if method in ("beam", "lm"):
        kw = {"decoding_method": "modified_beam_search", "max_active_paths": 4}
    if method == "lm":
        kw.update(lm=str(d / "lm/rnnlm.int8.onnx"), lm_scale=0.6, lodr_fst=str(d / "lm/2gram.fst"), lodr_scale=-0.5)
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(d / "tokens.txt"),
        encoder=str(d / "encoder.int8.onnx"),
        decoder=str(d / "decoder.onnx"),
        joiner=str(d / "joiner.int8.onnx"),
        num_threads=1,
        sample_rate=16000,
        feature_dim=80,
        **kw,
    )


def transcribe(r, audio: np.ndarray, sr: int) -> dict:
    s = r.create_stream()
    s.accept_waveform(sr, audio)
    s.accept_waveform(sr, np.zeros(sr, dtype="float32"))
    s.input_finished()
    while r.is_ready(s):
        r.decode_stream(s)
    res = r.get_result_all(s)
    return {"text": res.text, "timestamps": [round(t, 2) for t in res.timestamps]}


def features(audio: np.ndarray) -> np.ndarray:
    o = knf.FbankOptions()
    o.frame_opts.dither = 0
    o.frame_opts.snip_edges = False
    o.frame_opts.samp_freq = 16000
    o.mel_opts.num_bins = 80
    o.mel_opts.high_freq = -400
    o.mel_opts.low_freq = 20
    f = knf.OnlineFbank(o)
    f.accept_waveform(16000, audio.tolist())
    f.input_finished()
    return np.stack([f.get_frame(i) for i in range(f.num_frames_ready)]).astype("<f4")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("--model", type=Path, default=ROOT / ".cache" / "seda-v0.1")
    args = ap.parse_args()
    wavs = sorted(p for p in args.dir.glob("*.wav") if p.stem != "long")
    for method in ("greedy", "beam", "lm"):
        r = recognizer(args.model, method)
        for w in wavs:
            audio, sr = sf.read(w, dtype="float32", always_2d=True)
            out = transcribe(r, audio.mean(axis=1), sr)
            (args.dir / f"{w.stem}.{method}.json").write_text(json.dumps(out, ensure_ascii=False))
            print(method, w.stem, out["text"])
    if wavs:
        audio, sr = sf.read(wavs[0], dtype="float32")
        assert sr == 16000, "feature reference needs a 16 kHz file"
        features(audio).tofile(args.dir / f"{wavs[0].stem}.feats.f32")


if __name__ == "__main__":
    main()
