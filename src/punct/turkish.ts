// Turkish finishing touches on top of the punctuation model:
//  - sentence-initial capitals with Turkish casing (i -> İ, ı -> I),
//  - a full stop where the model ends a sentence without punctuation,
//  - the apostrophe between a proper noun and its inflectional suffix
//    ("istanbulda" -> "İstanbul'da", "ankaradır" -> "Ankara'dır").
//
// The model knows which words are proper nouns (it capitalises them) but not
// where the stem ends. Stems come from a small gazetteer and from the
// transcript itself: a capitalised word that also appears bare ("Ahmet")
// makes "Ahmetle" -> "Ahmet'le".

import type { WordMark } from "./punctuator";

const lower = (s: string) => s.toLocaleLowerCase("tr-TR");
const capitalise = (s: string) => (s ? s[0].toLocaleUpperCase("tr-TR") + s.slice(1) : s);

/** Inflectional suffixes written after an apostrophe (derivational ones such as -lı, -ca are not). */
const SUFFIXES = new Set(
  [
    // locative, ablative, "-ki"
    "da de ta te dan den tan ten daki deki taki teki dakiler dekiler",
    // dative, accusative, genitive (with buffer letters)
    "a e ya ye ı i u ü yı yi yu yü ın in un ün nın nin nun nün",
    // instrumental, copula, plural (+ case)
    "la le yla yle dır dir dur dür tır tir tur tür lar ler ları leri lara lere larda lerde ların lerin",
    // genitive + locative/ablative, e.g. "Türkiye'nin", "İstanbul'undaki"
    "nda nde ndan nden ndaki ndeki na ne nı ni",
  ]
    .join(" ")
    .split(" "),
);

/** Proper nouns that are never ordinary words: capitalised even if the model missed them. */
const PLACES = `adana adıyaman afyon afyonkarahisar ağrı amasya ankara antalya artvin balıkesir bilecik bingöl
bitlis burdur bursa çanakkale çankırı çorum denizli diyarbakır edirne elazığ erzincan erzurum eskişehir gaziantep
antep giresun gümüşhane hakkari hatay ısparta isparta mersin istanbul izmir kastamonu kayseri kırklareli kırşehir
kocaeli konya kütahya malatya manisa kahramanmaraş maraş mardin muğla nevşehir niğde sakarya samsun siirt sinop
sivas tekirdağ trabzon tunceli şanlıurfa urfa yozgat zonguldak aksaray bayburt karaman kırıkkale şırnak bartın
ardahan iğdır yalova karabük osmaniye düzce kadıköy beşiktaş üsküdar şişli beyoğlu bakırköy sarıyer maltepe
kartal pendik ataşehir ümraniye beylikdüzü esenyurt bağcılar zeytinburnu eyüp avcılar küçükçekmece
büyükçekmece silivri çatalca tuzla beykoz çankaya keçiören yenimahalle karşıyaka bornova alsancak kapadokya
bodrum marmaris alanya fethiye çeşme türkiye almanya fransa ingiltere italya ispanya rusya amerika japonya
hindistan iran irak suriye yunanistan bulgaristan azerbaycan gürcistan ermenistan israil filistin ukrayna
polonya hollanda belçika avusturya isviçre isveç norveç danimarka finlandiya kanada meksika brezilya arjantin
avustralya pakistan afganistan katar kıbrıs portekiz macaristan romanya sırbistan bosna arnavutluk makedonya
kazakistan özbekistan türkmenistan kırgızistan endonezya malezya tayland vietnam nijerya cezayir tunus libya
avrupa asya afrika anadolu trakya karadeniz akdeniz marmara londra paris berlin roma madrid moskova tokyo
pekin brüksel viyana atina amsterdam atatürk`
  .split(/\s+/)
  .filter(Boolean);

/** Also place names, but common words too ("ordu" = army): only when the model capitalised them. */
const AMBIGUOUS = `van muş ordu batman tokat aydın bolu kars rize kilis uşak adalar konak kaş fas çin mısır ege
kore bey hanım paşa hoca efendi`
  .split(/\s+/)
  .filter(Boolean);

const SAFE = new Set(PLACES);
const ALL_STEMS = [...PLACES, ...AMBIGUOUS];

const SOFTEN: Record<string, string> = { k: "ğ", t: "d", p: "b", ç: "c" };

/** Split `word` (lowercase) into a known stem + inflectional suffix, if possible. */
function splitProper(word: string, stems: Iterable<string>): { stem: string; suffix: string } | null {
  let best: { stem: string; suffix: string } | null = null;
  for (const stem of stems) {
    if (stem.length < 3 || (best && stem.length <= best.stem.length)) continue;
    if (word === stem) {
      best = { stem, suffix: "" };
      continue;
    }
    if (word.startsWith(stem) && SUFFIXES.has(word.slice(stem.length))) {
      best = { stem, suffix: word.slice(stem.length) };
      continue;
    }
    // Consonant softening before a vowel: "pamuğun" = Pamuk + 'un.
    const soft = SOFTEN[stem[stem.length - 1]];
    if (soft) {
      const softened = stem.slice(0, -1) + soft;
      const rest = word.slice(softened.length);
      if (word.startsWith(softened) && SUFFIXES.has(rest) && /^[aeıioöuü]/.test(rest)) {
        best = { stem, suffix: rest };
      }
    }
  }
  return best;
}

/** Turn model marks into the final written words (one per transcript word). */
export function finishTurkish(marks: WordMark[]): string[] {
  // Bare capitalised words mid-sentence are names; remember them as stems.
  const learned = new Set<string>();
  marks.forEach((m, i) => {
    const sentenceStart = i === 0 || marks[i - 1].sentenceEnd;
    if (m.capitalised && !sentenceStart && !splitProper(lower(m.text), ALL_STEMS)?.suffix) {
      const w = lower(m.text);
      if (w.length >= 3 && !SUFFIXES.has(w)) learned.add(w);
    }
  });
  const learnedOnly = [...learned].filter((w) => !SAFE.has(w));

  return marks.map((m, i) => {
    const w = lower(m.text);
    let text = m.text;

    const place = splitProper(w, PLACES);
    const ambiguous = m.capitalised ? splitProper(w, AMBIGUOUS) : null;
    const name = m.capitalised ? splitProper(w, learnedOnly) : null;
    const hit = [place, ambiguous, name].reduce<{ stem: string; suffix: string } | null>(
      (a, b) => (b && (!a || b.stem.length > a.stem.length) ? b : a),
      null,
    );
    if (hit) {
      // Keep the model's casing of the stem when it had one (e.g. all caps).
      // (A softened stem, "Pamuğ-un", is written in its dictionary form: "Pamuk'un".)
      const stemText = m.capitalised && w.startsWith(hit.stem) ? text.slice(0, hit.stem.length) : capitalise(hit.stem);
      text = hit.suffix ? `${capitalise(stemText)}'${hit.suffix}` : capitalise(stemText);
    }

    const sentenceStart = i === 0 || marks[i - 1].sentenceEnd;
    if (sentenceStart) text = capitalise(text);
    let post = m.post ?? "";
    if (m.sentenceEnd && !/[.?!…]$/.test(post)) post = ".";
    if (i === marks.length - 1 && !post) post = ".";
    return text + post;
  });
}

/** Strip punctuation and case so a transcript can be punctuated again. */
export function plainWord(text: string): string {
  return lower(text.replace(/['’]/g, "").replace(/[^\p{L}\p{N}-]/gu, ""));
}
