# bu proje artık maintain edilmeyecektir

# HDFilmCehennemi Stremio Addon

HDFilmCehennemi içeriklerini Stremio üzerinden izlemenizi sağlayan bir addon.

maintain hakkında: hdfilmcehennemi 1 haftalık gözlemime göre her gün bazende günde 2 defa şifreleme algoritmasını değiştiriyor. Bunu çözmek için kodu güncelledim fakat farklı bir adım eklerse tekrardan güncellemek gerekecek. Kısacası kullanmadan önce 'node test' yazarsanız eğer orda şifrelenmiş bir şey yok ise sıkıntı yok demektir fakat var ise de issue açabilirsiniz çözmeye çalışırım, bu aralar çok fazla film/dizi izleyemiyorum her gün bakamıyorum maalesef.[Şu anki şifreleme](https://github.com/enXov/hdfilmcehennemi-stremio/blob/main/scraper.js#L390)

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
| `PROXY_ENABLED` | auto | Proxy modu: `auto` (gerektiğinde), `always` (her zaman), `never` (kapalı) |

### Örnek .env

```env
PORT=7000
BASE_URL=http://localhost:7000
LOG_LEVEL=info
PROXY_ENABLED=auto
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
├── addon.js      # Stremio addon sunucusu
├── scraper.js    # Video/altyazı çekme modülü
├── search.js     # İçerik arama ve eşleştirme
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
