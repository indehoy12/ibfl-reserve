// Tab "Check-in tim" di Admin IFL: registrasi tim hari-H (hadir, nomor punggung, kiper, skorsing, catatan, laporan Excel).
// Data hasil check-in disimpan di koleksi `checkins` (satu dokumen per tim, id = id tim).
import { db, collection, doc, onSnapshot, addDoc, setDoc, updateDoc } from "./firebase.js";
import { state } from "./store.js";
import { sortByKickoff, suspendedIn, suspReason } from "./util.js";
import { buildXlsx } from "./exporter.js";

const MAX = 20, OFF = 2;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const hm = (ms) => (ms ? new Date(ms).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }).replace(":", ".") : "");
const ST = { no: ["Belum datang", "ck-no"], cek: ["Sedang dicek", "ck-cek"], ok: ["Terverifikasi", "ck-ok"] };
const pill = (k) => `<span class="ck-pill ${ST[k][1]}">${ST[k][0]}</span>`;
let H = { toast: () => {}, render: () => {} }, checks = {}, unsub = null, filter = "all", q = "";

export function init(h) { H = h; }
export function start() { if (unsub) return; unsub = onSnapshot(collection(db, "checkins"), (s) => { checks = Object.fromEntries(s.docs.map((d) => [d.id, d.data()])); H.render(); }, (e) => H.toast("Check-in tidak bisa dibaca: " + (e.code || e.message), true)); }
export function stop() { unsub?.(); unsub = null; checks = {}; }
/** Jangan render ulang saat panitia sedang mengetik di kolom cari/nomor/teks. */
export function typing() { const a = document.activeElement; return !!a && a.matches?.('[data-ck] input[type="search"], [data-ck] input[type="text"], [data-ck] input[type="number"]'); }

// ---------- data turunan ----------
const teams = () => [...state.teams].sort((a, b) => String(a.group || "~").localeCompare(String(b.group || "~")) || (a.ord ?? 0) - (b.ord ?? 0) || String(a.name).localeCompare(String(b.name)));
const ppl = (t) => state.players.filter((p) => p.teamId === t.id && p.role !== "official").sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
const offs = (t) => state.players.filter((p) => p.teamId === t.id && p.role === "official");
const ck = (t) => checks[t.id] || {};
const status = (t) => ck(t).status || "no";
const here = (t) => ppl(t).filter((p) => ck(t).present?.[p.id]);
const hasGK = (t) => here(t).some((p) => p.isGK);
function suspMap(t) {
  const m = state.matches.filter((x) => x.status === "scheduled" && (x.teamA === t.id || x.teamB === t.id)).sort(sortByKickoff)[0];
  return m ? suspendedIn(m, t.id, state.matches, state.events, state.players) : new Map();
}
function totals() {
  const T = teams(), ok = T.filter((t) => status(t) === "ok");
  return { n: T.length, hadir: T.filter((t) => status(t) !== "no").length, ok: ok.length, pemain: ok.reduce((s, t) => s + here(t).length, 0) };
}

// ---------- tampilan ----------
function listRows() {
  const k = q.trim().toLowerCase();
  const hit = (t) => (k ? ppl(t).filter((p) => String(p.name).toLowerCase().includes(k) || String(p.number ?? "") === k) : []);
  const T = teams().filter((t) => (filter === "all" || status(t) === filter) && (!k || String(t.name).toLowerCase().includes(k) || hit(t).length));
  return T.map((t) => {
    const hp = hit(t);
    const s = status(t), n = ppl(t).length;
    return `<a class="ck-tm" href="#checkin-tim/${esc(t.id)}"><div class="ck-code">${esc(t.group || "–")}</div><div class="ck-grow"><b>${esc(t.name)}</b>${s !== "no" && !hasGK(t) ? '<span class="ck-tag ck-bad">Belum ada kiper</span>' : ""}${ck(t).note ? '<span class="ck-tag ck-note">Catatan</span>' : ""}<div class="ck-muted">Grup ${esc(t.group || "–")} · hadir ${here(t).length}/${n}${ck(t).checkedAt ? " · " + hm(ck(t).checkedAt) : ""}</div>${hp.length ? `<div class="ck-muted">Pemain: ${hp.slice(0, 3).map((p) => esc((p.number != null ? p.number + " " : "") + p.name)).join(", ")}${hp.length > 3 ? " …" : ""}</div>` : ""}</div>${pill(s)}</a>`;
  }).join("") || '<p class="ck-muted">Tidak ada tim.</p>';
}
export function listView() {
  const t = totals(), pct = t.n ? Math.round((t.hadir / t.n) * 100) : 0, T = teams(), c = (k) => T.filter((x) => status(x) === k).length;
  const chips = [["all", "Semua", T.length], ["no", "Belum", c("no")], ["cek", "Dicek", c("cek")], ["ok", "Selesai", c("ok")]].map(([k, l, n]) => `<button class="ck-chip ${filter === k ? "on" : ""}" data-f="${k}">${l} ${n}</button>`).join("");
  return `<div data-ck="list"><h2 class="ck-h">Registrasi tim</h2>
  <div class="ck-card ck-sum"><div class="ck-row"><div class="ck-big ck-grow">${t.ok}<span> / ${t.n} tim</span></div><a class="ck-btn sm" style="display:flex;align-items:center" href="#checkin-report">Laporan</a></div><div class="ck-muted">Terverifikasi · ${t.hadir} tim sudah hadir · ${t.pemain} pemain terverifikasi</div><div class="ck-bar"><i style="width:${pct}%"></i></div></div>
  <div class="ck-chips">${chips}</div><input class="ck-srch" id="ck-q" type="search" placeholder="Cari tim, nama pemain, atau nomor" value="${esc(q)}" autocomplete="off"><div class="ck-list" id="ck-rows">${listRows()}</div></div>`;
}
export function teamView(id) {
  const t = state.teamById[id];
  if (!t) return `<a class="ck-back" href="#checkin">← Daftar check-in</a><div class="ck-card">Tim tidak ditemukan.</div>`;
  const P = ppl(t), O = offs(t), c = ck(t), sm = suspMap(t), pr = c.present || {}, op = c.offPresent || {}, nums = {};
  P.forEach((p) => p.number != null && (nums[p.number] = (nums[p.number] || 0) + 1));
  const rows = P.map((p) => {
    const on = !!pr[p.id], sp = sm.get(p.id), dup = p.number != null && nums[p.number] > 1;
    return `<div class="ck-pl ${on ? "on" : ""}"><input type="checkbox" data-p="${p.id}" ${on ? "checked" : ""} aria-label="Hadir: ${esc(p.name)}"><input class="ck-no-in" type="number" min="0" max="99" data-n="${p.id}" value="${p.number ?? ""}" placeholder="No" aria-label="Nomor punggung"><div class="ck-grow"><b>${esc(p.name)}</b>${p.isGK ? '<span class="ck-tag ck-gk">Kiper</span>' : ""}${sp ? '<span class="ck-tag ck-bad">Skorsing</span>' : ""}${dup ? '<span class="ck-tag ck-bad">No ganda</span>' : ""}${c.pnotes?.[p.id] ? `<div class="ck-muted">${esc(c.pnotes[p.id])}</div>` : ""}${sp ? `<div class="ck-muted">${esc(suspReason(sp))}</div>` : ""}</div><button class="ck-btn sm" data-note="${p.id}">Catatan</button></div>`;
  }).join("");
  const orows = O.map((o) => `<div class="ck-pl ${op[o.id] ? "on" : ""}"><input type="checkbox" data-o="${o.id}" ${op[o.id] ? "checked" : ""} aria-label="Hadir: ${esc(o.name)}"><div class="ck-grow"><b>${esc(o.name)}</b><span class="ck-tag ck-note">Official</span>${c.pnotes?.[o.id] ? `<div class="ck-muted">${esc(c.pnotes[o.id])}</div>` : ""}</div><button class="ck-btn sm" data-oname="${o.id}">Ganti</button></div>`).join("") + (O.length < OFF ? `<div><button class="ck-btn sm" id="ck-ao">Tambah official (${O.length}/${OFF})</button></div>` : "");
  const s = status(t), warn = s !== "no" && !hasGK(t) ? '<div class="ck-warn">Belum ada kiper yang hadir. Susunan inti tidak bisa lengkap tanpa kiper.</div>' : "";
  return `<div data-ck="team" data-tid="${esc(id)}"><a class="ck-back" href="#checkin">← Daftar check-in</a>
  <h2 class="ck-h" style="margin-top:0">${esc(t.name)} <small style="font-size:15px">Grup ${esc(t.group || "–")}</small> ${pill(s)}</h2>
  <div class="ck-row"><div class="ck-card ck-grow"><div class="ck-muted">Pemain hadir</div><div class="ck-big">${here(t).length}<span> / ${P.length}</span></div></div><div class="ck-card ck-grow"><div class="ck-muted">Official hadir</div><div class="ck-big">${O.filter((o) => op[o.id]).length}<span> / ${O.length}</span></div></div></div>${warn}
  <div class="ck-acts"><button class="ck-btn" id="ck-all">Centang semua</button><button class="ck-btn pri" id="ck-ver" style="flex:1.4">${s === "ok" ? "Terverifikasi ✓" : "Tim terverifikasi"}</button></div>
  <p class="ck-muted">Centang pemain yang hadir dan lolos cek.</p>
  <div class="ck-list">${rows}${orows}<div><button class="ck-btn sm" id="ck-tn">Catatan tim${c.note ? ": " + esc(c.note) : ""}</button></div></div>
  ${P.length < MAX ? `<form class="ck-form" id="ck-af"><b>Tambah pemain di tempat (${P.length}/${MAX})</b><div class="ck-row"><input type="text" name="n" placeholder="Nama pemain" required maxlength="60"><input type="number" name="no" min="0" max="99" placeholder="No" style="max-width:90px"></div><label class="ck-row"><input type="checkbox" name="gk"> Kiper</label><button class="ck-btn">Tambah pemain</button></form>` : `<p class="ck-muted">Pemain sudah ${MAX}, batas tercapai.</p>`}</div>`;
}
function reportData() {
  const rekap = [["Tim", "Grup", "Status", "Pemain hadir", "Pemain terdaftar", "Official hadir", "Kiper hadir", "Jam check-in", "Jam verifikasi", "Catatan"]], absen = [["Tim", "Grup", "Jenis", "No", "Nama", "Catatan"]], ver = [["Tim", "Grup", "Status tim", "No", "Nama", "Kiper", "Catatan"]];
  teams().forEach((t) => {
    const s = status(t), c = ck(t), P = ppl(t), Hh = here(t), O = offs(t), g = t.group || "";
    rekap.push([t.name, g, ST[s][0], Hh.length, P.length, O.filter((o) => c.offPresent?.[o.id]).length, s === "no" ? "" : hasGK(t) ? "Ya" : "Belum ada", hm(c.checkedAt), hm(c.verifiedAt), c.note || ""]);
    if (s === "no") absen.push([t.name, g, "Tim belum datang", "", "", c.note || ""]);
    else {
      P.filter((p) => !c.present?.[p.id]).forEach((p) => absen.push([t.name, g, "Pemain tidak hadir", p.number ?? "", p.name, c.pnotes?.[p.id] || ""]));
      O.filter((o) => !c.offPresent?.[o.id]).forEach((o) => absen.push([t.name, g, "Official tidak hadir", "", o.name, ""]));
    }
    Hh.forEach((p) => ver.push([t.name, g, ST[s][0], p.number ?? "", p.name, p.isGK ? "Kiper" : "", c.pnotes?.[p.id] || ""]));
  });
  return { rekap, absen, ver };
}
const tbl = (r) => `<div class="ck-tw"><table><tr>${r[0].map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${r.slice(1).map((x) => `<tr>${x.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${r[0].length}">Tidak ada data.</td></tr>`}</table></div>`;
export function reportView() {
  const t = totals(), d = reportData();
  return `<div data-ck="report"><a class="ck-back ck-noprint" href="#checkin">← Daftar check-in</a><h2 class="ck-h" style="margin-top:0">Laporan registrasi</h2>
  <div class="ck-card ck-sum"><div class="ck-big">${t.hadir}<span> dari ${t.n} tim hadir</span></div><div class="ck-muted">${t.ok} tim terverifikasi · ${t.pemain} pemain terverifikasi</div></div>
  <div class="ck-acts ck-noprint"><button class="ck-btn pri" id="ck-xl">Unduh Excel</button><button class="ck-btn" id="ck-pr">Cetak / PDF</button></div>
  <h2 class="ck-h">Rekap semua tim</h2>${tbl(d.rekap)}<h2 class="ck-h">Daftar tidak hadir</h2>${tbl(d.absen)}<h2 class="ck-h">Terverifikasi per tim</h2>${tbl(d.ver)}</div>`;
}

// ---------- aksi ----------
export function bind(root) {
  const $ = (s) => root.querySelector(s), $$ = (s) => root.querySelectorAll(s), kind = root.querySelector("[data-ck]")?.dataset.ck;
  if (kind === "list") {
    $$("[data-f]").forEach((b) => (b.onclick = () => { filter = b.dataset.f; H.render(); }));
    $("#ck-q").oninput = (e) => { q = e.target.value; $("#ck-rows").innerHTML = listRows(); };
  } else if (kind === "report") {
    $("#ck-pr").onclick = () => print();
    $("#ck-xl").onclick = () => { const d = reportData(), b = buildXlsx([{ name: "Rekap tim", rows: d.rekap }, { name: "Tidak hadir", rows: d.absen }, { name: "Terverifikasi", rows: d.ver }]), a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `registrasi-ifl-2026-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  } else if (kind === "team") {
    const id = $("[data-tid]")?.dataset.tid || root.querySelector("[data-tid]").dataset.tid, t = state.teamById[id];
    if (!t) return;
    const P = ppl(t), O = offs(t), c = ck(t), sm = suspMap(t);
    const save = (data) => { const d = { ...data }; if (!c.checkedAt) d.checkedAt = Date.now(); if (!c.status) d.status = "cek"; return setDoc(doc(db, "checkins", id), d, { merge: true }).catch((e) => H.toast("Gagal menyimpan: " + (e.code || e.message), true)); };
    $$("[data-p]").forEach((el) => (el.onchange = () => { const p = state.playerById[el.dataset.p], sp = sm.get(p.id); if (el.checked && sp && !confirm(`${p.name} kena skorsing (${suspReason(sp)}). Tetap diloloskan?`)) { el.checked = false; return; } save({ present: { [p.id]: el.checked } }); }));
    $$("[data-o]").forEach((el) => (el.onchange = () => save({ offPresent: { [el.dataset.o]: el.checked } })));
    $$("[data-oname]").forEach((el) => (el.onclick = async () => {
      const o = state.playerById[el.dataset.oname], v = prompt("Nama official pengganti:", o.name); if (v === null) return;
      const nm = v.trim(); if (!nm || nm === o.name) return;
      try { await updateDoc(doc(db, "players", o.id), { name: nm }); await save({ pnotes: { [o.id]: `Diganti di tempat (sebelumnya: ${o.name})` } }); H.toast("Official diganti"); } catch (e) { H.toast("Gagal: " + (e.code || e.message), true); }
    }));
    const ao = $("#ck-ao");
    if (ao) ao.onclick = async () => {
      if (offs(t).length >= OFF) return H.toast(`Maksimal ${OFF} official`, true);
      const v = prompt("Nama official baru:"); const nm = (v || "").trim(); if (!nm) return;
      try { const r = await addDoc(collection(db, "players"), { teamId: id, name: nm, number: null, isGK: false, isCaptain: false, role: "official" }); await save({ offPresent: { [r.id]: true }, pnotes: { [r.id]: "Ditambahkan di tempat" } }); H.toast("Official ditambahkan"); } catch (e) { H.toast("Gagal: " + (e.code || e.message), true); }
    };
    $$("[data-n]").forEach((el) => (el.onchange = () => { const v = el.value === "" ? null : Number(el.value); if (v !== null && (!Number.isInteger(v) || v < 0 || v > 99)) return H.toast("Nomor punggung harus 0–99", true); if (v !== null && P.some((p) => p.id !== el.dataset.n && p.number === v)) H.toast(`Nomor ${v} sudah dipakai pemain lain`, true); updateDoc(doc(db, "players", el.dataset.n), { number: v }).catch((e) => H.toast("Gagal: " + (e.code || e.message), true)); }));
    $$("[data-note]").forEach((el) => (el.onclick = () => { const v = prompt("Catatan pemain (mis. terlambat, nama belum sesuai):", c.pnotes?.[el.dataset.note] || ""); if (v !== null) save({ pnotes: { [el.dataset.note]: v.trim() } }); }));
    $("#ck-tn").onclick = () => { const v = prompt("Catatan tim:", c.note || ""); if (v !== null) save({ note: v.trim() }); };
    $("#ck-all").onclick = () => save({ present: Object.fromEntries(P.filter((p) => !sm.has(p.id)).map((p) => [p.id, true])), offPresent: Object.fromEntries(O.map((o) => [o.id, true])) });
    $("#ck-ver").onclick = async () => { if (!here(t).length) return H.toast("Belum ada pemain yang dicentang", true); if (!hasGK(t) && !confirm("Belum ada kiper yang hadir. Tetap verifikasi?")) return; await save({ status: "ok", verifiedAt: Date.now() }); H.toast("Tim terverifikasi"); location.hash = "#checkin"; };
    const af = $("#ck-af");
    if (af) af.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(af), no = f.get("no") === "" ? null : Number(f.get("no")), nm = String(f.get("n")).trim();
      if (!nm) return;
      if (no !== null && (!Number.isInteger(no) || no < 0 || no > 99)) return H.toast("Nomor punggung harus 0–99", true);
      if (no !== null && P.some((p) => p.number === no)) return H.toast(`Nomor ${no} sudah dipakai`, true);
      if (ppl(t).length >= MAX) return H.toast(`Maksimal ${MAX} pemain`, true);
      try { const r = await addDoc(collection(db, "players"), { teamId: id, name: nm, number: no, isGK: !!f.get("gk"), role: "player" }); await save({ present: { [r.id]: true }, pnotes: { [r.id]: "Ditambahkan di tempat" } }); H.toast("Pemain ditambahkan"); } catch (e) { H.toast("Gagal: " + (e.code || e.message), true); }
    };
  }
}
