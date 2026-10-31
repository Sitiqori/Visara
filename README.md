# VISARA – Asisten AI Visual untuk Tunanetra

Alur: **Kenali → Pahami → Jelaskan**
- **Kenali**: Gemini (vision) menentukan jenis visual (struk/grafik/foto/dll) + ekstraksi data, sekaligus OCR terpisah.
- **Pahami**: validasi kode (bukan AI): angka hasil ekstraksi dicocokkan dengan OCR, total struk dihitung ulang. Yang tidak cocok ditandai *belum pasti*.
- **Jelaskan**: narasi audio dibuat hanya dari data tervalidasi, lalu dibacakan (suara browser, bahasa Indonesia).

## Cara menjalankan
1. Install **Node.js 18+** (nodejs.org).
2. Buka terminal di folder ini, lalu:
   ```
   npm install
   cp .env.example .env      # Windows: copy .env.example .env
   ```
3. Ambil **API key gratis** di https://aistudio.google.com/apikey (login akun Google, tanpa kartu kredit), lalu isi `GEMINI_API_KEY` di `.env`.
4. Jalankan: `npm start`
5. Buka **http://localhost:3000** di laptop (disarankan Chrome).

## Membuka di HP
Kamera, mikrofon, dan perintah suara di HP butuh **HTTPS**. Cara termudah, tanpa deploy:
```
npx cloudflared tunnel --url http://localhost:3000
```
(atau `npx ngrok http 3000`). Buka link https yang muncul di HP. Atau deploy ke Render / Railway / Vercel
(isi `GEMINI_API_KEY` di environment variables mereka).

## Catatan
- AI memakai **Google Gemini (tier gratis)**. Batasnya sekitar belasan permintaan per menit; satu pemindaian = 3 permintaan.
  Kalau muncul "kuota penuh", tunggu semenit.
- Di tier gratis, Google boleh memakai data masukan untuk meningkatkan modelnya, dan tier gratis ditujukan untuk
  prototipe/belajar. Jangan kirim gambar pribadi (KTP, rekam medis) dan sebutkan hal ini di esai.
- API key hanya di server (`.env`), jangan diunggah ke GitHub.
- Suara = text-to-speech bawaan browser; perintah suara = pengenalan suara bawaan browser (paling baik di Chrome).
- Struktur: `server.js` (backend 4 endpoint), `public/index.html` (UI), `public/logo.png`.

## Deploy gratis ke Render (HTTPS otomatis, jadi kamera dan mikrofon di HP jalan)
1. Unggah folder ini ke GitHub. **Jangan** unggah file `.env` (sudah diblokir oleh `.gitignore`).
2. Di render.com, daftar dengan akun GitHub, lalu **New + > Web Service** dan pilih repo ini.
3. Isi: Language **Node**, Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
4. Di **Environment Variables**, tambahkan `GEMINI_API_KEY` (isi dengan key-mu). Opsional: `MODEL_MAIN`.
5. Klik **Create Web Service**, tunggu build selesai, lalu buka alamat `https://nama-layananmu.onrender.com` di Chrome.

Catatan tier gratis: layanan **tidur setelah 15 menit tanpa kunjungan** dan butuh sekitar 1 menit untuk bangun lagi.
Sebelum demo atau presentasi, buka alamatnya 5 menit sebelumnya dan lakukan satu kali pindai.
Kuota API gratis dipakai bersama semua orang yang membuka link, jadi jangan disebar luas.