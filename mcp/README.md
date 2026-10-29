# Harfiyen MCP

Harfiyen'in motorlarını [MCP](https://modelcontextprotocol.io) sunucusu olarak çalıştırır: yazıya döküm, noktalama,
çeviri, konuşmacı ayırma, boşluk kesme planı ve altyazılı video. Web uygulamasıyla aynı kod ve aynı modeller
kullanılır (`../src`); ses ve video bilgisayardan çıkmaz.

Oynatıcı ve canlı mikrofon burada yoktur. Altyazılı video, uygulamanın kendi video yazıcısıyla bilgisayardaki
Chrome'da yazılır (cam stili, aura ve kinetik tipografi dahil, uygulamayla aynı çizilir); Chrome yoksa ffmpeg ve libass
ile dokuz stil yazılır.

## Kurulum

Depo kökünde `npm install` ve `npm run models` (modeller `public/models` altına iner), sonra:

```sh
cd mcp && npm install
```

ffmpeg ve ffprobe PATH'te olmalı. Altyazılı video için Google Chrome kurulu olmalı (yolu `CHROME` ile verilebilir;
puppeteer-core tarayıcı indirmez); Chrome yoksa video ffmpeg ile yazılır, cam, aura ve kinetik stiller çizilemez. Modeller `HARFIYEN_MODELS` ile başka bir klasörden de okunabilir.
Transkriptler `~/.harfiyen-mcp/transcripts` altında saklanır (`HARFIYEN_MCP_HOME` ile değişir).

Claude Code'a eklemek için:

```sh
claude mcp add harfiyen -- node --import tsx /yol/harfiyen/mcp/src/server.ts
```

## Araçlar

| Araç | Ne yapar |
| --- | --- |
| `status` | Diskteki modeller, ffmpeg, kayıtlı transkript sayısı |
| `transcribe` | Ses ya da videoyu kelime zamanlı yazıya döker (Seda, Duyu, Whisper), noktalama ve sayı yazımıyla |
| `import_subtitles` | SRT / VTT'yi transkript olarak açar |
| `import_project`, `export_project`, `set_source` | Web uygulamasının `.harfiyen` projesini açar ve yazar; medya dosyası yeniden bağlanır |
| `set_range` | Transkriptte kesit (bölüm) seçer ya da kaldırır (saniye ya da kelime sırasıyla); yeniden yazıya döküm yapmadan yalnızca o kesiti dışa aktarır, seslendirir ve videoya yazar |
| `cut_words` | Metinden kurgu (kelime bazlı video kesme): seçilen kelime/saniye aralıklarını, dolgu seslerini (`fillers`) ve uzun duraksamaları (`silences`) keser (`mode: "cut"`), geri yükler (`mode: "restore"` / `"reset"`) ya da videonun farklı yerlerinden birden fazla önemli bölümü seçip geri kalanını keser (`mode: "keep_only"`). Kesimler `render_captions` ile tek geçişte birleştirilir |
| `list_transcripts`, `get_transcript`, `export_transcript` | Okuma; satırlar, düz metin, SRT, VTT, kelime zamanlı JSON |
| `rename_transcript`, `delete_transcript` | Transkripti yeniden adlandırma; transkripti, düzenleme geçmişini ve varsa seslendirmesini diskten silme |
| `edit_words`, `find_replace`, `find_text` | Düzeltme ve arama; değişmeyen kelimelerin zamanı korunur. `find_text` eşleşmelerin yerini ve zamanını listeler |
| `retime_words`, `shift_timing` | Bir satırın ya da kelimenin zamanı; bütün altyazıyı kaydırma |
| `edit_translation` | Çeviriyi düzeltme (`find_replace` de `language: translation` ile çeviride çalışır) |
| `assign_speaker`, `merge_speakers`, `rename_speaker` | Konuşmacıyı elle düzeltme: bir satırı başkasına verme, iki kişiyi birleştirme, adlandırma |
| `punctuate`, `apply_numbers` | Metni düzelttikten sonra noktalamayı ve sayı yazımını yeniden uygulama |
| `dub`, `export_dub`, `speak_text`, `preview_voice` | Seslendirme: transkripti yapay sesle okuyup satırları kendi zamanına yerleştirme, WAV'a yazma, dosyasız metin seslendirme, ses önizleme |
| `undo`, `history` | Son 20 düzenlemeyi geri alma; kelimeler, zamanlar, çeviri ve konuşmacılar birlikte döner |
| `align_text` | Doğru metni (şarkı sözü, konuşma metni) dökümün zamanlarına hizalar |
| `translate` | TR ↔ EN, cümle cümle |
| `tell_speakers`, `rename_speaker` | Kim ne zaman konuşuyor; adlar SRT, VTT ve videoda görünür |
| `plan_jump_cut` | Kesilecek sessizlikleri ve dolgu seslerini listeler |
| `render_captions` | Altyazıyı videoya yazar: stil, yazı tipi, sesle vurgula, jump cut, 9:16 / 4:5 / 1:1 / 16:9 kadraj (`crop_position: orta/sol/sag/ust/alt`), seslendirme karıştırma ve seçilen görünümü `.harfiyen` projesine kaydetme (`save_to_project`) |
| `job_status`, `cancel_job` | `background: true` ile başlatılan işlerin durumu ve çalışan işi (Chrome / ffmpeg süreciyle birlikte) durdurma |

Uzun işler tek tek, sırayla çalışır (modeller belleği paylaşır) ve ilerleme bildirimi gönderir.

## Sınırlar

- Her şey işlemcide çalışır. Seda ve Duyu hızlıdır; Whisper Turbo gerçek zamandan uzun sürebilir.
- Altyazı stilleri web uygulamasındakinin yakın bir taklididir, birebir aynı görünmez.
- Canlı mikrofon yok.

## Chrome ile yazma

`render_captions` videoyu varsayılan olarak uygulamanın kendi render worker'ıyla (`../src/worker/render.worker.ts`),
görünmez bir Chrome'da yazar; çıktı uygulamanınkiyle aynı çizilir (cam stili, aura, kinetik tipografi, konuşmacı etiketi,
yazı tipleri). Chrome yalnızca video yazmak için gerekir; yazıya döküm, çeviri, seslendirme ve konuşmacı işleri onsuz çalışır.

- `engine: auto` (varsayılan): Chrome kuruluysa Chrome, değilse ffmpeg ve libass; cevapta ffmpeg'in uygulamadan farklı çizebileceği not edilir.
- `engine: chrome`: Chrome şart, yoksa hata. `engine: ffmpeg`: Chrome'a hiç gitmez.
- `preset: cam`, `text_background: glass`, `kinetic`, `kinetic_backdrop`, `picture: aura` / `blur`, `aura`, `aura_style`, `photo_file`, `logo_file` yalnızca Chrome ile çizilir; Chrome yoksa hata verir.
- Stil, proje ve `preset` verilmediyse `sade` ile başlanır (ffmpeg yolundaki varsayılanla aynı). Projedeki ayarlar olduğu gibi kullanılır.

Kadraj, seslendirme (`original_volume`), boşluk kesme, `hidden` (yazısız video), `crf`, `width` ve `font_file` iki yolda da çalışır. Kaynak video sayfaya
belleğe değil tarayıcının özel diskine (OPFS) akıtılır, uzun videolar bellek tutmaz; seslendirme sesi ise bütün olarak
belleğe alınır (saatlik bir videoda yaklaşık 1 GB). İlk kullanımda `../src` ve `render-host/` Vite ile derlenip
`~/.harfiyen-mcp/render-host` altına konur (birkaç saniye); kod değişince kendiliğinden yeniden derlenir. Chrome'un yolu
`CHROME` ile verilebilir. Şimdilik yalnızca macOS'ta denendi. Chrome yolunda `size` uygulamanın boyudur (kısa kenarın
payı), `bold` yoktur (uygulama kalınlığı yazı tipine göre kendisi seçer). Google Chrome H.264 kodlayıcısını içerir; bazı Chromium sürümleri içermez.

## Altyazı stilleri ve yazı tipleri

`style`: `klasik`, `sade`, `karaoke`, `akis`, `odak`, `vurgu`, `pop`, `netles`, `tek-kelime`. `emphasis: true`
çevresinden yüksek sesle söylenen kelimeleri büyük yazar (web uygulamasındaki "Sesle vurgula" ile aynı seçim).

Web uygulamasının on yazı tipi `fonts/` altında TTF olarak gelir, kuruluma gerek kalmaz (`font: "Anton"` gibi).
Kendi yazı tipin için `font_file` (TTF ya da OTF) verilir. `uppercase` Türkçe kurala uygun büyük harf yazar
(i → İ); yalnızca büyük harfli Luckiest Guy, Bangers ve Bebas Neue'de otomatik açılır, yoksa "i" noktasız çıkar. Anton, Bebas Neue, Bangers ve Luckiest Guy tek kalınlıklı olduğundan kalın kapalı gelir (`bold`).

## Uygulamayla proje alışverişi

`import_project` uygulamada kaydettiğin `.harfiyen` dosyasını açar (kelimeler, çeviri, konuşmacılar, bölüm seçimi).
Projede medya yoktur: dosyanın yanında projenin kayıtlı medya adı aranır, bulunamazsa `set_source` ile verilir.
`export_project` transkripti uygulamanın açabileceği `.harfiyen` olarak yazar; medya varsa ses dalgası ve aura verisi
de hesaplanıp eklenir. Uygulamanın altyazı stili, kadraj ve jump cut ayarları MCP'nin kullanmadığı alanlardır;
olduğu gibi saklanır, projeyi geri yazınca kaybolmaz. Kanallar uygulamadaki gibi ortalanır, bu yüzden hesaplanan
dalga formu uygulamanınkiyle neredeyse aynıdır.

### Projenin stili ve kadrajı

`render_captions` transkript bir projeden geldiyse (`import_project`) projenin görünümünü varsayılan alır; verdiğin
parametreler üstüne yazar, `use_project: false` projeyi yok sayar.

| Projede | Burada |
| --- | --- |
| Stil | klasik, karaoke, akış, odak, vurgu, pop, netleş, sade, tek kelime birebir; dolgu → karaoke; cam → klasik (not düşülür) |
| Yazı tipi, boyut, konum, renkler, büyük harf | aynen (boyut karenin kısa kenarına göre, uygulamadaki gibi) |
| Zemin (kutu / kontur / gölge) | aynen; cam → kutu |
| Sesle vurgula, konuşmacı adı, gizli altyazı | aynen |
| Kadraj | kırpma kutusu (köşe ve boyutuyla), ya da sığdır ve siyah / bulanık zemin |
| Boşluk kesme | açıksa aynı ayarlarla |

Chrome varsa cam stili, kinetik tipografi ve gizli ya da bulanık görüntü projedeki gibi çizilir. Projede dosya olarak
saklanmayanlar (özel yüklenmiş yazı tipi, arka plan fotoğrafı, logo) `font_file`, `photo_file` ya da `logo_file`
verilmediyse cevapta "Not:" olarak bildirilir; verildiyse projenin köşe/boyut/saydamlık ve fotoğraf bulanıklığı ayarları
varsayılan alınır. Chrome yoksa ayrıca cam stili, kinetik tipografi ve gizli ya da bulanık görüntü not edilir.
Style değiştirirsen projenin o stile ait boyutu, konumu ve zemini kullanılmaz (pop'un boyutu sade'de anlamsız olurdu).

## Seslendirme

Web uygulamasının dört sesi CPU'da çalışır: EMA Lightning (varsayılan), Antalia Mini, Ahenk Cep ve Supertonic 3
(Türkçe ve İngilizce, 10 ses). Hızları yaklaşık olarak gerçek zamanın EMA'da 29, Antalia'da 25, Ahenk'te 16, Supertonic'te
5 katıdır. İngilizce okuma her zaman Supertonic'tir.

- `dub`: transkripti ya da çevirisini (`language: translation`) okur. Her satır kendi zamanında başlar; yerine sığmayan
  satır en fazla 1,35 kat (Supertonic'te 1,15) hızlı okunur, taşan son satırlar öncekilerin sessizliğine kayar, hâlâ
  sığmayan için uyarı verilir. Türkçe videoya İngilizce voice-over: `translate`, sonra `dub` ile `language: translation`.
- `speaker_voices` (`dub`): konuşmacıları `tell_speakers` ile ayırdıktan sonra her birine ayrı ses verilir, örneğin
  `[{ speaker: "Konuşmacı 1", style: "M3" }, { speaker: "2", style: "F1" }]`. Konuşmacı adıyla ya da numarasıyla (1'den)
  seçilir; verilmeyen alan genel ses ayarından gelir, listede olmayan konuşmacı genel sesle okunur. Bir satırı, ilk
  kelimesini söyleyen konuşmacı okur. Supertonic'te sesler M1–M5 ve F1–F5; diğer modellerde tek ses vardır, orada `pitch` ve
  `seed` ayırır. Birden çok model kullanılırsa hepsi bellekte tutulur.
- `render_captions` seslendirmeyi varsa karıştırır (`original_volume` 0–0,5, uygulamadaki gibi varsayılan 0: dosyanın
  kendi sesi duyulmaz). Seslendirmeyle aynı dildeki altyazı sesin zamanını izler (`follow_dub`); jump cut okunan
  cümlelerin altını kesmez. Metin ya da çeviri `dub`dan sonra değişirse seslendirme "eski" sayılır, altyazı sesi
  izlemez ve cevapta not düşülür.
- `speak_text`: dosya olmadan metin okur; kelimeler sesin zamanıyla bir transkripte yerleşir ve ses o transkriptin
  medyası olur. `render_captions` bundan koyu zeminli, seslendirmeli, altyazılı bir video yapar.
- Yerleştirme kuralları uygulamanın `tts.worker.ts` ve `useDubber.ts` dosyalarından taşındı (`src/dub.ts`); iki yerde
  aynı sayılar tutulmalı. Uygulamanın seslendirmesi tarayıcıda saklanır, `.harfiyen` dosyasında yoktur; MCP'ye alınamaz.
