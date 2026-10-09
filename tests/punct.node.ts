// Punctuation check against the `punctuators` Python package.
//
//   npx tsx tests/punct.node.ts <ref.json>
//
// ref.json: [{ text, ids, sentences }] from scripts/make_punct_refs.py (the
// original fp32 model). Tokenisation must match exactly; punctuation must
// match on the short texts. On the long text int8 may flip a few borderline
// decisions, so that one is only reported. The Turkish-finished text is
// printed for a visual check.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import type { Ort } from "../src/engine/models";
import { Punctuator, type PunctConfig } from "../src/punct/punctuator";
import { SpmTokenizer, type SpmVocab } from "../src/punct/spm";
import { finishTurkish } from "../src/punct/turkish";

const refPath = process.argv[2];
if (!refPath) throw new Error("usage: tsx tests/punct.node.ts <ref.json>");
const dir = join(import.meta.dirname, "..", "public", "models", "punct");
const vocab: SpmVocab = JSON.parse(readFileSync(join(dir, "spm.json"), "utf8"));
const cfg: PunctConfig = JSON.parse(readFileSync(join(dir, "punct.json"), "utf8"));
const refs: { text: string; ids: number[]; sentences: string[] }[] = JSON.parse(readFileSync(refPath, "utf8"));

let failed = false;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  if (!ok) failed = true;
};

const tok = new SpmTokenizer(vocab);
for (const r of refs) {
  const ids = tok.encode(r.text);
  check(JSON.stringify(ids) === JSON.stringify(r.ids), `tokens (${ids.length}) ${r.text.slice(0, 40)}…`);
}

const punct = await Punctuator.create(ort as unknown as Ort, new Uint8Array(readFileSync(join(dir, "punct.int8.onnx"))), vocab, cfg, "cpu");
for (const r of refs) {
  const words = r.text.split(" ");
  const marks = await punct.run(words);
  // Rebuild sentences the way punctuators does (plain casing for comparison).
  const sentences: string[] = [];
  let cur: string[] = [];
  for (const m of marks) {
    cur.push(m.text + (m.post ?? ""));
    if (m.sentenceEnd) {
      sentences.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur.join(" "));
  // Python upper-cases "i" as "I"; we use Turkish casing ("İ").
  const ours = sentences.map((s) => s.replaceAll("İ", "I"));
  const theirs = r.sentences.map((s) => s.replaceAll("İ", "I"));
  const same = JSON.stringify(ours) === JSON.stringify(theirs);
  if (r.ids.length > 500) {
    const a = ours.join(" ").split(" ");
    const b = theirs.join(" ").split(" ");
    const diff = a.filter((w, i) => w !== b[i]).length;
    console.log(`INFO  long text (${r.ids.length} tokens): ${diff} of ${a.length} words differ from fp32`);
    continue;
  }
  check(same, `punctuation ${r.text.slice(0, 40)}…`);
  if (!same) {
    console.log("  ours:  ", ours.join(" | "));
    console.log("  theirs:", theirs.join(" | "));
  }
  if (r !== refs[refs.length - 1]) console.log("  →", finishTurkish(marks).join(" "));
}

process.exit(failed ? 1 : 0);
