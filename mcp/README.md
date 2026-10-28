# Harfiyen MCP

Harfiyen'in motorlarını [MCP](https://modelcontextprotocol.io) sunucusu olarak çalıştırır: yazıya döküm, noktalama,
çeviri, konuşmacı ayırma, boşluk kesme planı ve altyazılı video. Web uygulamasıyla aynı kod ve aynı modeller
kullanılır (`../src`); ses ve video bilgisayardan çıkmaz.

Tarayıcıya bağlı kısımlar (WebGPU oynatıcı, 11 altyazı stili, aura, kinetik tipografi, seslendirme) burada yoktur.
Altyazılı video ffmpeg ve libass ile yazılır; web uygulamasının dokuz stili vardır (cam, aura ve kinetik tipografi yok).

## Kurulum

Depo kökünde `npm install` ve `npm run models` (modeller `public/models` altına iner), sonra:

```sh
cd mcp && npm install
```

ffmpeg ve ffprobe PATH'te olmalı. Modeller `HARFIYEN_MODELS` ile başka bir klasörden de okunabilir.
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
| `list_transcripts`, `get_transcript`, `export_transcript` | Okuma; satırlar, düz metin, SRT, VTT, kelime zamanlı JSON |
| `edit_words`, `find_replace`, `find_text` | Düzeltme ve arama; değişmeyen kelimelerin zamanı korunur. `find_text` eşleşmelerin yerini ve zamanını listeler |
| `retime_words`, `shift_timing` | Bir satırın ya da kelimenin zamanı; bütün altyazıyı kaydırma |
| `edit_translation` | Çeviriyi düzeltme (`find_replace` de `language: translation` ile çeviride çalışır) |
| `assign_speaker`, `merge_speakers`, `rename_speaker` | Konuşmacıyı elle düzeltme: bir satırı başkasına verme, iki kişiyi birleştirme, adlandırma |
| `punctuate`, `apply_numbers` | Metni düzelttikten sonra noktalamayı ve sayı yazımını yeniden uygulama |
| `undo`, `history` | Son 20 düzenlemeyi geri alma; kelimeler, zamanlar, çeviri ve konuşmacılar birlikte döner |
| `align_text` | Doğru metni (şarkı sözü, konuşma metni) dökümün zamanlarına hizalar |
| `translate` | TR ↔ EN, cümle cümle |
| `tell_speakers`, `rename_speaker` | Kim ne zaman konuşuyor; adlar SRT, VTT ve videoda görünür |
| `plan_jump_cut` | Kesilecek sessizlikleri ve dolgu seslerini listeler |
| `render_captions` | Altyazıyı videoya yazar: stil, yazı tipi, sesle vurgula, jump cut ve 9:16 / 4:5 / 1:1 / 16:9 kadraj |
| `job_status` | `background: true` ile başlatılan işin durumu |

Uzun işler tek tek, sırayla çalışır (modeller belleği paylaşır) ve ilerleme bildirimi gönderir.

## Sınırlar

- Her şey işlemcide çalışır. Seda ve Duyu hızlıdır; Whisper Turbo gerçek zamandan uzun sürebilir.
- Altyazı stilleri web uygulamasındakinin yakın bir taklididir, birebir aynı görünmez.
- Canlı mikrofon ve seslendirme henüz yok.

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
| Sesle vurgula, konuşmacı adı | aynen |
| Kadraj | kırpma kutusu (köşe ve boyutuyla), ya da sığdır ve siyah / bulanık zemin |
| Boşluk kesme | açıksa aynı ayarlarla |

Burada çizilemeyenler cevapta "Not:" olarak bildirilir: cam stili, kinetik tipografi, projeye özel yüklenmiş yazı tipi
(dosyası projede yok; `font_file` verilir), gizli altyazı, gizli ya da bulanık görüntü, arka plan fotoğrafı.
Style değiştirirsen projenin o stile ait boyutu, konumu ve zemini kullanılmaz (pop'un boyutu sade'de anlamsız olurdu).
