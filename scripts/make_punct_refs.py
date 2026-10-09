"""Reference outputs for tests/punct.node.ts, from the `punctuators` package.

    python scripts/make_punct_refs.py OUT.json [--model-dir .cache/punct_cap_seg_47_language]

Uses the original fp32 model, one window per batch (the ONNX graph has no
attention mask, so padded batches change results slightly).
"""

import argparse
import json
from pathlib import Path

import sentencepiece as spm
from punctuators.models.punc_cap_seg_model import PunctCapSegConfigONNX, PunctCapSegModelONNX

ROOT = Path(__file__).resolve().parent.parent
TEXTS = [
 "merhaba bugün hava çok güzel istanbulda yaşayan insanlar sahilde yürüyüş yapmayı seviyor yarın sabah saat dokuzda toplantımız var lütfen geç kalmayın",
 "türkiye cumhuriyeti bin dokuz yüz yirmi üç yılında kuruldu başkenti ankaradır ülkenin en kalabalık şehri ise istanbuldur ekonomi tarım ve turizm önemli sektörlerdir",
 "geçen hafta kadıköydeki kitapçıda orhan pamuğun yeni romanını gördüğü satıcı kadın almanca ve fransızca çevirilerinin de yakında yayınlanacağını söyledi akşam meyve dönerken yağmur başladı",
 "arkadaşlar herkese merhaba bugünkü videoda size ankarada gittiğimiz kafeyi anlatacağım siz de daha önce gittiniz mi yorumlarda yazın bence fiyatlar biraz yüksekti ama kahveleri gerçekten çok iyiydi",
 "yarınki toplantıya sen de gelecek misin yoksa ahmet beyle mi görüşeceksin bilmiyorum ama bana haber ver",
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--model-dir", type=Path, default=ROOT / ".cache" / "punct_cap_seg_47_language")
    args = ap.parse_args()
    spe = "spe_unigram_64k_lowercase_47lang.model"
    texts = TEXTS + [" ".join(TEXTS * 6)]  # ~1300 tokens: overlapping windows
    sp = spm.SentencePieceProcessor(str(args.model_dir / spe))
    m = PunctCapSegModelONNX(
        PunctCapSegConfigONNX(directory=str(args.model_dir), spe_filename=spe, model_filename="punct_cap_seg_47lang.onnx"),
        ort_providers=["CPUExecutionProvider"],
    )
    res = m.infer(texts, batch_size_tokens=128)
    refs = [{"text": t, "ids": sp.encode(t), "sentences": r} for t, r in zip(texts, res)]
    args.out.write_text(json.dumps(refs, ensure_ascii=False))
    print(f"{len(refs)} references -> {args.out}")


if __name__ == "__main__":
    main()
