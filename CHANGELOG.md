# Neler değişti

Yeni sürümler en üstte.

## v0.6.0 (6 Kasım 2026)

- **Metinden kurgu:** Transkriptte kelime seçip **Delete** (ya da **Alt+tıkla**) ile videodan kesilir. **Kurgu**
  modunda kelimeye tıklamak ya da üstünden sürüklemek yeter. Satırın makas düğmesi bütün satırı keser, kelimeler
  arasındaki **⏸** rozetleri tek tek sessizliği kısaltır. Kesilen yerler üstü çizili kalır, tekrar tıklayınca geri
  gelir; ⌘Z / Ctrl+Z ile de geri alınır. Oynatıcı, video, SRT ve VTT kesilmiş hâli kullanır.
- **Kelime bip'leme:** Transkriptte seçilen kelimeler **B** ile (ya da **Kelimeyi bip'le** ile) bip sesiyle
  değiştirilir. Kelimenin sesi tamamen gider. Altyazıda nasıl görüneceği **Altyazı → Bip'lenen kelimeler**'den
  seçilir: **Yıldız** (s****), **Buzlama** (mozaik), **Bant**, **Gizle** ya da **Açık**. SRT ve VTT'de buzlama ve bant
  yıldız olarak yazılır.
- **Mihu:** [mihuai/turkish-stt-66m-v2](https://huggingface.co/mihuai/turkish-stt-66m-v2) Türkçe konuşma tanıma
  modeli eklendi (~70 MB). Çok hızlı ve düşük gecikmelidir, canlı mikrofonda ve her cihazda çalışır.
- **Whisper ile 31 dil:** **Videodaki dil** iki düğmeden açılır menüye geçti. Whisper Türkçe ve İngilizcenin yanında
  Almanca, Fransızca, İspanyolca, İtalyanca, Portekizce, Hollandaca, Rusça, Lehçe ve 21 dilde daha yazıya döker
  (bu 21 dil deneysel). Seda, Mihu ve Duyu yalnızca Türkçe bilir; başka bir dil seçilince model Whisper Turbo
  Hafif'e geçer.
- **Çeviri altı dil arasında:** Türkçe, İngilizce, Almanca, Fransızca, İspanyolca ve Rusça arasında çevrilir;
  **Hedef dil** menüden seçilir. İngilizce olmayan çiftler İngilizce üzerinden iki adımda çevrilir. Çeviri
  seslendirmesi (Supertonic 3) bu dillerin hepsinde okur.
- **Kalınlık, italik ve harf aralığı:** Altyazıya üç yeni ayar geldi. Kalınlık, değişken yazı tiplerinde (Montserrat,
  Inter, Schibsted Grotesk, Literata ve yüklediğin değişken yazı tipleri) kendi aralığında ayarlanır. Gerçek italiği
  olan yazı tiplerinde italik kendi dosyasıyla, diğerlerinde eğilerek çizilir.
- **Arka planda video:** **Sahne → Arka plan**'a fotoğrafın yanında video da (MP4, WebM, MOV; en fazla 250 MB)
  konabilir. Sessiz ve döngüde oynar, kareyi kaplar; **Net** ya da **Bulanık** seçilir.
- **Çevrimdışı çalışma:** Uygulama bir kez açıldıktan sonra internet olmadan da açılır. Yeni sürüm yayınlanınca
  üstte **Yeni sürüm hazır** bildirimi çıkar; yenileyince yeni sürüme geçilir.
- **Sekmede ilerleme:** Yazıya dökme ve dışa aktarma sürerken ilerleme sekme başlığında ve favicon'da görünür;
  başka sekmedeyken de takip edilir.
- **MCP sunucusu:** Harfiyen'in motorları [MCP](https://modelcontextprotocol.io) sunucusu olarak da çalışır
  (`harfiyen-mcp`, ayrıntılar [mcp/README.md](mcp/README.md)'de). Yazıya döküm, çeviri, konuşmacı ayırma,
  seslendirme, metinden kurgu, bip'leme ve altyazılı video Claude Code gibi yapay zeka araçlarından kullanılabilir.
- Dil rozetleri, GitHub düğmesinde yıldız sayısı ve `llms.txt` eklendi.

**Düzeltmeler**

- Başka dile yeniden çevirip geri alınca çeviri artık eski diliyle geri geliyor.
- Videodaki dil yeni dosyada ve yeni projede Türkçeye dönüyor; önceki projeninki hatırlanmıyor.
- Service worker yalnızca bu sürümün dosyalarını önbelleğe alıyor; sunucunun döndürdüğü yedek sayfa artık script ya
  da manifest diye saklanmıyor.

## v0.5.0 (23 Ekim 2026)

Bu sürümdeki zaman düzenleme, metni sese hizalama ve elle tempo tutma
[emguts](https://github.com/emguts)'un [emguts/harfiyen](https://github.com/emguts/harfiyen) fork'undan uyarlandı;
ses düzeyi kaydırıcısını [vuxenn1](https://github.com/vuxenn1) ekledi. İkisine de teşekkürler.

- **Kinetik tipografi:** Yeni **Sahne** sekmesinde ekrandaki yazı seçilir: altyazı, kinetik tipografi ya da hiçbiri.
  Kinetik tipografi altyazı yerine bütün ekranı kullanır; sekiz stil var: 3D Düğüm, Pano, Fizik (Matter.js),
  2D Kamera, Poster, Darbe, Maske ve Tünel. Beş renk paleti ve bütün yazı tipleri (yüklediklerin de) seçilebilir.
  Ses dosyalarında aura ya da düz zeminin, videolarda görüntünün (olduğu gibi ya da bulanık) üstünde durur;
  videonun görüntüsü yerine aura konup yalnızca sesi de kullanılabilir. Oynatıcıda ve altyazılı MP4'te aynı görünür.
- **Yeni auralar:** Aura'nın yanına Halo, Ufuk, Küre ve Sırtlar geldi; beş renk paleti var (Çini, Gün batımı, Orman,
  Lavanta, Gece). Kadraj ses dosyalarında da çalışır.
- **Fotoğraf zemin:** **Sahne → Arka plan**'da auraların yanında kendi fotoğrafın da (JPEG, PNG, WebP; örneğin podcast kapağı)
  kullanılabilir. Kareyi kaplar, taşan kısmı kesilir; **Net** ya da **Bulanık** seçilir. Kinetik tipografi üstünde
  ince bir perdeyle durur. Fotoğraf logo gibi bu tarayıcıda saklanır, sonraki projelerde de hazırdır; videolarda
  seçilince videonun yalnızca sesi kullanılır.
- **Stil kartlarında kendi zeminin:** Altyazı ve kinetik stil kartları arkada projenin kendi zeminini gösterir:
  videonun karesi, fotoğraf ya da seçili aura. Yazının o zeminde nasıl okunduğu stil seçerken görülür.
- **Metin seslendir:** Boş ekrandaki **Metin seslendir** ile dosya olmadan yazdığın ya da yapıştırdığın metin yapay
  sesle okunur; kelimeler zamanlarıyla altyazıya ve oynatıcıya yerleşir, aura ya da kinetik tipografiyle videoya
  dönüşür.
- **Zaman düzenleme:** Satırın ya da tek kelimenin başlangıç ve bitiş zamanı transkriptten değiştirilir: yazarak,
  ±0,1 sn adımlarla, **Şu an** ile ya da **Alt + ← / →** ile. Bitişik kelimeler aradaki sınırla birlikte uzayıp
  kısalır. **Metin → Zamanlama** bütün altyazıyı çevirisiyle birlikte öne ya da geriye alır (**[** / **]**).
- **Metni sese hizala:** Elindeki doğru metni (şarkı sözü, konuşma metni, şiir) yapıştır; kelimeler metinden,
  zamanlar dökümden gelir. Kısa satırlı metinlerde her satır ayrı altyazı satırı olur. **Sesle ince ayar**
  Whisper'la kelimeleri doğrudan seste arar; şarkılarda ve gürültülü kayıtlarda fark eder.
- **Elle tempo tut:** Dökümün duymadığı bölümler için kayıt çalarken her satırın başında **Enter**'a basılır;
  satırdaki kelimeler o aralıkta duyulan zamanları alır. Tepki payı **+** / **−** ile ayarlanır.
- **Boşlukları kesme (jump cut):** **Metin** sekmesinde **Sessizlikleri at** kelimeler arasındaki uzun sessizlikleri
  videodan çıkarır; "ııı", "eee" gibi dolgu sesleri de istenirse kesilir. En kısa sessizlik ve konuşmanın iki
  yanında kalacak pay ayarlanır. Video, SRT ve VTT kesilmiş hâliyle dışa aktarılır; kapatınca video eski hâline döner.
- **Konuşmacı ayırma:** **Konuşmacıları ayır** kimin ne zaman konuştuğunu sesinden bulur
  ([3D-Speaker CAM++](https://github.com/modelscope/3D-Speaker), yaklaşık 28 MB). Konuşmacı sayısı seçilir ya da
  bulunur. Transkriptte adlar renkli yazar; konuşma başka birine verilir, adlar değiştirilir, aynı kişi birleştirilir.
  SRT, VTT, metin ve JSON'da adlar yer alır; istenirse altyazıda ve kinetik tipografide de görünür.
- **Ses düzeyi:** Oynatma çubuğundaki ses düğmesinin üstüne gelince ses düzeyi kaydırıcısı açılır. Seslendirmeyi de
  orijinal sesi de birlikte kısar; düzey tarayıcıda hatırlanır.
- **Whisper şarkıda ve sessizlikte daha az uyduruyor:** Döngüye giren bölüm kaldığı yerden yeniden çözülür, sonrası
  kaybolmaz. Müzik üstündeki şarkı da yazıya dökülür. "İzlediğiniz için teşekkürler", "Abone olmayı unutmayın" gibi
  sessizlikte uydurulan satırlar atılır.
- **Küçük videoda keskin altyazı:** 1080p'den küçük videolar varsayılan olarak 1080p dışa aktarılır; görüntü
  büyütülür, altyazı bu boyutta çizildiği için keskin çıkar. Kaynakla aynı boyut da seçilebilir.
- **Kesme tutamaçları:** Daha kalın ve tutması kolay. Kesimden sonra zaman çizelgesi yalnızca seçilen bölümü kaplar,
  **Kes**'e basınca yumuşak bir geçişle bütün dosyaya döner. Bitiş tutamacı en sona çekilince oluşan titreme giderildi.
- **Sekme adı:** Sağ paneldeki **Yazıya döküm** sekmesinin adı **Metin** oldu.

## v0.4.1 (20 Ekim 2026)

- **Ekran kartı olmadan video:** WebGPU'yu desteklemeyen tarayıcılarda ve ekran kartı bulunamayan bilgisayarlarda da
  altyazılı video oluşturulabilir. Görüntü 2D canvas'ta çizilir; daha yavaştır, buzlu cam ve aura sadeleşir. Dışa
  aktarma menüsü bunu not olarak gösterir.

## v0.4.0 (19 Ekim 2026)

- **Seda v0.2:** Seda, [seda-v0.2](https://huggingface.co/atasoglu/seda-v0.2)'ye geçti. Daha çok veriyle eğitildi;
  daha az hata yapıyor, özellikle gürültülü, yankılı ve telefon kalitesindeki seste. Dil modeli daha büyük. Eski v0.1
  dosyaları **Ayarlar**'dan silinebilir. Lisansı CC BY-SA 4.0.
- **Dosyalarda daha doğru Seda:** Dosyalar modelin 5,12 saniyelik parçalarla çalışan `final` sürümüyle, sekiz yollu
  aramayla yazıya dökülür (FLEURS-TR'de %6,4 hata). Mikrofon anında yazmak için 0,64 saniyelik parçalarla devam
  eder. İlk indirme yaklaşık 190 MB.
- **Ekran kartında daha hızlı Seda:** Ekran kartı seçiliyken Seda'nın dil modeli işlemcinin birden çok çekirdeğini
  kullanır; yazıya döküm daha hızlı biter.
- **Duraklamada kesinleşen cümleler:** Seda cümle sonlarını 1,2 saniyelik sessizlik kuralı yerine ses etkinliği
  algılayıcıyla (Silero VAD) bulur; canlı kayıtta kısa bir duraklamada metin kesinleşir. Uzun konuşmalar
  duraklamalarda bölünür.
- **Daha iyi noktalama:** Seda'nın dökümüne noktalama, büyük harf ve kesme işaretini seda-v0.2 ile gelen formatter
  modeli ekler. Cümle sonları, özel adlar ve kesme işaretleri çok daha isabetli ("TBMM'de", "Ahmet Bey'in"); model
  yaklaşık 30 MB, ilk kullanımda iner. Eski noktalama modeli dosyaları **Ayarlar**'dan silinebilir.
- **Çevir ve seslendir:** Çeviri gereken seslendirmede iki buton yerine tek buton var; önce çevirir, sonra okur.
  Çeviri modelinin indirilmesi, çeviri ve seslendirme aynı yerde yüzde ve ilerleme çubuğuyla görünür, **Durdur** ile
  durdurulabilir.
- **İngilizce videolar:** Yazıya dökmeden önce videodaki dil (Türkçe ya da İngilizce) seçilir; İngilizce videolar
  Whisper ile İngilizce yazıya dökülür, altyazı ve SRT/VTT İngilizce olur, Supertonic ile İngilizce seslendirilebilir.
  Dil projeyle saklanır.
- **İngilizceden Türkçeye çeviri:** İngilizce videonun transkripti
  [opus-mt-tc-big-en-tr](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-tr) ile Türkçeye çevrilir (yaklaşık
  360 MB, ilk kullanımda iner). Türkçe altyazı ve Türkçe seslendirme (voice-over) yapılabilir.
- **Seslendirme projeyle saklanır:** Proje yeniden açılınca seslendirme yeniden yapılmadan hazırdır; ses ayarı da
  onunla gelir. Transkript ya da çeviri sonradan değiştiyse eskidiği söylenir. Proje silinince seslendirmesi de
  silinir.
- **Altyazısız video:** Altyazı sekmesindeki **Altyazıyı göster** kapatılınca oynatıcıda ve dışa aktarılan videoda
  altyazı olmaz; varsa kadraj, logo ve seslendirme kalır. Dosya adı `.altyazili.mp4` yerine `.seslendirme.mp4` (ya da
  `.mp4`) olur. Seçim projeyle saklanır; yeni projeler altyazılı başlar.
- **Açık tema:** **Ayarlar → Görünüm**'den Sistem, Açık ya da Koyu seçilir. Varsayılan sistemin teması; sistem
  teması değişince uygulama da değişir. Oynatıcının çevresi videonun renkleri doğru görünsün diye her iki temada da
  koyu kalır.
- **İngilizce seslendirme (voice-over):** Seslendirme sekmesinde dil İngilizce seçilince çeviri
  [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) ile okunur (203 MB, ilk kullanımda iner). Her
  cümle Türkçesinin başladığı anda başlar. On ses var: Alex, James, Robert, Sam, Daniel, Sarah, Lily, Jessica,
  Olivia, Emily. Supertonic Türkçe de okur; Türkçe seslendirmede dördüncü ses olarak seçilebilir.
- **Orijinal ses seviyesi:** Seslendirme açıkken orijinal ses %0 ile %50 arasında altta duyulabilir; oynatıcıda ve
  altyazılı MP4'te aynı karışım kullanılır.
- **Altyazı seslendirmeyi takip eder:** Altyazı seslendirmeyle aynı dildeyse her cümle sesinin başladığı ve bittiği
  anda görünür; SRT/VTT ve altyazılı MP4 de bu zamanları kullanır.
- **Seslendirme videoya sığar:** Modellerin cümle başına ve sonuna koyduğu sessizlik kırpılıyor, seslendirme zamanla
  geride kalmıyor. Videonun sonuna taşan cümleler geriye kayar ve gerekirse biraz hızlanır; yine sığmazsa uyarı
  çıkar, **Cümleye git** ve seçili bölümde **Bölümü uzat** ile düzeltilir.
- **Kırpma düğmeleri:** Seçili oranın ve modun üstüne gelince yazı artık kaybolmuyor.
- **Logo:** Altyazı sekmesinden kendi logonu (PNG, SVG, WebP ya da JPEG) ekleyebilirsin. Seçtiğin köşede durur;
  boyutu ve saydamlığı ayarlanır. Önizlemede ve altyazılı videoda aynı görünür, kadrajlı videoda yeni kareye
  göre yerleşir. Logo bu tarayıcıda saklanır ve sonraki projelerde de hazırdır; her projede gizlenebilir.
- **Kadraj:** Oynatıcının üstündeki kırpma düğmesiyle (ya da **C**) video 9:16, 4:5, 1:1, 16:9 ya da serbest
  oranda kadrajlanır. **Doldur** kareyi kaplar; kutu sürüklenir, köşelerinden boyutlandırılır, taşan kısım
  kesilir. **Sığdır** videonun tamamını karenin içine sığdırır; boşluklar bulanık ya da siyah olur. Altyazı
  yeni kareye göre yerleşir, kadraj projeyle birlikte saklanır. 4K yatay videodan dikey Reels çıkarmak için:
  9:16'da dışa aktarma 1080×1920 önerir.
- **Kes:** Zaman çizelgesinin sonundaki **Kes** düğmesiyle videonun kullanılacak bölümü seçilir; uçlar
  sürüklenir ya da oynatırken **I** ve **O** ile işaretlenir. Yalnızca o bölüm yazıya dökülür, oynatılır ve dışa
  aktarılır; video ve SRT/VTT zamanları 0:00'dan başlar. 20 dakikalık videodan 30 saniye seçilince yalnızca
  30 saniye işlenir.
- **Yazıya döküm düğmeyle başlar:** Dosya açılınca hemen dökülmez; önce kadraj ve bölüm seçilebilir, sonra
  **Yazıya dök**. Yeniden dökmek yeni proje açmaz; eski transkript ⌘Z ile geri gelir.
- **Ses grafiği hemen görünür:** Dosya açılınca ses grafiği çizilir, bölüm seçerken konuşmanın yeri görülür.
  Henüz dökülmemiş kısım soluk, döküm ilerledikçe dökülen kısım rengine kavuşur.
- **Seslendirme modeli** açılır listeden seçiliyor; listede her sesin boyutu ve kısa açıklaması görünür.
- **Yeni ses Ahenk Cep:** Seslendirmeye üçüncü ses olarak
  [Ahenk Cep](https://huggingface.co/ozgurguler/ahenk-cep-tr) eklendi. 18 MB, ekran kartı istemez. Rakamları,
  tarihleri ve kısaltmaları diğer seslerden daha doğru okur ("Dr.", "TBMM'de"); biraz daha yavaştır.

## v0.3.0 (15 Ekim 2026)

- **Yeni model Duyu:** [Duyu-small](https://huggingface.co/KaanAydinli/Duyu-small) eklendi. 85 MB,
  ekran kartı istemez; noktalama ve büyük harfi kendisi yazar. İşlemcide çalışır, canlı kayıtta
  kullanılmaz.
- **Durdur, devam et, iptal:** Yazıya dökme durdurulup sonra kaldığı yerden sürdürülebilir; sayfa
  yenilense de kalınan yer unutulmaz. Yanlış dosya İptal ile bırakılır, uzun işlerde önce onay sorulur.
  Döküm sürerken önizleme yazılanı takip eder; oynatınca ya da sarınca takip durur.
- **İngilizce çeviri:** Transkript cümle cümle İngilizceye çevrilir; her cümle Türkçesinin zamanında
  görünür. Transkriptin üstündeki TR / EN ile altyazı, dışa aktarma ve video istenen dilde olur. Çeviri
  düzenlenebilir ve projeyle birlikte kaydedilir. Çeviri de tarayıcıda yapılır, metin bilgisayarından
  çıkmaz.
- **Ayarlar ve model yönetimi:** Yeni Ayarlar penceresinde hangi modelin indirildiğini, ne kadar yer
  kapladığını görebilir; modelleri tek tek indirip silebilirsin. Bu cihaza uygun modellerin hepsi tek
  düğmeyle indirilebilir. Silmek için artık tarayıcının site verilerini (ve onunla projelerini)
  temizlemen gerekmez.
- **Kaldığı yerden devam eden indirme:** Büyük modeller parça parça iner. Bağlantı koparsa ya da sekme
  kapanırsa indirme baştan değil, kaldığı yerden sürer.
- **Yeni altyazı stilleri:** Akış, Tek kelime, Dolgu, Netleş, Cam ve Odak. Stiller Sakin, Vurgulu ve İri
  diye gruplara ayrıldı. Cam'da arkadaki video buzlu camla bulanıklaşır; Odak ve Netleş'te kelimeler
  bulanıktan netleşir.
- **Sesle vurgula:** Yüksek sesle söylenen kelimeler altyazıda büyür ve vurgu renginde yazılır. Yeni
  projeler kapalı başlar.
- **Stil değişince ayarlar korunur:** Elle değiştirdiğin zemin, renk, boyut gibi ayarlar başka stile
  geçince kaybolmaz. **Stilin varsayılanlarına dön** ile stilin kendi görünümüne dönülür.
- **Altyazı ortalaması:** Altyazı artık büyük harflerin yüksekliğine göre ortalanıyor; kutunun içinde aşağıda
  durmuyor. Her yazı tipinde aynı şekilde çalışır.
- **Yazı tipleri:** Bangers ve Luckiest Guy eklendi. Kendi yazı tipini de (TTF, OTF, WOFF, WOFF2)
  yükleyebilirsin.
- **Sayı yazımı:** Sayılar kurala göre ya da hepsi rakamla yazılır; istersen hiç dokunulmaz. Ekler, sıra
  sayıları, tarih ve saat de doğru yazılır ("15.30'da"). Düğme hangi sayıların değişeceğini gösterir.
- **Video çıktısı:** Dışa aktarırken video kodlamasını (H.264 ya da HEVC), çözünürlüğü (kaynakla aynı,
  1080p ya da 720p) ve kaliteyi seçebilirsin; dosya boyutu baştan tahmin edilir. Büyük videolar belleğe değil diske yazılır.
  Tarayıcının açamadığı video kodlamaları işe başlamadan bildirilir.
- **Daha isabetli kelime zamanları:** Seda'nın yaklaşık 150 ms'lik gecikmesi düzeltildi. Whisper cümle
  başındaki ve sonundaki sessizliği artık kelimeye katmıyor, altyazı konuşmaya daha iyi oturuyor.
- **Noktalama:** Özel adlardaki kesme işareti kuralları düzeltildi, tanınan yer adı listesi genişletildi.
- **Hakkında ve lisans:** Ayarlar'da sürümü ve bağlantıları gösteren Hakkında bölümü var. Harfiyen artık MIT
  lisanslı.
- **Mobil:** Telefonda model, işlemci ve ayarlar düğmeleri tek bir **⋯** menüsünde toplandı.
- **Düzeltmeler:** Safari'de proje silinemiyordu, düzeltildi. Proje silme onayı artık tarayıcının açılır
  penceresinde değil, listenin içinde soruluyor. İndirilen model dosyaları kullanılmadan önce
  doğrulanıyor; bozuk ya da yarım kalmış bir dosya yeniden indiriliyor.

## v0.2.0 (12 Ekim 2026)

- **Seslendirme:** Transkript, [EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning) ya da
  [Antalia Mini](https://huggingface.co/cloud0day3/antalia-mini) ile yapay bir Türkçe sesle yeniden okunur.
  Her satır kendi zamanında başlar. Oynatıcı ve altyazılı video yapay sesi kullanabilir, ses WAV olarak da
  indirilebilir.
- **Bul ve değiştir (⌘F / Ctrl+F):** Yanlış tanınan bir kelimeyi ya da ismi bütün transkriptte tek seferde
  düzelt. Büyük/küçük harfe bakmaz, Türkçe harfleri doğru eşler; istersen yalnızca tam kelimeleri bulur.
  Değiştirme tek adımda geri alınır.
- **SRT ve VTT açma:** Hazır altyazıyı aç, stilini seç, videoya yaz. Açık bir video varsa altyazı ona
  bağlanır. Altyazının satırları ve zamanları korunur; düzeltip yeniden SRT ya da VTT olarak indirebilirsin.
  Eski Windows araçlarıyla kaydedilmiş Türkçe dosyalar da doğru okunur.

## v0.1.0 (11 Ekim 2026)

İlk herkese açık sürüm. Harfiyen, Türkçe konuşmayı tarayıcıda yazıya döker ve altyazıyı videonun içine
yazar. Ses ve video bilgisayarından çıkmaz.

- **Tarayıcıda yazıya döküm:** [seda-v0.1](https://huggingface.co/atasoglu/seda-v0.1) modeli ekran
  kartında (WebGPU) çalışır. WebGPU yoksa işlemciye geçilebilir.
- **Whisper Turbo ve Whisper Turbo Hafif:** Daha az hata yapar, noktalamayı ve rakamları kendisi yazar.
  Yalnızca dosyalarda ve WebGPU ile çalışır.
- **Dosyalar:** MP4, MOV, MKV, WebM, MP3, M4A, WAV, FLAC, OGG. Uzun dosyalar parça parça işlenir.
- **Canlı mikrofon:** Konuşurken kelimeler yaklaşık bir saniye sonra belirir (Seda modeliyle).
- **Otomatik noktalama ve büyük harf:** Özel ad eklerine kesme işareti de eklenir ("İstanbul'da").
  ⌘Z / Ctrl+Z ile geri alınabilir.
- **Altyazı stilleri:** Altyazılı video olarak dışa aktarılabilir.
- **Projeler:** Kaydedilir, sonra kaldığın yerden açılır.
