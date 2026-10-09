"""Download seda-v0.1 from Hugging Face and convert it for the browser.

Outputs go to public/models/seda-v0.1/:

  encoder.webgpu.onnx  int8 weights, but MatMulInteger -> DequantizeLinear + MatMul
                       so that every op runs on onnxruntime-web's WebGPU EP
  decoder.onnx         unchanged (runs on wasm)
  joiner.int8.onnx     unchanged (runs on wasm)
  rnnlm.int8.onnx      unchanged (runs on wasm)
  lodr.bin             2gram.fst re-encoded in a flat little-endian format
  tokens.txt           unchanged
  model.json           model hyper-parameters read from the ONNX metadata,
                       plus file sizes for download progress

and the punctuation / true-casing model to public/models/punct/:

  punct.int8.onnx      1-800-BAD-CODE/punct_cap_seg_47_language, dynamic int8
  spm.json             its SentencePiece unigram vocabulary (pieces + scores)
  punct.json           labels and windowing parameters

Usage:  python scripts/prepare_models.py [--src DIR]
"""

import argparse
import collections
import json
import os
import shutil
import struct
import urllib.request
from pathlib import Path

import numpy as np
import onnx
from onnx import helper

REPO = "atasoglu/seda-v0.1"
FILES = [
    "encoder.int8.onnx",
    "decoder.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
    "lm/rnnlm.int8.onnx",
    "lm/2gram.fst",
]

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "models" / "seda-v0.1"


def download(dst: Path) -> None:
    for f in FILES:
        p = dst / f
        if p.exists():
            continue
        p.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://huggingface.co/{REPO}/resolve/main/{f}"
        print("download", url)
        urllib.request.urlretrieve(url, p)


def convert_matmul_integer(src: Path, dst: Path) -> None:
    """Rewrite ORT dynamic quantization into weight-only DequantizeLinear.

    Pattern produced by onnxruntime.quantization.quantize_dynamic:
        a_q, a_s, a_zp = DynamicQuantizeLinear(a)
        y_i = MatMulInteger(a_q, w_q, a_zp, w_zp)
        y_f = Cast(y_i)
        s   = Mul(a_s, w_s)
        y   = Mul(y_f, s)
    becomes
        w   = DequantizeLinear(w_q, w_s, w_zp)
        y   = MatMul(a, w)
    """
    m = onnx.load(str(src))
    g = m.graph
    prod = {o: n for n in g.node for o in n.output}
    cons = collections.defaultdict(list)
    for n in g.node:
        for i in n.input:
            cons[i].append(n)
    inits = {i.name for i in g.initializer}

    removed = set()
    replacement = {}  # id(MatMulInteger node) -> [new nodes]
    dq_done = {}

    for n in g.node:
        if n.op_type != "MatMulInteger":
            continue
        a_q, w_q, _a_zp, w_zp = n.input
        assert w_q in inits and w_zp in inits
        dql = prod[a_q]
        assert dql.op_type == "DynamicQuantizeLinear"
        (cast,) = cons[n.output[0]]
        assert cast.op_type == "Cast"
        (mul,) = cons[cast.output[0]]
        assert mul.op_type == "Mul"
        scale_name = [i for i in mul.input if i != cast.output[0]][0]
        scale_mul = prod[scale_name]
        assert scale_mul.op_type == "Mul"
        a_s = dql.output[1]
        w_s = [i for i in scale_mul.input if i != a_s][0]
        assert w_s in inits

        new_nodes = []
        if w_q not in dq_done:
            w_f = w_q + "_dequantized"
            new_nodes.append(
                helper.make_node(
                    "DequantizeLinear", [w_q, w_s, w_zp], [w_f], name=w_q + "_DQ"
                )
            )
            dq_done[w_q] = w_f
        new_nodes.append(
            helper.make_node(
                "MatMul",
                [dql.input[0], dq_done[w_q]],
                [mul.output[0]],
                name=n.name + "_MatMul",
            )
        )
        replacement[id(n)] = new_nodes
        removed.update({id(cast), id(mul), id(scale_mul)})

    # Drop DynamicQuantizeLinear nodes whose outputs are no longer used.
    kept_inputs = set()
    for n in g.node:
        if id(n) in removed or n.op_type == "MatMulInteger":
            continue
        kept_inputs.update(n.input)
    for nodes in replacement.values():
        for n in nodes:
            kept_inputs.update(n.input)
    for n in g.node:
        if n.op_type == "DynamicQuantizeLinear" and not any(
            o in kept_inputs for o in n.output
        ):
            removed.add(id(n))

    new_list = []
    for n in g.node:
        if id(n) in replacement:
            new_list.extend(replacement[id(n)])
        elif id(n) not in removed:
            new_list.append(n)
    del g.node[:]
    g.node.extend(new_list)

    # The rewritten graph no longer carries quantized activations.
    for p in m.metadata_props:
        if p.key == "onnx.infer":
            p.value = "seda-webgpu"
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))
    print(f"{dst.name}: {len(replacement)} MatMulInteger rewritten")


def simplify_static(path: Path) -> None:
    """Fix the batch size to 1 and constant-fold the shape arithmetic.

    The streaming encoder has ~1000 Shape/Gather/Concat nodes computing sizes
    that are constant once the batch is fixed. On WebGPU every one of them is
    a dispatch (or a GPU->CPU sync), so folding them roughly halves the run
    time. The int8 weights are temporarily turned into graph inputs so the
    folding cannot expand them to float32.
    """
    os.environ.setdefault("ONNXSIM_FIXED_POINT_ITERS", "500")
    import onnxsim

    m = onnx.load(str(path))
    g = m.graph
    for v in list(g.input) + list(g.output):
        for d in v.type.tensor_type.shape.dim:
            if d.dim_param == "N":
                d.Clear()
                d.dim_value = 1

    dq_weights = {n.input[0] for n in g.node if n.op_type == "DequantizeLinear"}
    held = [i for i in g.initializer if i.name in dq_weights]
    for init in held:
        g.initializer.remove(init)
        g.input.append(helper.make_tensor_value_info(init.name, init.data_type, list(init.dims)))

    before = len(g.node)
    meta = list(m.metadata_props)
    m, ok = onnxsim.simplify(m, skip_shape_inference=False)
    assert ok, "onnxsim check failed"

    g = m.graph
    names = {i.name for i in held}
    keep = [i for i in g.input if i.name not in names]
    del g.input[:]
    g.input.extend(keep)
    g.initializer.extend(held)
    del m.metadata_props[:]
    m.metadata_props.extend(meta)
    onnx.checker.check_model(m)
    onnx.save(m, str(path))
    print(f"{path.name}: {before} -> {len(g.node)} nodes after static simplification")


def externalize_pad_mask(path: Path) -> None:
    """Replace the int64 `processed_lens` bookkeeping with an int32 input.

    The encoder derives a left-context padding mask from processed_lens:
        mask = concat(reverse(processed_lens <= arange(128)), zeros(32))
    Those int64 ops are placed on the CPU by onnxruntime-web, which forces a
    GPU<->CPU round trip per chunk and rules out WebGPU graph capture. The app
    computes the same [1, 160] int32 mask itself (see StreamingEncoder) and
    tracks processed_lens in JavaScript.
    """
    m = onnx.load(str(path))
    g = m.graph
    byname = {n.name: n for n in g.node}
    concat = byname["/Concat_4"]
    mask_name = concat.output[0]
    for n in g.node:
        for i, x in enumerate(n.input):
            if x == mask_name:
                n.input[i] = "pad_mask"
    drop = {"/Unsqueeze_9", "/Add_2", "/LessOrEqual", "/Cast", "/Slice_2", "/Concat_4"}
    assert drop <= set(byname), "unexpected encoder graph layout"
    keep = [n for n in g.node if n.name not in drop]
    del g.node[:]
    g.node.extend(keep)

    inputs = [i for i in g.input if i.name != "processed_lens"]
    inputs.append(helper.make_tensor_value_info("pad_mask", onnx.TensorProto.INT32, [1, 160]))
    del g.input[:]
    g.input.extend(inputs)
    outputs = [o for o in g.output if o.name != "new_processed_lens"]
    del g.output[:]
    g.output.extend(outputs)

    used = {x for n in g.node for x in n.input}
    unused = [i for i in g.initializer if i.name not in used]
    for i in unused:
        g.initializer.remove(i)
    onnx.checker.check_model(m)
    onnx.save(m, str(path))
    print(f"{path.name}: processed_lens replaced by pad_mask input")


def convert_fst(src: Path, dst: Path) -> None:
    """Parse an OpenFst 'vector' StdArc binary and write a flat CSR layout.

    lodr.bin (little endian):
        magic 'LODR', u32 version=1
        i32 start, i32 num_states, i32 num_arcs, i32 backoff_id
        f32 final[num_states]            (+inf when not final)
        i32 arc_offset[num_states + 1]
        i32 ilabel[num_arcs]
        i32 nextstate[num_arcs]
        f32 weight[num_arcs]
    Arcs of each state are sorted by ilabel (needed for binary search).
    """
    b = src.read_bytes()
    pos = 0

    def rd(fmt):
        nonlocal pos
        v = struct.unpack_from("<" + fmt, b, pos)
        pos += struct.calcsize("<" + fmt)
        return v if len(v) > 1 else v[0]

    def rd_str():
        nonlocal pos
        n = rd("i")
        s = b[pos : pos + n].decode()
        pos += n
        return s

    magic = rd("I")
    assert magic == 2125659606, "not an OpenFst binary"
    fst_type, arc_type = rd_str(), rd_str()
    assert fst_type == "vector" and arc_type == "standard", (fst_type, arc_type)
    _version, flags = rd("i"), rd("i")
    _props = rd("Q")
    # num_arcs in the header is not filled in by VectorFst::Write.
    start, num_states, _ = rd("q"), rd("q"), rd("q")
    assert flags & 0x3 == 0, "symbol tables not supported"

    final = np.empty(num_states, np.float32)
    offsets = np.zeros(num_states + 1, np.int32)
    ilabels, nexts, weights = [], [], []
    arc_dtype = np.dtype([("i", "<i4"), ("o", "<i4"), ("w", "<f4"), ("n", "<i4")])
    backoff_id = -1
    unsorted = 0
    for s in range(num_states):
        final[s] = rd("f")
        n = rd("q")
        arcs = np.frombuffer(b, arc_dtype, n, pos)
        pos += n * arc_dtype.itemsize
        if backoff_id < 0:
            eps = arcs[arcs["o"] == 0]
            if len(eps):
                backoff_id = int(eps[0]["i"])
        if n > 1 and np.any(np.diff(arcs["i"]) < 0):
            unsorted += 1
        arcs = np.sort(arcs, order="i", kind="stable")
        ilabels.append(arcs["i"].copy())
        nexts.append(arcs["n"].copy())
        weights.append(arcs["w"].copy())
        offsets[s + 1] = offsets[s] + n
    num_arcs = int(offsets[-1])
    assert pos == len(b), "trailing bytes in fst"
    assert backoff_id >= 0, "no backoff arc found"

    with open(dst, "wb") as f:
        f.write(b"LODR")
        f.write(struct.pack("<Iiiii", 1, start, num_states, num_arcs, backoff_id))
        f.write(final.astype("<f4").tobytes())
        f.write(offsets.astype("<i4").tobytes())
        f.write(np.concatenate(ilabels).astype("<i4").tobytes())
        f.write(np.concatenate(nexts).astype("<i4").tobytes())
        f.write(np.concatenate(weights).astype("<f4").tobytes())
    print(
        f"{dst.name}: {num_states} states, {num_arcs} arcs, "
        f"backoff={backoff_id}, unsorted states={unsorted}"
    )


def meta(path: Path) -> dict:
    return {p.key: p.value for p in onnx.load(str(path), load_external_data=False).metadata_props}


def write_config(src: Path) -> None:
    enc = meta(src / "encoder.int8.onnx")
    dec = meta(src / "decoder.onnx")
    lm = meta(src / "lm/rnnlm.int8.onnx")
    tokens = (src / "tokens.txt").read_text().split("\n")
    unk = next(int(t.split()[1]) for t in tokens if t.startswith("<unk> "))
    files = {
        f: (OUT / f).stat().st_size
        for f in [
            "encoder.webgpu.onnx",
            "decoder.onnx",
            "joiner.int8.onnx",
            "tokens.txt",
            "rnnlm.int8.onnx",
            "lodr.bin",
        ]
    }
    cfg = {
        "name": "seda-v0.1",
        "sampleRate": 16000,
        "featureDim": 80,
        "chunkSize": int(enc["T"]),
        "chunkShift": int(enc["decode_chunk_len"]),
        "subsampling": 4,
        "frameShiftMs": 10,
        "contextSize": int(dec["context_size"]),
        "vocabSize": int(dec["vocab_size"]),
        "blankId": 0,
        "unkId": unk,
        # Recurrent encoder states; the model outputs them as "new_" + name.
        "encoderStates": [
            i.name
            for i in onnx.load(str(OUT / "encoder.webgpu.onnx"), load_external_data=False).graph.input
            if i.name not in ("x", "pad_mask")
        ],
        "leftContext": 128,
        "padMaskLen": 160,
        # processed_lens grows by this many (encoder_embed) frames per chunk.
        "processedPerChunk": 32,
        "lm": {
            "sosId": int(lm["sos_id"]),
            "numLayers": int(lm["num_layers"]),
            "hiddenSize": int(lm["hidden_size"]),
            "scale": 0.6,
            "lodrScale": -0.5,
        },
        "files": files,
    }
    (OUT / "model.json").write_text(json.dumps(cfg, indent=2))
    print("model.json:", json.dumps({k: v for k, v in cfg.items() if k not in ("files", "encoderStates")}))


PUNCT_REPO = "1-800-BAD-CODE/punct_cap_seg_47_language"
PUNCT_OUT = ROOT / "public" / "models" / "punct"


def prepare_punct(cache: Path) -> None:
    """Punctuation, true-casing and sentence boundaries (47 languages, incl. Turkish)."""
    import yaml
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from sentencepiece import sentencepiece_model_pb2 as pb

    files = ["punct_cap_seg_47lang.onnx", "spe_unigram_64k_lowercase_47lang.model", "config.yaml"]
    for f in files:
        p = cache / f
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            url = f"https://huggingface.co/{PUNCT_REPO}/resolve/main/{f}"
            print("download", url)
            urllib.request.urlretrieve(url, p)
    PUNCT_OUT.mkdir(parents=True, exist_ok=True)

    out = PUNCT_OUT / "punct.int8.onnx"
    # Weights (MatMul) and the 64k x 512 embedding table (Gather) to int8,
    # per channel: 233 -> 59 MB with the same output as fp32 on our Turkish
    # test sentences (per-tensor scales changed one sentence boundary).
    quantize_dynamic(
        str(cache / files[0]),
        str(out),
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gather"],
        per_channel=True,
    )

    m = pb.ModelProto()
    m.ParseFromString((cache / files[1]).read_bytes())
    assert m.trainer_spec.model_type == 1, "expected a unigram model"
    assert m.normalizer_spec.name == "identity"
    types = sorted({p.type for p in m.pieces})
    assert set(types) <= {1, 2, 3}, f"unsupported piece types {types}"
    spm = {
        "pieces": [p.piece for p in m.pieces],
        "scores": [round(p.score, 5) for p in m.pieces],
        # 1 normal, 2 unknown, 3 control
        "types": [p.type for p in m.pieces],
        "unkId": next(i for i, p in enumerate(m.pieces) if p.type == 2),
        "bosId": m.trainer_spec.bos_id,
        "eosId": m.trainer_spec.eos_id,
        "padId": m.trainer_spec.pad_id,
    }
    (PUNCT_OUT / "spm.json").write_text(json.dumps(spm, ensure_ascii=False, separators=(",", ":")))

    cfg = yaml.safe_load((cache / files[2]).read_text())
    punct = {
        "maxLength": cfg["max_length"],
        "overlap": 16,
        "preLabels": cfg["pre_labels"],
        "postLabels": cfg["post_labels"],
        "nullToken": cfg.get("null_token", "<NULL>"),
        "files": {f: (PUNCT_OUT / f).stat().st_size for f in ["punct.int8.onnx", "spm.json"]},
    }
    (PUNCT_OUT / "punct.json").write_text(json.dumps(punct, ensure_ascii=False, indent=2))
    print(f"punct: {out.stat().st_size / 1e6:.1f} MB model, {len(spm['pieces'])} pieces")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=ROOT / ".cache" / "seda-v0.1")
    args = ap.parse_args()
    args.src.mkdir(parents=True, exist_ok=True)
    download(args.src)
    OUT.mkdir(parents=True, exist_ok=True)

    convert_matmul_integer(args.src / "encoder.int8.onnx", OUT / "encoder.webgpu.onnx")
    simplify_static(OUT / "encoder.webgpu.onnx")
    externalize_pad_mask(OUT / "encoder.webgpu.onnx")
    for f in ["decoder.onnx", "joiner.int8.onnx", "tokens.txt"]:
        shutil.copy(args.src / f, OUT / f)
    shutil.copy(args.src / "lm/rnnlm.int8.onnx", OUT / "rnnlm.int8.onnx")
    convert_fst(args.src / "lm/2gram.fst", OUT / "lodr.bin")
    write_config(args.src)
    prepare_punct(args.src.parent / "punct_cap_seg_47_language")


if __name__ == "__main__":
    main()
