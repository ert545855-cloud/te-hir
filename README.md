# Raf Takip

Mağaza (A–D rafları, 33 sıra × 3 kat) ve dış depodaki teşhir ürünleri ile boş kutuları fotoğraflı kaydedip kuşbakışı haritada bulmak için.

- Fotoğraf çek → ad, marka, durum, raf/sıra/kat → kaydet
- Arama: ada/markaya göre, sonuç haritada yanıp söner
- Gerçek zamanlı: Socket.io ile tüm telefonlarda anında güncellenir
- Ayarlar: raflara marka bölgesi ekle/çıkar, dış depoya raf ekle

## Ortam değişkenleri
- `DATABASE_URL` — Postgres (yoksa yerel `data.json` kullanılır)
- `APP_PIN` — (isteğe bağlı) kayıt/silme için ekip PIN'i
- `ANTHROPIC_API_KEY` — (isteğe bağlı) fotoğraftan ürün adı/marka tanıma

`npm install && npm start`
