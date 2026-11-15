// Logo tim bawaan (assets/logos/*.webp). Sudah dipangkas rapat, diratakan ke tengah, dan ukurannya diseragamkan.
// Urutan prioritas logo sebuah tim:
// (1) logoId "none" = tanpa logo (lingkaran singkatan); (2) logoId "upload" = logo yang diunggah sendiri di admin;
// (3) logoId = logo bawaan yang dipilih di admin; (4) logo bawaan yang cocok otomatis dengan nama tim;
// (5) logo unggahan lama (tanpa logoId) hanya dipakai bila tidak ada logo bawaan yang cocok, supaya logo lama yang kecil/tidak terpangkas tidak menimpa logo bawaan.
// "keys" dicocokkan dengan kata utuh di nama tim (tanpa memperhatikan huruf besar/kecil), mis. "PT.RKI" -> kata "rki".
export const LOGOS = [
  {
    "id": "profinder",
    "name": "Profinder FC",
    "wide": true,
    "ratio": 3,
    "keys": [
      "profinder"
    ]
  },
  {
    "id": "rki",
    "name": "PT.RKI (Rumah Keramik Indonesia)",
    "wide": true,
    "ratio": 2.94,
    "keys": [
      "rki"
    ]
  },
  {
    "id": "trax",
    "name": "Trax FC",
    "wide": false,
    "ratio": 1,
    "keys": [
      "trax"
    ]
  },
  {
    "id": "prowell",
    "name": "Prowell FC (Hornet IPL)",
    "wide": false,
    "ratio": 1,
    "keys": [
      "prowell"
    ]
  },
  {
    "id": "wavin",
    "name": "Wavin FC",
    "wide": false,
    "ratio": 1,
    "keys": [
      "wavin"
    ]
  },
  {
    "id": "nesinak",
    "name": "Nesinak FC",
    "wide": false,
    "ratio": 1,
    "keys": [
      "nesinak"
    ]
  },
  {
    "id": "yihquan",
    "name": "PT Yih Quan Footwear (Lai Yih)",
    "wide": false,
    "ratio": 1,
    "keys": [
      "yih",
      "yihquan"
    ]
  },
  {
    "id": "melongteng",
    "name": "ME Longteng",
    "wide": true,
    "ratio": 3,
    "keys": [
      "longteng"
    ]
  },
  {
    "id": "jjd",
    "name": "JJD United",
    "wide": false,
    "ratio": 1,
    "keys": [
      "jjd"
    ]
  },
  {
    "id": "allmed",
    "name": "Allmed FC",
    "wide": false,
    "ratio": 1,
    "keys": [
      "allmed"
    ]
  },
  {
    "id": "kcc",
    "name": "KCC Glass",
    "wide": false,
    "ratio": 1,
    "keys": [
      "kcc"
    ]
  },
  {
    "id": "xingxun",
    "name": "XINGXUN Rangers",
    "wide": false,
    "ratio": 1,
    "keys": [
      "xingxun"
    ]
  },
  {
    "id": "industropolis",
    "name": "Industropolis Batang FC",
    "wide": true,
    "ratio": 3,
    "keys": [
      "industropolis"
    ]
  },
  {
    "id": "sampoerna",
    "name": "Sampoerna Kayoe United",
    "wide": false,
    "ratio": 1,
    "keys": [
      "sampoerna"
    ]
  },
  {
    "id": "ims",
    "name": "IMS Team",
    "wide": true,
    "ratio": 2.53,
    "keys": [
      "ims"
    ]
  },
  {
    "id": "unipack",
    "name": "PT Unipack Plasindo Batang",
    "wide": false,
    "ratio": 1,
    "keys": [
      "unipack"
    ]
  }
];

const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Alamat gambar logo bawaan, dihitung dari lokasi file ini sehingga sama benarnya di website publik maupun /admin/.
export const bundledUrl = (id) => new URL(`../assets/logos/${id}.webp`, import.meta.url).href;

function pack(l) {
  return { id: l.id, url: bundledUrl(l.id), wide: l.wide, ratio: l.ratio };
}

// Mengembalikan { id, url, wide, ratio } atau null bila tim tidak punya logo sama sekali.
export function logoOf(team) {
  if (!team) return null;
  const up = team.logoUrl && !String(team.logoUrl).startsWith("/assets/logos/")
    ? { id: "upload", url: team.logoUrl, wide: !!team.logoWide, ratio: Number(team.logoRatio) || 2 } : null;
  if (team.logoId === "none") return null;
  if (team.logoId === "upload") return up;
  if (team.logoId) {
    const l = LOGOS.find((x) => x.id === team.logoId);
    if (l) return pack(l);
  }
  const w = words(team.name);
  const m = LOGOS.find((x) => x.keys.some((k) => w.includes(k)));
  return m ? pack(m) : up;
}
