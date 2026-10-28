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
| `list_transcripts`, `get_transcript`, `export_transcript` | Okuma; satırlar, düz metin, SRT, VTT, kelime zamanlı JSON |
| `edit_words`, `find_replace`, `shift_timing` | Düzeltme; değişmeyen kelimelerin zamanı korunur |
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
- Canlı mikrofon, seslendirme ve `.harfiyen` proje dosyası henüz yok.

## Altyazı stilleri ve yazı tipleri

`style`: `klasik`, `sade`, `karaoke`, `akis`, `odak`, `vurgu`, `pop`, `netles`, `tek-kelime`. `emphasis: true`
çevresinden yüksek sesle söylenen kelimeleri büyük yazar (web uygulamasındaki "Sesle vurgula" ile aynı seçim).

Web uygulamasının on yazı tipi `fonts/` altında TTF olarak gelir, kuruluma gerek kalmaz (`font: "Anton"` gibi).
Kendi yazı tipin için `font_file` (TTF ya da OTF) verilir. `uppercase` Türkçe kurala uygun büyük harf yazar
(i → İ); yalnızca büyük harfli Luckiest Guy, Bangers ve Bebas Neue'de otomatik açılır, yoksa "i" noktasız çıkar. Anton, Bebas Neue, Bangers ve Luckiest Guy tek kalınlıklı olduğundan kalın kapalı gelir (`bold`).
