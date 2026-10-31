// VISARA backend: alur Kenali -> Pahami -> Jelaskan
import "dotenv/config";
import express from "express";
const KEY = process.env.GEMINI_API_KEY;
const MAIN = process.env.MODEL_MAIN || "gemini-3.1-flash-lite";
const OCR = process.env.MODEL_OCR || MAIN;
if (!KEY) console.warn("PERINGATAN: GEMINI_API_KEY belum diisi di file .env");

const app = express();
app.use(express.json({ limit: "15mb" }));
app.set("trust proxy", 1); // di balik proxy hosting (Render dll.) agar IP pengguna terbaca benar

// Pembatas sederhana: melindungi kuota API gratis dari penyalahgunaan (default 40 permintaan/menit per IP)
const hits = new Map();
app.use("/api", (req, res, next) => {
  const now = Date.now(), max = Number(process.env.RATE_LIMIT || 40);
  const arr = (hits.get(req.ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= max) return res.status(429).json({ error: "Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.", busy: true });
  arr.push(now); hits.set(req.ip, arr); next();
});
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k); }, 60000).unref();
app.get("/healthz", (_req, res) => res.send("ok")); // untuk pemeriksaan kesehatan hosting

app.use(express.static("public"));

// ---------- helper: panggil Gemini (gratis lewat Google AI Studio) ----------
// Bila satu model sibuk (503/429), otomatis coba ulang lalu pindah ke model cadangan.
const FALLBACKS = ["gemini-3-flash-preview", "gemini-2.5-flash-lite", "gemini-2.5-flash"];
const chain = (first) => [...new Set([first, ...FALLBACKS])];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function llm(model, system, content, max_tokens = 1500, opts = {}) {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
  const parts = blocks.map((b) => b.type === "image"
    ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
    : { text: b.text });
  // "think" = batasi proses berpikir internal model supaya jawaban jauh lebih cepat
  const mk = (m, think) => {
    const gc = { maxOutputTokens: Math.max(max_tokens, 3000), temperature: 0.2 };
    if (/HANYA JSON/.test(system)) gc.responseMimeType = "application/json";
    if (think && /^gemini-3/.test(m)) gc.thinkingConfig = { thinkingLevel: "low" };
    else if (think && /^gemini-2\.5/.test(m)) gc.thinkingConfig = { thinkingBudget: 0 };
    return JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }], generationConfig: gc,
      ...(opts.search ? { tools: [{ google_search: {} }] } : {}) });
  };

  let lastStatus = 0, lastMsg = "";
  for (const m of chain(model)) {
    let think = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r, j = {};
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY || "" },
          body: mk(m, think), signal: AbortSignal.timeout(opts.timeout || 45000) });
        j = await r.json().catch(() => ({}));
      } catch (e) { lastStatus = 503; lastMsg = e.message; console.warn(`[${m}] ${e.message}`); break; } // timeout -> model berikutnya
      if (r.ok) {
        const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
        if (text) { console.log("model dipakai:", m); return text; }
        lastStatus = 422; lastMsg = "jawaban kosong/diblokir"; break;
      }
      lastStatus = r.status; lastMsg = j.error?.message || r.statusText;
      console.warn(`[${m}] ${r.status}: ${lastMsg}`);
      if (r.status === 400 && think && /think/i.test(lastMsg)) { think = false; continue; } // model tak dukung thinkingConfig
      if ([400, 401, 403].includes(r.status) && /API key|permission|key/i.test(lastMsg))
        throw new Error("API key tidak valid. Cek GEMINI_API_KEY di file .env");
      if ([429, 500, 502, 503, 504].includes(r.status)) await sleep(600); // sibuk -> langsung model berikutnya
      break;
    }
  }
  const busy = [429, 500, 502, 503, 504].includes(lastStatus);
  const e = new Error(busy ? "Server AI gratis sedang ramai. Tunggu sebentar lalu coba lagi."
    : "AI belum bisa memproses gambar ini (" + lastMsg.slice(0, 120) + ")");
  e.busy = busy;
  throw e;
}
function toJSON(text) {
  const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Jawaban AI tidak berformat JSON");
  return JSON.parse(m[0]);
}
function imageBlock(dataUrl) {
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw new Error("Gambar tidak valid");
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const wrap = (fn) => async (req, res) => {
  try { const t0 = Date.now(); const out = await fn(req.body); console.log(`${req.path} selesai ${Date.now() - t0} ms`); res.json(out); }
  catch (e) { console.error(e); res.status(e.busy ? 503 : 500).json({ error: e.message || "Terjadi kesalahan", busy: !!e.busy }); }
};

// ---------- 1. KENALI: jenis visual + ekstraksi (2 jalur independen) ----------
const SYS_STRUCT = `Kamu modul ekstraksi visual. Tentukan jenis visual dan ekstrak data terstruktur.
Balas HANYA JSON:
{"type":"struk|grafik|infografis|tabel|foto|label|poster|lainnya",
 "title":"judul singkat",
 "items":[{"label":"","value":"","qty":"","conf":"tinggi|sedang|rendah"}],
 "total":"",
 "notes":""}
Aturan: struk -> items = barang (value = subtotal per baris seperti tercetak), total = total bayar.
grafik/tabel -> items = titik data (label + value seperti tertulis/terbaca). foto -> items = objek/orang/situasi
(qty = jumlah, value kosong, conf = keyakinan). infografis/poster/label -> items = poin utama.
Untuk produk/label/kemasan (type "label"): items = nama produk, ukuran/isi, harga bila terlihat, klaim penting (mis. SPF, kandungan, tanggal kedaluwarsa, komposisi utama).
Jangan menebak angka yang tidak terbaca: kosongkan value dan beri conf "rendah".`;
const SYS_OCR = `Salin SEMUA teks dan angka yang terlihat di gambar persis seperti tertulis, satu baris per baris.
Jangan menyimpulkan atau menambah apa pun. Bagian tidak terbaca tulis [?]. Bila tidak ada teks, balas: (tidak ada teks)`;

app.post("/api/kenali", wrap(async ({ image }) => {
  const img = imageBlock(image);
  const [structTxt, ocr] = await Promise.all([
    llm(MAIN, SYS_STRUCT, [img, { type: "text", text: "Ekstrak visual ini." }], 2000),
    llm(OCR, SYS_OCR, [img, { type: "text", text: "Salin teks pada gambar." }], 1500).catch(() => null), // OCR gagal != fatal
  ]);
  const s = toJSON(structTxt);
  return { type: s.type || "lainnya", title: s.title || "Visual", items: s.items || [], total: s.total || "", notes: s.notes || "", ocr: ocr || "", ocrOk: !!ocr };
}));

// ---------- 2. PAHAMI: validasi (cross-check OCR vs VLM + aturan domain) ----------
app.post("/api/pahami", wrap(async ({ type, title, items = [], total = "", ocr = "", ocrOk = true }) => {
  const seen = new Set((ocr.match(/\d[\d.,]*/g) || []).map(digits));
  const noOcr = !ocrOk;   // tanpa pembanding OCR: jangan cap salah, tapi jangan klaim terverifikasi
  const issues = [];
  const rows = items.map((it) => {
    const d = digits(it.value);
    let ok = true;
    if (type === "foto") ok = it.conf !== "rendah";
    else if (d) ok = noOcr ? true : seen.has(d);                 // cross-modal: angka VLM harus ada di OCR
    else if (type === "struk" || type === "grafik" || type === "tabel") ok = false;
    if (!ok) issues.push(`"${it.label}" belum pasti`);
    return { label: it.label, value: it.value || "", qty: it.qty || "", ok };
  });
  if (type === "struk" && digits(total)) {       // rule-based: total = jumlah barang
    const sum = items.reduce((a, it) => a + Number(digits(it.value) || 0), 0);
    const tot = Number(digits(total));
    const okTot = sum === tot && (noOcr || seen.has(digits(total)));
    rows.push({ label: "TOTAL", value: total, qty: "", ok: okTot });
    if (!okTot) issues.push(`total tidak cocok dengan jumlah barang (jumlah hitung ${sum}, tercetak ${tot})`);
  }
  let status = issues.length ? "warn" : "ok";
  let label = issues.length ? `${issues.length} hal belum pasti` : "Terverifikasi";
  if (noOcr && !issues.length) { status = "warn"; label = "Belum diverifikasi silang (OCR gagal)"; }
  if (type === "foto") { status = "warn"; label = "Foto: hanya berdasarkan tingkat keyakinan"; }
  // Validasi hanya memeriksa ANGKA. Jenis visual non-numerik (infografis, poster, label berisi teks) tidak boleh dicap "Terverifikasi" penuh.
  const hasNum = items.some((it) => digits(it.value));
  if (status === "ok" && !["struk", "grafik", "tabel"].includes(type)) {
    if (hasNum) label = "Angka terverifikasi, teks belum diperiksa";
    else { status = "warn"; label = "Tidak ada angka yang dapat diverifikasi"; }
  }
  const summary = type === "foto" ? "Foto tidak bisa dipastikan sepenuhnya."
    : (status === "warn" && !issues.length) ? label + "."
    : issues.length ? `${issues.length} hal belum pasti.` : "Data cocok dengan teks yang terbaca.";
  return { type, title, rows, issues, status, label, summary };
}));

// ---------- 3. JELASKAN: narasi audio hanya dari data tervalidasi ----------
const SYS_NARR = `Kamu VISARA, asisten audio untuk penyandang tunanetra. Tulis narasi bahasa Indonesia dari DATA yang diberikan.
Aturan: kalimat pendek (mudah didengar, ~150 kata/menit); urut dari inti ke rinci; tulis angka dan mata uang dengan KATA
(mis. "dua puluh tujuh ribu lima ratus rupiah"); hanya pakai data yang ada, jangan menambah fakta;
item dengan ok=false WAJIB disebut jujur "belum pasti, mohon dicek ulang", jangan ditebak.
Untuk produk/label: sebut nama, ukuran, harga (bila ada), dan klaim utama. Untuk struk: sebut barang, jumlah, harga, total. Grafik: nilai, tren, perbandingan. Foto: objek dan situasi + tingkat keyakinan.
Balas HANYA JSON: {"segs":["3-5 kalimat/paragraf pendek"],"sh":[indeks segs untuk versi ringkas, 2-3 buah],"qs":["2 pertanyaan lanjutan pendek"]}`;

app.post("/api/jelaskan", wrap(async (data) => {
  const txt = await llm(MAIN, SYS_NARR, JSON.stringify(data), 1200);
  const j = toJSON(txt);
  return { segs: j.segs || [], sh: j.sh || [0], qs: j.qs || [] };
}));

// ---------- Tanya lanjutan (+ perbandingan dengan riwayat + pengetahuan umum/pencarian web) ----------
const SYS_ASK = `Kamu VISARA, asisten suara untuk tunanetra. Jawab bahasa Indonesia, singkat (maks 3-4 kalimat), angka dengan kata, mudah didengar.
Sumber jawaban, berurutan: (1) DATA visual saat ini; (2) RIWAYAT pindaian sebelumnya bila pertanyaan membandingkan atau menyebut "yang tadi";
(3) pengetahuan umum / pencarian web bila pertanyaan di luar data (mis. berapa lama perlindungan SPF 20, manfaat bahan, perbandingan produk).
Awali dengan sumbernya: "Dari label:", "Dari pindaian sebelumnya:" atau "Info umum:". Info umum harus jujur dinyatakan bukan dari label.
Membandingkan produk: hitung harga per satuan (per 100 ml / per gram / per buah) bila harga dan ukuran tersedia, bandingkan klaim/kandungan,
lalu beri rekomendasi singkat + alasan. Bila harga/ukuran tidak ada, sebutkan data apa yang kurang.
Hal kesehatan: beri info umum saja dan sarankan tanya apoteker/dokter bila penting. Item ok=false itu belum pasti: jangan dijadikan fakta.`;
app.post("/api/ask", wrap(async ({ ctx, others = [], question }) => {
  const content = `DATA SAAT INI: ${JSON.stringify(ctx)}\nRIWAYAT: ${JSON.stringify(others)}\nPERTANYAAN: ${question}`;
  // Google Search hanya dipakai bila pertanyaan butuh info di luar label (lebih lambat); selain itu jawab langsung dari data (cepat)
  const NEEDS = /lama|jam\b|manfaat|efek|aman|bahaya|cocok|bagus|mending|bandingkan|lebih baik|lebih murah|rekomen|alternatif|ulasan|review|apa itu|artinya|kenapa|mengapa|boleh|sebaiknya|dibanding/i;
  let a = "";
  if (NEEDS.test(question)) { try { a = await llm(MAIN, SYS_ASK, content, 800, { search: true, timeout: 12000 }); } catch (e) { /* lanjut tanpa pencarian */ } }
  if (!a) a = await llm(MAIN, SYS_ASK, content, 800);
  return { answer: a };
}));

const port = process.env.PORT || 3000;
app.listen(port, "0.0.0.0", () => console.log(`VISARA jalan di http://localhost:${port}`));