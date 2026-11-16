// Logo tim: hanya logo yang diunggah sendiri lewat admin (tidak ada lagi logo bawaan).
// Urutan: (1) logoId "none" = tanpa logo (lingkaran singkatan); (2) logo unggahan (logoUrl); (3) tanpa logo.
// Mengembalikan { id, url, wide, ratio } atau null. "wide" = logo lurus/memanjang, "ratio" = lebar : tinggi.

export function logoOf(team) {
  if (!team || team.logoId === "none") return null;
  const u = team.logoUrl;
  if (!u || String(u).startsWith("/assets/logos/")) return null; // sisa logo bawaan lama diabaikan
  return { id: "upload", url: u, wide: !!team.logoWide, ratio: Number(team.logoRatio) || 2 };
}
