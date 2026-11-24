// Membuat halaman statis per rute (public/jadwal/index.html, dst.) dari public/index.html,
// supaya Google dan pratinjau link (WhatsApp, Telegram, dll.) langsung membaca judul,
// deskripsi, dan logo yang tepat tanpa menunggu JavaScript. Juga membuat sitemap.xml.
// Jalankan setiap kali teks di bawah diubah:  node scripts/gen-seo.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SITE = "https://ibfl.eventkami.web.id";
const NAME = "Industropolis Batang Futsal League";
const PAGES = {
  jadwal: ["Jadwal Pertandingan IBFL 2026", "Jadwal lengkap pertandingan Industropolis Batang Futsal League (IBFL) 2026: waktu kick-off, babak grup, dan babak gugur di Sagara Futsal Arena, KEK Industropolis Batang."],
  klasemen: ["Klasemen IBFL 2026", "Klasemen grup Industropolis Batang Futsal League (IBFL) 2026: poin, selisih gol, dan tim yang lolos ke perempat final."],
  bagan: ["Bagan Babak Gugur IBFL 2026", "Bagan perempat final, semifinal, dan final Industropolis Batang Futsal League (IBFL) 2026."],
  statistik: ["Statistik Pemain IBFL 2026", "Top scorer, top assist, kartu, dan statistik pemain Industropolis Batang Futsal League (IBFL) 2026."],
  tim: ["Daftar Tim dan Pemain IBFL 2026", "16 tim peserta Industropolis Batang Futsal League (IBFL) 2026 beserta daftar pemain dan official."],
};

const esc = (t) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const base = readFileSync("public/index.html", "utf8");
const sub = (html, re, to) => { if (!re.test(html)) throw new Error("pola tidak ditemukan: " + re); return html.replace(re, () => to); };

for (const [slug, [h1, desc]] of Object.entries(PAGES)) {
  const title = `${h1} | ${NAME}`, url = `${SITE}/${slug}`;
  let h = base;
  h = sub(h, /<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  h = sub(h, /(<meta name="description" content=")[^"]*"/, `$1${esc(desc)}"`.replace("$1", '<meta name="description" content="'));
  h = sub(h, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`);
  h = sub(h, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`);
  h = sub(h, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title)}">`);
  h = sub(h, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`);
  h = sub(h, /<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(title)}">`);
  h = sub(h, /<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(desc)}">`);
  h = sub(h, /<noscript>[\s\S]*?<\/noscript>/, `<noscript><div style="padding:20px;max-width:720px;margin:0 auto;line-height:1.6"><h1>${esc(h1)}</h1><p>${esc(desc)}</p><p><a href="/">Beranda ${esc(NAME)}</a> · Aktifkan JavaScript untuk melihat data langsung.</p></div></noscript>`);
  mkdirSync(`public/${slug}`, { recursive: true });
  writeFileSync(`public/${slug}/index.html`, h);
}

const today = new Date().toISOString().slice(0, 10);
const urls = ["", ...Object.keys(PAGES)].map((s) => `  <url>\n    <loc>${SITE}/${s}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join("\n");
writeFileSync("public/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
console.log("OK:", Object.keys(PAGES).join(", "));
