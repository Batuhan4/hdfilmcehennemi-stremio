# HDFilmCehennemi Stremio Addon

HDFilmCehennemi içeriklerini Stremio üzerinden izlemenizi sağlayan bir addon.

> **Not:** Bu depo, [enXov/hdfilmcehennemi-stremio](https://github.com/enXov/hdfilmcehennemi-stremio) projesinin sürdürülen (maintained) bir fork'udur. Orijinal proje bakım almıyordu; bu fork'ta güncel domain, yapılandırılabilir alan adı, varsayılan olarak kapalı proxy ve bir dizi hata/performans düzeltmesi yapıldı. Ev ağında (LAN) yerel kullanım için tasarlandı — internete açılmaz.

## 🚀 Bu fork'taki değişiklikler

- **Güncel domain:** `.ws` → `.nl` geçişi yapıldı. Alan adı artık `SITE_DOMAIN` / `EMBED_DOMAIN` ortam değişkenleriyle yapılandırılıyor (`config.js`) — site domain değiştirdiğinde kodu düzenlemeye gerek yok, tek satır ayar.
- **Proxy varsayılan olarak kapalı** (`PROXY_ENABLED=never`): proxy katmanı yalnızca Türkiye **dışından** Cloudflare engelini aşmak içindir. Türkiye'de doğrudan erişim olduğu için gerek yok; kod korundu ama kapalı geliyor.
- **Hata düzeltmeleri:**
  - Cloudflare "challenge" yanlış-pozitif tespiti düzeltildi — proxy kapalıyken normal sayfalardaki `challenge-platform` scriptleri yüzünden **her scrape başarısız oluyordu**.
  - Proxy URL kodlaması `base64url`'e çevrildi (uzun m3u8 URL'lerindeki `+` karakterinin sorgu dizesinde bozulması).
  - Video akışında backpressure düzeltmesi (`stream.pipeline`) — hızlı kaynak + yavaş istemcide bellek şişmesi önlendi.
  - Çeşitli null-güvenliği, timeout ve çift-gönderim (double-send) düzeltmeleri.
- **Performans:** başarılı sonuçlar için TTL'li bellek içi cache (tekrar isteklerde ~700 ms → ~3 ms); her istekte yapılan gereksiz ses-parçası (audio track) çekme işlemi opsiyonel hâle getirildi.
- **Güncel embed formatı çözümü:** site video URL'ini artık sayfa içi bir inline decoder fonksiyonuyla veriyor; `parseInlineDecoder` bu fonksiyonu ayrıştırıp yorumluyor (adım sırası/şifreleme her sayfada değişse de kendini uyarlıyor), eski packed-JS ve JSON-LD yolları fallback olarak duruyor.
- **Dizi (series) desteği:** `/dizi/` sayfaları Cloudflare'in JA3 (TLS parmak izi) botgeçidinde undici'ye `403` veriyor; bu sayfalarda sistem `curl`'üne düşen bir fallback (`curlClient.js`) ile aşılıyor. Filmler hızlı undici yolunda kalır; fallback yalnızca gerektiğinde tetiklenir.
- **Dublaj / Altyazı ayrı seçenek:** iki dilli (dual-audio) içeriklerde tek stream yerine **iki ayrı seçenek** sunuluyor — "🎙️ Türkçe Dublaj" ve "📝 Orijinal + Altyazı". Her biri proxied master m3u8'de ilgili ses grubunu `DEFAULT=YES` yapıyor; altyazı seçeneği Türkçe altyazıyı default olarak enjekte ediyor. Tek sesli içerik/dizilerde tek seçenek kalır.
- **Altyazı düzeltmesi:** altyazılar artık jwplayer `tracks[]` dizisinden de okunuyor (site altyazıları `<video><track>` yerine burada veriyordu, bu yüzden eskiden 0 altyazı dönüyordu).

> **Durum:** HDFilmCehennemi embed/şifreleme formatını sık sık değiştiriyor; extraction bu fork'ta kendini uyarlayan bir inline-decoder ayrıştırıcısıyla güncel tutuluyor ve film + dizi uçtan uca çalışır durumda. Yine de site formatı değiştirdiğinde ara sıra güncelleme gerekebilir; kullanmadan önce `npm test` ile doğrulayabilirsiniz.

## Özellikler

- 🎬 Film ve dizi desteği
- 🎙️ Çoklu ses seçeneği (Türkçe dublaj, orijinal ses)
- 📝 Altyazı desteği
- 🔄 Otomatik alternatif kaynak geçişi

## Kurulum Seçenekleri

### Seçenek 1: Kendi Sunucunuzda Çalıştırma

Bu addon'u kendi VPS/sunucunuzda çalıştırabilirsiniz. 

NOTLAR:
Stremio sadece HTTPs kabul ediyor, yani bir domain veya reverse proxy şart.
Eğer sunucunuz Türkiye dışında ise ki genellikle dışında olur o zaman normal proxy'e ihtiyacınız var. HDFilmCehennemi nedense erişimi Türkiye dışındaki ülkelere erişimi kısıtlamış(cloudflare). Fakat özellikle proxy belirlemenizi önermem çünkü şuanda public free http, socks4, socks5 proxy list kullanıyoruz Türkiye lokasyonlu.

FREE PUBLIC PROXY LIST GÜVENİLİR Mİ??????: kişiden kişiye değişir fakat %99.99999 ihtimal ile güvenli, proxy sahibi sadece nereye istek attığınızı(hdfilmcehennemi) ve SUNUCUNUZUN IP adresini görüyor ve bazı başka gereksiz şeyleri de görüyor fakat görse bir şey olmaz çünkü atılan istek zaten HDFilmCehennemi sitesi bunu bilse bir şey olmaz. Sadece search/scraping için proxy kullanıyoruz, video url normal bir şekilde proxysiz oynatılıyor.

EĞER LOCALHOST DA ÇALIŞTIRIYOR İSENİZ PROXY AKTİF OLMAYACAKTIR!

eğer plugin'i render.com gibi servisler ile çalıştırmayı denerseniz yaklaşık 3-4 dakika da bazen de hiç bir sonuç alamayabilirsiniz. Bu yüzden kendi sunucunuzda çalıştırmayı gözden geçirin. Şu an tüm proxy sourcelar merge edilip aynı anda 100 tanesi deneniyor bunu istemiyorsanız kodu inceleyip kendinize göre düzeltirsiniz. Şu anda free olarak toplam 80-85 tane var hepsi birleşince. Ben kendi sunucumda çalıştırdığım zaman 10 saniyeden küçük bir rakamda sonuç bulabiliyor yani demem o ki bunun için paralı bir proxy'e falan ihtiyaç yok.

sunucunuzun nginx ayarlarından timeout ayarını arttırmak isteyebilirsiniz, free proxyler bazen kafayı yiyebiliyor xd burayı bi, ara düzenlemek lazım yazılar kötü gözüküyor xd

ben bu eklentiyi asıl olarak televizyondan izlemek için yapmıtşım. Fakat bu eklentiyi tv'den denediğiniz zaman nedense streamio android ve tv uygulaması tam olarak destek vermiyor, proxyHeaders ve bazı şeylere destek vermiyor. O yüzden tüm video url'yi yani direkt olarak tüm filmi veya bölümü sunucu proxysilenerek izleniyor.

### Seçenek 2: Yerel Olarak Çalıştırma

Bilgisayarınızda yerel olarak çalıştırabilirsiniz (sadece aynı ağdaki cihazlarda çalışır).

## 💻 Yerel Kurulum

### Gereksinimler

- Node.js 18+
- npm

### Kurulum

```bash
# Repoyu klonla
git clone https://github.com/enXov/hdfilmcehennemi-stremio.git
cd hdfilmcehennemi-stremio

# Bağımlılıkları yükle
npm install

# Addon'u başlat
npm start
```

Addon varsayılan olarak `http://localhost:7000` adresinde çalışır.

---

## 🔧 Yapılandırma

### Ortam Değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `PORT` | 7000 | Sunucu portu |
| `BASE_URL` | http://localhost:7000 | Addon sunucusunun public URL'i (TV oynatımı için gerekli) |
| `LOG_LEVEL` | info | Log seviyesi (debug, info, warn, error) |
| `SITE_DOMAIN` | hdfilmcehennemi.nl | Ana site alan adı (site alan adı değiştirdiğinde güncelleyin) |
| `EMBED_DOMAIN` | hdfilmcehennemi.mobi | Video oynatıcı (embed) alan adı |
| `PROXY_ENABLED` | never | Proxy modu: `never` (kapalı — Türkiye'den doğrudan erişim), `auto` (Cloudflare engellerse), `always` (her zaman) |

### Örnek .env

```env
PORT=7000
BASE_URL=http://localhost:7000
LOG_LEVEL=info
SITE_DOMAIN=hdfilmcehennemi.nl
PROXY_ENABLED=never
```

Örnek kullanım:
```bash
PORT=8080 LOG_LEVEL=debug npm start
```

---

## 🧪 Test

```bash
npm test
```

---

## 📁 Proje Yapısı

```
├── addon.js      # Stremio addon sunucusu + m3u8 proxy
├── config.js     # Alan adı / proxy yapılandırması (SITE_DOMAIN, EMBED_DOMAIN, PROXY_ENABLED)
├── scraper.js    # Video/altyazı çekme modülü
├── search.js     # İçerik arama ve eşleştirme
├── proxy.js      # Proxy list yönetimi (varsayılan kapalı)
├── logger.js     # Log sistemi
├── errors.js     # Hata sınıfları
├── test.js       # Test scripti
└── package.json
```

---

## 📜 Lisans

MIT License - Detaylar için [LICENSE](LICENSE) dosyasına bakın.

## ⚠️ Sorumluluk Reddi

Bu addon yalnızca eğitim amaçlıdır. İçeriklerin telif hakları sahiplerine aittir. Addon geliştiricisi içeriklerden sorumlu değildir.
