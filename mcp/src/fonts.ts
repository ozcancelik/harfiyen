// The fonts captions are drawn with. libass reads TTF/OTF only, so the web app's ten fonts (woff2 there) are
// bundled as TTF in ../fonts; a font file of the user's can be added to them.

import { copyFileSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FONTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fonts");

export interface FontInfo {
  family: string;
  /** Has a bold cut. Single-weight display fonts do not: asking for bold would make libass smear them. */
  bold: boolean;
  /** Draws lowercase letters as capitals without Turkish rules: "i" comes out as a dotless I, so the text is upper-cased first. */
  caps?: boolean;
}

/** The web app's fonts, by the family name inside the file. */
export const BUNDLED: FontInfo[] = [
  { family: "Google Sans Flex", bold: true },
  { family: "Montserrat", bold: true },
  { family: "Poppins", bold: true },
  { family: "Inter", bold: true },
  { family: "Anton", bold: false },
  { family: "Bebas Neue", bold: false, caps: true },
  { family: "Bangers", bold: false, caps: true },
  { family: "Luckiest Guy", bold: false, caps: true },
  { family: "Schibsted Grotesk", bold: true },
  { family: "Literata", bold: true },
];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The family name in a TTF/OTF's name table (typographic family when there is one). */
export function familyOf(path: string): string {
  const b = readFileSync(path);
  const tag = b.toString("ascii", 0, 4);
  if (tag === "wOFF" || tag === "wOF2") throw new Error("Yazı tipi dosyası TTF ya da OTF olmalı (woff libass'ta çalışmaz).");
  if (tag === "ttcf") throw new Error("TTC koleksiyonları desteklenmiyor; tek bir TTF ya da OTF verilmeli.");
  const tables = b.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const at = 12 + i * 16;
    if (b.toString("ascii", at, at + 4) !== "name") continue;
    const base = b.readUInt32BE(at + 8);
    const count = b.readUInt16BE(base + 2);
    const strings = base + b.readUInt16BE(base + 4);
    const names = new Map<number, string>();
    for (let n = 0; n < count; n++) {
      const rec = base + 6 + n * 12;
      const platform = b.readUInt16BE(rec);
      const id = b.readUInt16BE(rec + 6);
      if (id !== 1 && id !== 16) continue;
      const len = b.readUInt16BE(rec + 8);
      const raw = b.subarray(strings + b.readUInt16BE(rec + 10), strings + b.readUInt16BE(rec + 10) + len);
      // Windows and Unicode platforms are UTF-16BE; Mac Roman is plain bytes for a family name.
      const text = platform === 1 ? raw.toString("latin1") : Buffer.from(raw).swap16().toString("utf16le");
      if (!names.has(id) || platform !== 1) names.set(id, text);
    }
    const family = names.get(16) ?? names.get(1);
    if (family) return family;
  }
  throw new Error("Yazı tipi dosyasında aile adı bulunamadı.");
}

export interface ResolvedFont {
  family: string;
  bold: boolean;
  caps: boolean;
}

/**
 * The family and weight to ask libass for. `file` wins over `name` and gives its own family; a bundled name keeps
 * its weight rule; any other name is taken as a font installed on the system.
 */
export function resolveFont(name: string, file?: string, bold?: boolean): ResolvedFont {
  if (file) return { family: familyOf(file), bold: bold ?? true, caps: false };
  const bundled = BUNDLED.find((f) => key(f.family) === key(name));
  return bundled
    ? { family: bundled.family, bold: bold ?? bundled.bold, caps: !!bundled.caps }
    : { family: name, bold: bold ?? true, caps: false };
}

/** A directory libass reads: the bundled fonts plus the user's file, linked into `into`. */
export function prepareFontsDir(into: string, file?: string): string {
  for (const f of readdirSync(FONTS_DIR)) if (/\.(ttf|otf)$/i.test(f)) symlinkSync(join(FONTS_DIR, f), join(into, f));
  if (file) copyFileSync(file, join(into, `user-${Date.now()}${file.slice(file.lastIndexOf("."))}`));
  return into;
}
