// Panel admin Industropolis Batang Futsal League. Hanya akun yang terdaftar di firestore.rules yang bisa menulis data.
import {
  db, auth, collection, doc, setDoc, updateDoc, deleteDoc, writeBatch, increment, deleteField,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, Timestamp,
} from "./firebase.js";
import { state, startStore, onChange, isReady } from "./store.js";
import { parseFile, buildPlan, buildOps, LIMITS } from "./importer.js";
import { teamSummary, playerProfile, headToHead, championInfo } from "./profile.js";
import { buildXlsx, zipBlob, toCsv } from "./exporter.js";
import { logoOf } from "./logos.js";
import { byEntry } from "./util.js";
import {
  STAGES, esc, timeStr, dayShort, sortByKickoff, toLocalInput, fromLocalInput, elapsedSec, clockText,
  planKnockout, autoFillPlan, knockoutEligible, knockoutTeamProblems, computeBracket, unresolvedTies, finalScore, scoreFromEvents, matchReadiness, lineupIds, FUTSAL_STARTERS, LINEUP_MAX, nowMs, syncServerTime, ballSvg,
  phaseOf, isPlayPhase, stampAt, stampNow, eventMinute, minuteNow, eventCmp, livePill, ftText, isReadyToStart, phaseActions,
  timingOf, cfgFor, isKnockout, PHASE_NAME, PAUSE_REASONS, periodLimitSec, computeKeeperStats, keeperDetail, teamProgress, skeleton,
  shootout, penDots, PEN_ROUNDS, rtClockHtml, tickRtClocks, computeStandings, computePlayerStats, topBy,
  computeSuspensions, suspendedIn, warnedIn, suspReason, onCourtIds, gkNow, eventSide, cardTotals,
} from "./util.js";

const $app = document.getElementById("app");
const $bar = document.getElementById("bar");
const $toast = document.getElementById("toast");

let user; // undefined = belum tahu, null = belum login

// ---------- Util kecil ----------
let toastTimer;
function toast(msg, err = false) {
  $toast.textContent = msg;
  $toast.className = "toast" + (err ? " err" : "");
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), err ? 6000 : 2200);
}
function errMsg(e) {
  if (e?.code === "permission-denied") return "Ditolak: akun ini belum diizinkan menulis. Pastikan UID akun ada di tabel admins Supabase (lihat README).";
  if (e?.code === "auth/invalid-credential" || e?.code === "auth/wrong-password" || e?.code === "auth/user-not-found") return "Email atau password salah.";
  if (e?.code === "auth/too-many-requests") return "Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.";
  if (e?.code === "auth/network-request-failed") return "Tidak ada koneksi internet.";
  if (e?.code === "unavailable") return "Database tidak bisa dihubungi. Cek koneksi internet lalu coba lagi.";
  return e?.message || "Terjadi kesalahan.";
}
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); } catch (e) { console.error(e); toast(errMsg(e), true); }
}
const byNumber = (a, b) => (a.number ?? 999) - (b.number ?? 999) || (a.name || "").localeCompare(b.name || "", "id");
const isOfficial = (p) => p.role === "official";
const playersOf = (teamId) => state.players.filter((p) => p.teamId === teamId && !isOfficial(p)).sort(byNumber);
const officialsOf = (teamId) => state.players.filter((p) => p.teamId === teamId && isOfficial(p)).sort((a, b) => (a.name || "").localeCompare(b.name || "", "id"));
// state tampilan sementara (lembar kejadian, draft line up, tab tim di HP)
const ui = { sheet: null, draft: null, addEv: null, side: "A", tabs: {} };
let importState = null; // { fileName, rows, replace }
const tName = (id) => state.teamById[id]?.name ?? "Belum ditentukan";
// Laga babak gugur yang timnya belum pasti tampil sebagai "Juara A", "Pemenang QF1", dst.
let slotByMatch = new Map();
function sideName(m, side) {
  const id = side === "A" ? m.teamA : m.teamB;
  if (state.teamById[id]) return state.teamById[id].name;
  const slot = slotByMatch.get(m.id);
  if (!slot) return "Belum ditentukan";
  const rid = side === "A" ? slot.teamA : slot.teamB;
  return state.teamById[rid]?.name ?? (side === "A" ? slot.labelA : slot.labelB);
}
const pName = (id) => state.playerById[id]?.name ?? "–";
// Lencana tim: logo bila ada, kalau tidak lingkaran berwarna berisi singkatan (sama seperti website publik)
const COLORS = ["#1f4fa8", "#c4570a", "#0f766e", "#6d3fb5", "#b4233f", "#2f7d3a", "#1b78a8", "#a1700a"];
function colorFor(team) {
  if (team?.color) return team.color;
  let h = 0;
  for (const c of team?.id || "x") h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function initials(team) {
  if (team?.short) return team.short.slice(0, 3).toUpperCase();
  const w = (team?.name || "?").trim().split(/\s+/);
  if (w.length > 1 && /^tim$/i.test(w[0])) return w.slice(1).join("").slice(0, 3).toUpperCase();
  return w.length > 1 ? (w[0][0] + w[1][0]).toUpperCase() : w[0].slice(0, 3).toUpperCase();
}
function badge(team, size = "") {
  const base = size ? `tbadge ${size}` : "tbadge";
  const lg = logoOf(team);
  if (lg) return `<span class="${base}${lg.wide ? " wide" : ""}"${lg.wide ? ` style="--r:${lg.ratio}"` : ""}><img src="${esc(lg.url)}" alt="" loading="lazy"></span>`;
  return `<span class="${base}" style="background:${esc(colorFor(team))}">${esc(initials(team))}</span>`;
}
const matchRef = (id) => doc(db, "matches", id);

function teamOptions(sel, blank = "— belum ditentukan —", stage = null) {
  const ts = [...state.teams].sort((a, b) => (a.group || "").localeCompare(b.group || "") || byEntry(a, b));
  const opt = (t) => `<option value="${esc(t.id)}" ${t.id === sel ? "selected" : ""}>${esc(t.group ? `[${t.group}] ` : "")}${esc(t.name)}</option>`;
  const head = `<option value="">${blank}</option>`;
  // Fase gugur: tim yang berhak dipisah dari yang tidak berhak (yang tidak berhak hanya untuk kasus darurat, simpan perlu konfirmasi)
  if (stage === "qf" || stage === "sf" || stage === "final") {
    const ok = knockoutEligible(stage, state.teams, state.matches, state.events).ids;
    const yes = ts.filter((t) => ok.has(t.id)), no = ts.filter((t) => !ok.has(t.id));
    return head
      + (yes.length ? `<optgroup label="Berhak tampil di ${esc(STAGES[stage])}">${yes.map(opt).join("")}</optgroup>` : "")
      + (no.length ? `<optgroup label="Tidak berhak (darurat, perlu konfirmasi)">${no.map(opt).join("")}</optgroup>` : "");
  }
  return head + ts.map(opt).join("");
}
const stageOptions = (sel) => Object.entries(STAGES).map(([k, v]) => `<option value="${k}" ${k === (sel || "group") ? "selected" : ""}>${v}</option>`).join("");

function statusPill(m) {
  if (m.status === "live") { const l = livePill(m); return `<span class="pill live ${l.halted ? "pause" : ""}" data-clock="${esc(m.id)}">${esc(l.text)}</span>`; }
  if (m.status === "ft") return `<span class="pill ft">${ftText(m)}</span>`;
  return `<span class="pill soon">Terjadwal</span>`;
}

// ---------- Modal (pengganti alert / confirm / prompt bawaan browser) ----------
const nl2br = (t) => esc(t).replace(/\n/g, "<br>");
/**
 * Buka dialog. Mengembalikan Promise: nilai form (objek) / true bila OK, null bila dibatalkan.
 * opts: { title, message, fields (HTML), ok, cancel, danger, read(root) -> nilai, validate(nilai) -> pesan galat }
 */
function openModal(opts) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const root = document.createElement("div");
    root.className = "modal-bg";
    root.innerHTML = `<div class="modal" role="${opts.fields ? "dialog" : "alertdialog"}" aria-modal="true" aria-labelledby="m-title" ${opts.message ? 'aria-describedby="m-msg"' : ""}>
      <h2 id="m-title">${esc(opts.title || "Konfirmasi")}</h2>
      ${opts.message ? `<p class="modal-msg" id="m-msg">${nl2br(opts.message)}</p>` : ""}
      ${opts.fields ? `<form class="modal-form" novalidate>${opts.fields}</form>` : ""}
      <p class="modal-err" role="alert" hidden></p>
      <div class="modal-actions">
        ${opts.cancel === false ? "" : `<button type="button" class="btn ghost" data-m="cancel">${esc(opts.cancel || "Batal")}</button>`}
        <button type="button" class="btn ${opts.danger ? "danger-solid" : "orange"}" data-m="ok">${esc(opts.ok || "Oke")}</button>
      </div></div>`;
    document.body.appendChild(root);
    document.body.classList.add("modal-open");
    const box = root.querySelector(".modal"), err = root.querySelector(".modal-err");
    const close = (val) => {
      document.removeEventListener("keydown", onKey, true);
      root.remove();
      if (!document.querySelector(".modal-bg")) document.body.classList.remove("modal-open");
      if (prev && prev.isConnected) prev.focus();
      resolve(val);
    };
    const submit = () => {
      const val = opts.read ? opts.read(root) : true;
      const msg = opts.validate ? opts.validate(val) : "";
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      close(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); return; }
      if (e.key === "Enter" && e.target.matches?.("input:not([type=checkbox]), select") && opts.fields) { e.preventDefault(); submit(); return; }
      if (e.key === "Tab") {
        const f = [...box.querySelectorAll("input, select, textarea, button")].filter((el) => !el.disabled && el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey, true);
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-m]");
      if (b) { b.dataset.m === "ok" ? submit() : close(null); return; }
      if (e.target === root) close(null);
    });
    const first = opts.fields ? box.querySelector("input:not([type=checkbox]), select") : null;
    (first || box.querySelector(opts.danger ? '[data-m="cancel"]' : '[data-m="ok"]') || box.querySelector("button"))?.focus();
    if (first?.select) first.select();
  });
}
/** Pengganti confirm(): resolve true bila OK, false bila batal. */
async function confirmBox(message, { title = "Konfirmasi", ok = "Ya, lanjutkan", cancel = "Batal", danger = false } = {}) {
  return !!(await openModal({ title, message, ok, cancel, danger }));
}
/** Konfirmasi berat: pengguna harus mengetik kata tertentu (mis. HAPUS). Resolve true / false. */
async function typeConfirm(message, word, { title, ok }) {
  return !!(await openModal({
    title, message, ok, danger: true,
    fields: `<label for="mc-w">Ketik <b>${esc(word)}</b> untuk melanjutkan</label><input id="mc-w" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="${esc(word)}">`,
    read: (r) => r.querySelector("#mc-w").value.trim().toUpperCase(),
    validate: (v) => (v === word ? "" : `Ketik ${word} dulu untuk melanjutkan.`),
  }));
}
/** Hapus banyak dokumen sekaligus (dipecah per 400 karena batas Firestore). */
async function deleteMany(refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const b = writeBatch(db);
    refs.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
}
/** Pengganti prompt() ubah pemain: nomor, nama, kiper. Resolve objek atau null. */
function playerBox(p, others) {
  return openModal({
    title: "Ubah pemain", ok: "Simpan",
    fields: `<div class="grid3" style="align-items:end"><div><label for="mp-no">No.</label><input id="mp-no" type="number" name="number" min="0" max="99" value="${p.number ?? ""}"></div>
      <div style="grid-column:span 2"><label for="mp-nm">Nama pemain</label><input id="mp-nm" type="text" name="name" value="${esc(p.name)}" maxlength="60" autocomplete="off"></div></div>
      <label class="check"><input type="checkbox" name="gk" ${p.isGK ? "checked" : ""}> Kiper (GK)</label>
      <label class="check"><input type="checkbox" name="cap" ${p.isCaptain ? "checked" : ""}> Kapten (C), satu per tim</label>`,
    read: (r) => ({ number: r.querySelector('[name="number"]').value.trim(), name: r.querySelector('[name="name"]').value.trim(), isGK: r.querySelector('[name="gk"]').checked, isCaptain: r.querySelector('[name="cap"]').checked }),
    validate: (v) => {
      if (!v.name) return "Nama tidak boleh kosong.";
      if (v.number !== "" && (!/^\d{1,2}$/.test(v.number))) return "Nomor punggung harus angka 0–99.";
      if (v.number !== "" && others.some((x) => x.number === Number(v.number))) return `No punggung ${v.number} sudah dipakai pemain lain di tim ini.`;
      return "";
    },
  });
}
/** Tab pilihan di dalam kartu (menggantikan lipatan +/–). */
const tabsNav = (group, items, cur) => `<div class="mtabs" role="tablist">${items.map(([k, l]) => `<button type="button" role="tab" aria-selected="${k === cur}" class="${k === cur ? "on" : ""}" data-act="tab" data-group="${group}" data-tab="${k}">${l}</button>`).join("")}</div>`;

// ---------- Routing ----------
function route() {
  const [name, id] = location.hash.replace(/^#\/?/, "").split("/");
  return { name: name || "dashboard", id };
}

// ---------- Tampilan ----------
function loginView() {
  return `<div class="login"><img src="../assets/logo.png" alt="Industropolis Batang Futsal League" data-sitelogo>
    <h2 class="a" style="text-align:center">Login panitia</h2>
    <div class="adm-clock-m" style="display:flex">${rtClockHtml("adm")}</div>
    <form data-form="login">
      <label>Email</label><input type="email" name="email" autocomplete="username" required>
      <label>Password</label><input type="password" name="password" autocomplete="current-password" required>
      <div class="form-actions"><button class="btn orange big" type="submit">Masuk</button></div>
    </form><p class="hint" style="text-align:center"><a href="../">← Ke website publik</a></p></div>`;
}

// Menu bercabang. Kunci = nama halaman di alamat (#kunci).
const NAV = [
  { title: "Dashboard", items: [["dashboard", "Ringkasan"]] },
  { title: "Pertandingan", items: [["matches", "Semua pertandingan"], ["match-add", "Tambah pertandingan"]] },
  { title: "Tim & Pemain", items: [["teams", "Daftar tim"], ["group-setup", "Susun grup"], ["team-stats", "Statistik tim"], ["team-add", "Tambah tim"]] },
  { title: "Pengaturan", items: [["set-announce", "Pengumuman"], ["set-timing", "Durasi pertandingan"], ["set-keeper", "Kiper terbaik"], ["set-backup", "Backup & unduh data"], ["set-export", "Ekspor ke Excel"], ["set-reset", "Hapus data"]] },
];
const NAV_ALIAS = { match: "matches", team: "teams", player: "teams", settings: "set-announce" };
const navGroup = (key) => NAV.find((g) => g.items.some(([k]) => k === key));
const navKey = (r = route()) => { const k = NAV_ALIAS[r.name] || r.name; return navGroup(k) ? k : "dashboard"; };

function topBar() {
  const key = navKey();
  const cur = navGroup(key);
  const liveNow = state.matches.filter((m) => m.status === "live").length;
  const dot = (g) => (g === NAV[0] && liveNow ? `<i class="livedot" title="Ada laga LIVE"></i>` : "");
  const tree = NAV.map((g) => `<div class="side-group ${g === cur ? "cur" : ""}"><div class="side-title">${esc(g.title)} ${dot(g)}</div>
      <div class="side-sub">${g.items.map(([k, l]) => `<a class="${k === key ? "on" : ""}" href="#${k}" ${k === key ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</div></div>`).join("");
  return `<aside class="side" id="side">
    <div class="side-brand"><img src="../assets/logo.png" alt="" data-sitelogo><div><b>Admin IBFL</b><small>Industropolis Batang Futsal League</small></div></div>
    <div class="side-clock">${rtClockHtml("adm")}</div>
    <nav class="side-tree" aria-label="Menu admin">${tree}</nav>
    <div class="side-foot">
      <a class="side-link" href="../" target="_blank" rel="noopener">Lihat website publik ↗</a>
      <span class="who" title="UID: ${esc(user.uid)}">${esc(user.email)}</span>
      <button class="btn sm ghost" data-act="logout">Keluar</button>
    </div>
  </aside>
  <nav class="tabbar" aria-label="Menu admin">${NAV.map((g) => `<a class="${g === cur ? "on" : ""}" href="#${g.items[0][0]}">${esc(g.title)} ${dot(g)}</a>`).join("")}<button type="button" data-act="logout">Keluar</button></nav>`;
}
// Di HP menu cabang tampil sebagai deretan tombol bulat di atas halaman (sidebar hanya ada di layar lebar).
function subNav() {
  const r = route();
  const mclock = `<div class="adm-clock-m">${rtClockHtml("adm")}</div>`;
  if (r.name === "match" || r.name === "team" || r.name === "player") return mclock;
  const key = navKey(r), g = navGroup(key);
  if (g.items.length < 2) return mclock;
  return mclock + `<nav class="subnav" aria-label="${esc(g.title)}">${g.items.map(([k, l]) => `<a class="${k === key ? "on" : ""}" href="#${k}">${l}</a>`).join("")}</nav>`;
}


// --- Dashboard ---
function dashboardView() {
  const ms = state.matches, ev = state.events;
  const live = ms.filter((m) => m.status === "live").sort(sortByKickoff);
  const sched = ms.filter((m) => m.status === "scheduled").sort(sortByKickoff);
  const done = ms.filter((m) => m.status === "ft").sort((a, b) => sortByKickoff(b, a));
  const players = state.players.filter((p) => !isOfficial(p));
  const goals = ev.filter((e) => e.type === "goal" || e.type === "own_goal").length;
  const yellow = ev.filter((e) => e.type === "yellow").length, red = ev.filter((e) => e.type === "red").length;
  const pct = ms.length ? Math.round((done.length / ms.length) * 100) : 0;
  const avg = done.length ? (done.reduce((a, m) => a + (m.scoreA || 0) + (m.scoreB || 0), 0) / done.length).toFixed(1) : "0";
  const kpi = (n, l, cls = "") => `<div class="kpi ${cls}"><b>${n}</b><span>${l}</span></div>`;
  const kpis = `<div class="kpis">${kpi(state.teams.length, "Tim")}${kpi(players.length, "Pemain")}${kpi(ms.length, "Total laga")}${kpi(live.length, "Sedang LIVE", live.length ? "hot" : "")}${kpi(sched.length, "Akan datang")}${kpi(done.length, "Selesai")}${kpi(goals, "Total gol")}${kpi(avg, "Rata-rata gol/laga")}${kpi(yellow, "Kartu kuning")}${kpi(red, "Kartu merah")}</div>`;
  const prog = `<div class="panel"><h2 class="a">Progres turnamen</h2><div class="dprog"><i style="width:${pct}%"></i></div><p class="hint">${done.length} dari ${ms.length} laga selesai (${pct}%).</p></div>`;
  const liveCard = `<div class="panel"><h2 class="a">Sedang berlangsung</h2>${live.length ? live.map((m) => `<a class="arow is-live" href="#match/${esc(m.id)}"><div class="when">${dayShort(m.kickoff)}<b>${timeStr(m.kickoff)}</b></div><div class="vs"><span>${esc(sideName(m, "A"))} <em>${m.scoreA ?? 0} – ${m.scoreB ?? 0}</em> ${esc(sideName(m, "B"))}</span><small>${statusPill(m)}</small></div><div class="rt"><span class="go">Kontrol</span></div></a>`).join("") : `<p class="empty">Tidak ada laga yang sedang berlangsung.</p>`}</div>`;
  const nextCard = `<div class="panel"><h2 class="a">Laga berikutnya</h2>${sched.length ? sched.slice(0, 5).map((m) => {
    const miss = matchReadiness(m, state.players);
    return `<a class="arow" href="#match/${esc(m.id)}"><div class="when">${m.kickoff ? dayShort(m.kickoff) : "–"}<b>${timeStr(m.kickoff)}</b></div><div class="vs"><span>${esc(sideName(m, "A"))} vs ${esc(sideName(m, "B"))}</span><small>${m.stage === "group" || !m.stage ? "Grup " + esc(m.group || "?") + ", matchday " + esc(m.matchday ?? 1) : STAGES[m.stage] || ""}</small></div><div class="rt">${miss.length ? `<span class="flag warn">Line up kurang</span>` : `<span class="flag ok">Siap dimulai</span>`}</div></a>`;
  }).join("") : `<p class="empty">Tidak ada laga terjadwal.</p>`}</div>`;
  const lastCard = `<div class="panel"><h2 class="a">Hasil terakhir</h2>${done.length ? done.slice(0, 5).map((m) => `<a class="arow" href="#match/${esc(m.id)}"><div class="when">${m.kickoff ? dayShort(m.kickoff) : "–"}<b>${timeStr(m.kickoff)}</b></div><div class="vs"><span>${esc(sideName(m, "A"))} <em>${m.scoreA ?? 0} – ${m.scoreB ?? 0}</em> ${esc(sideName(m, "B"))}</span></div><div class="rt"><span class="go">Lihat</span></div></a>`).join("") : `<p class="empty">Belum ada laga selesai.</p>`}</div>`;
  const std = computeStandings(state.teams, ms, ev);
  const stdCard = Object.keys(std).filter((g) => std[g]?.length).sort().map((g) => `<div class="dstd"><b>Grup ${esc(g)}</b>${std[g].slice(0, 4).map((r, i) => `<div><span>${i + 1}. ${esc(r.name)}</span><em>${r.p}M · ${r.pts} poin</em></div>`).join("")}</div>`).join("");
  const stats = computePlayerStats(state.players, ev, state.teams, state.matches);
  const sc = topBy(stats, "goals", 5);
  const scCard = `<div class="panel"><h2 class="a">Top scorer</h2>${sc.length ? sc.map((p, i) => `<div class="dline"><span>${i + 1}. ${esc(p.name)} <small>${esc(tName(p.teamId))}</small></span><b>${p.goals}</b></div>`).join("") : `<p class="empty">Belum ada gol.</p>`}</div>`;
  const warn = sched.filter((m) => matchReadiness(m, state.players).length).length;
  const alertCard = warn ? `<div class="panel warnbox"><b>${warn} laga terjadwal</b> belum lengkap line up-nya. <a class="lnk" href="#matches">Buka daftar pertandingan</a></div>` : "";
  return `<h1 class="page">Dashboard</h1>${alertCard}${champPanel()}${suspCard()}${kpis}
    <div class="dgrid">${liveCard}${nextCard}</div>${prog}
    <div class="dgrid">${lastCard}${scCard}</div>
    <div class="panel"><h2 class="a">Klasemen sementara</h2><div class="dstds">${stdCard || `<p class="empty">Belum ada grup.</p>`}</div></div>`;
}

// --- Daftar pertandingan ---
function matchForm(m) {
  const k = m || {};
  // Setelah laga dimulai, fase dan tim dikunci (line up dan kejadian terikat pada tim ini). Jadwal/jam tetap bisa diubah.
  const locked = !!m && m.status !== "scheduled", dis = locked ? "disabled" : "";
  return `<form data-form="match" ${m ? `data-id="${esc(m.id)}"` : ""}>
    ${locked ? `<p class="hint">Laga sudah dimulai: fase dan tim tidak bisa diubah. Untuk memperbaiki gol atau kartu pakai tombol <b>Ubah</b> di riwayat kejadian laga itu.</p>` : ""}
    <div class="grid2"><div><label>Fase</label><select name="stage" ${dis}>${stageOptions(k.stage)}</select></div>
      <div><label>Matchday</label><input type="number" name="matchday" min="1" value="${k.matchday ?? 1}"></div></div>
    <div class="grid2"><div><label>Tim A</label><select name="teamA" ${dis}>${teamOptions(k.teamA, undefined, k.stage)}</select></div>
      <div><label>Tim B</label><select name="teamB" ${dis}>${teamOptions(k.teamB, undefined, k.stage)}</select></div></div>
    <div class="grid2"><div><label>Urutan bagan (QF 1–4, SF 1–2)</label><input type="number" name="slot" min="1" max="4" value="${k.slot ?? ""}" placeholder="otomatis dari jam"></div><div></div></div>
    <label>Tanggal &amp; jam (WIB)</label><input type="datetime-local" name="kickoff" value="${toLocalInput(k.kickoff)}">
    <div class="form-actions"><button class="btn orange" type="submit">${m ? "Simpan jadwal" : "Tambah pertandingan"}</button></div>
  </form>`;
}

function addMatchCard() {
  const tab = ui.tabs.addMatch || "manual";
  const body = tab === "paste"
    ? `<form data-form="import-matches">
      <p class="hint">Satu laga per baris, dipisah tanda <b>|</b>:<br><code>tanggal jam | grup atau fase | matchday | tim A | tim B</code><br>
      Contoh:<br><code>2026-11-09 19:00 | A | 1 | Tim A1 | Tim A2</code><br><code>2026-12-04 19:30 | final | 1 | | </code><br>
      Fase: huruf grup (A, B, …) atau <b>qf</b>, <b>sf</b>, <b>final</b>. Nama tim harus sama dengan yang sudah dibuat; untuk fase gugur tim boleh dikosongkan dulu.<br>Bila jam belum ditentukan, tulis <b>TBD</b> di kolom tanggal: <code>TBD | final | 5 | | </code>.</p>
      <textarea name="text" placeholder="2026-11-09 19:00 | A | 1 | Tim A1 | Tim A2"></textarea>
      <div class="form-actions"><button class="btn orange" type="submit">Impor jadwal</button></div></form>`
    : (state.teams.length ? matchForm(null) : `<p class="hint">Buat tim dulu lewat menu <a class="lnk" href="#team-add">Tambah tim</a>.</p>`);
  return `<div class="panel tabcard">${tabsNav("addMatch", [["manual", "Manual"], ["paste", "Tempel banyak"]], tab)}${body}</div>`;
}
function matchAddView() {
  return `<h1 class="page">Tambah pertandingan</h1>${addMatchCard()}`;
}

function matchesView() {
  const all = [...state.matches];
  const live = all.filter((m) => m.status === "live").sort(sortByKickoff);
  const sched = all.filter((m) => m.status === "scheduled").sort(sortByKickoff);
  const done = all.filter((m) => m.status === "ft").sort((a, b) => sortByKickoff(b, a));
  const row = (m) => {
    const miss = m.status === "scheduled" ? matchReadiness(m, state.players) : [];
    const sub = m.stage === "group" || !m.stage ? "Grup " + esc(m.group || "?") + ", matchday " + esc(m.matchday ?? 1) : STAGES[m.stage] || "";
    const flag = m.status === "scheduled" ? (miss.length ? `<span class="flag warn">Line up kurang</span>` : `<span class="flag ok">Siap dimulai</span>`) : m.status === "live" ? statusPill(m) : "";
    return `<a class="arow ${m.status === "live" ? "is-live" : ""}" href="#match/${esc(m.id)}">
      <div class="when">${m.kickoff ? dayShort(m.kickoff) : "–"}<b>${timeStr(m.kickoff)}</b></div>
      <div class="vs"><span>${esc(sideName(m, "A"))} ${m.status === "scheduled" ? "vs" : `<em>${m.scoreA ?? 0} – ${m.scoreB ?? 0}</em>`} ${esc(sideName(m, "B"))}</span><small>${sub}</small></div>
      <div class="rt">${flag}<span class="go">${m.status === "live" ? "Kontrol" : m.status === "ft" ? "Lihat" : "Kelola"}</span></div></a>`;
  };
  const sec = (title, list) => list.length ? `<h2 class="sect">${title} <span>${list.length}</span></h2><div class="panel list">${list.map(row).join("")}</div>` : "";
  const plan = planKnockout(state.teams, state.matches, state.events);
  const koCard = plan.length ? `<div class="panel ko-fill"><h2 class="a">Pasangan babak gugur belum terisi</h2>
    <p class="hint">Biasanya terisi otomatis. Kartu ini hanya muncul bila pengisian otomatis belum berhasil (mis. koneksi terputus): <b>${plan.map((x) => esc(x.name)).join(", ")}</b>. Tekan tombol untuk mengisi sekarang. Tim yang sudah terisi tidak diubah.</p>
    <div class="btns"><button class="btn orange" data-act="fill-ko">Isi pasangan sekarang</button></div></div>` : "";
  const ties = unresolvedTies(state.teams, state.matches, state.events);
  const tieCard = ties.map((t, n) => `<form class="panel ko-fill" data-form="tiebreak" data-id="${n}"><h2 class="a">Grup ${esc(t.group)}: seri penuh, tentukan lewat adu penalti</h2>
    <p class="hint">Poin, GM, head to head, selisih gol, dan kartu sama. Setelah adu penalti/undian, isi urutan akhir (1 = paling atas) lalu simpan.</p>
    ${t.rows.map((r) => `<div class="tie-row"><span>${esc(r.name)}</span><input type="number" name="tb-${esc(r.teamId)}" min="1" max="${t.rows.length}" required inputmode="numeric" aria-label="Urutan ${esc(r.name)}"></div>`).join("")}
    <div class="btns"><button class="btn orange" type="submit">Simpan urutan</button></div></form>`).join("");
  return `<h1 class="page">Pertandingan</h1>${tieCard}${koCard}
  ${sec("Sedang berlangsung", live)}${sec("Akan datang", sched)}${sec("Selesai", done)}
  ${all.length ? "" : `<div class="panel"><p class="empty">Belum ada pertandingan. Tambahkan lewat menu <a class="lnk" href="#match-add">Tambah pertandingan</a>.</p></div>`}`;
}

// Adu penalti: hanya untuk babak gugur yang skornya seri. Tiap tendangan dicatat (Gol/Gagal), pemenang dihitung otomatis.
// Tendangan penalti TIDAK dicatat sebagai gol: tidak masuk top scorer, skor tetap seri, tidak menambah kebobolan kiper.
function penForm(m) {
  if (!isKnockout(m) || m.status === "scheduled" || (m.scoreA ?? 0) !== (m.scoreB ?? 0)) return "";
  // selama babak biasa/ET masih berjalan, penalti belum relevan; muncul saat fase adu penalti, setelah FT, atau saat koreksi
  if (m.status === "live" && phaseOf(m) !== "pen" && !m.correcting) return "";
  const so = shootout(m), live = m.status === "live" && (phaseOf(m) === "pen" || m.correcting);
  const id = esc(m.id);
  const side = (s) => {
    const off = so.winner || (so.next && so.next !== s);
    return `<div class="pen-side"><b>${esc(sideName(m, s))}</b><div class="pen-dots" aria-label="Hasil tendangan">${penDots(m, s)}</div>
      <div class="pen-btns"><button class="btn go" data-act="pen-kick" data-id="${id}" data-side="${s}" data-res="g" ${off ? "disabled" : ""}>Gol</button>
      <button class="btn danger" data-act="pen-kick" data-id="${id}" data-side="${s}" data-res="m" ${off ? "disabled" : ""}>Gagal</button></div></div>`;
  };
  const status = so.winner
    ? `Pemenang: <b>${esc(sideName(m, so.winner))}</b> (otomatis). Tekan Selesai (FT) untuk mengakhiri laga.`
    : so.any
      ? (so.next ? `Giliran <b>${esc(sideName(m, so.next))}</b>.` : `Kedua tim sudah menendang ${so.taken.A}x. Lanjut tendangan berikutnya.`) + (so.taken.A >= PEN_ROUNDS && so.taken.B >= PEN_ROUNDS ? " Sudah masuk sudden death." : "")
      : `Belum ada tendangan. Catat tendangan pertama dari tim yang menendang lebih dulu.`;
  return `<div class="panel warnbox"><h2 class="a">${phaseOf(m) === "pen" ? "Adu penalti" : "Skor seri: adu penalti"}</h2>
    ${live ? `<div class="pen-board"><div class="pen-score"><span>${esc(sideName(m, "A"))}</span><b>${so.goals.A} – ${so.goals.B}</b><span>${esc(sideName(m, "B"))}</span></div>
      <div class="pen-sides">${side("A")}${side("B")}</div>
      <p class="hint pen-status">${status}</p>
      <div class="btns"><button class="btn ghost" data-act="pen-undo" data-id="${id}" ${so.any ? "" : "disabled"}>Batalkan tendangan terakhir</button></div></div>` : so.any ? `<p class="hint">Hasil tendangan: ${so.goals.A} – ${so.goals.B}.</p>` : ""}
    <form data-form="pen" data-id="${id}">
      <p class="hint">${live ? "Cadangan (bila perlu): pilih pemenang manual. Ini mengosongkan tendangan yang sudah dicatat." : "Pemenang adu penalti."} Wajib ada pemenang sebelum laga bisa diakhiri. Pemenang otomatis lanjut ke babak berikutnya.</p>
      <div class="grid2"><select name="pen"><option value="">— belum dipilih —</option><option value="A" ${m.penWinner === "A" ? "selected" : ""}>${esc(sideName(m, "A"))}</option><option value="B" ${m.penWinner === "B" ? "selected" : ""}>${esc(sideName(m, "B"))}</option></select>
      <button class="btn ghost" type="submit">Simpan manual</button></div></form></div>`;
}

// ---------- Line up (draft di memori sampai disimpan) ----------
// ---------- Skorsing, pelanggaran, pergantian ----------
const suspOv = () => state.settings.suspOverrides || {};
const suspOf = (m, side) => suspendedIn(m, side === "A" ? m.teamA : m.teamB, state.matches, state.events, state.players, suspOv());
const warnOf = (m, side) => warnedIn(m, side === "A" ? m.teamA : m.teamB, state.matches, state.events, state.players, suspOv());
const matchTag = (id) => { const x = state.matchById[id]; return x ? `${sideName(x, "A")} vs ${sideName(x, "B")}` : ""; };
/** Pemain terskors yang sudah ada di line up tersimpan (mis. dipilih sebelum kartu dicatat). */
function suspProblems(m) {
  const out = [];
  for (const side of ["A", "B"]) {
    const sp = suspOf(m, side);
    for (const id of lineupIds(m, side)) if (sp.has(id)) out.push(`${pName(id)} (${sideName(m, side)}) sedang skorsing: ${suspReason(sp.get(id))}`);
  }
  return out;
}
/** Pemain di line up tersimpan yang kena peringatan akumulasi kuning (belum diputuskan panitia). */
function warnProblems(m) {
  const out = [];
  for (const side of ["A", "B"]) {
    const w = warnOf(m, side);
    for (const id of lineupIds(m, side)) if (w.has(id)) out.push(`${pName(id)} (${sideName(m, side)})`);
  }
  return out;
}
/** Skorsing yang berlaku di laga ini, ditambah yang dibatalkan panitia (supaya bisa dikembalikan). */
function suspRows(m, side) {
  if (m.status === "ft") return [];
  const t = side === "A" ? m.teamA : m.teamB;
  if (!t) return [];
  const ov = computeSuspensions(t, state.matches, state.events, state.players, suspOv());
  const base = computeSuspensions(t, state.matches, state.events, state.players, {});
  const rows = ov.filter((o) => o.covers.includes(m.id));
  for (const b of base) { const o = ov.find((x) => x.key === b.key); if (o && o.len === 0 && b.covers.includes(m.id)) rows.push(o); }
  return rows;
}
function suspPanel(m) {
  const rows = ["A", "B"].flatMap((side) => suspRows(m, side).map((o) => {
    const cancelled = o.len === 0, soft = o.soft;
    const label = cancelled ? (o.kind === "yellow" ? "Peringatan kuning diabaikan panitia" : "Skorsing dibatalkan panitia") : soft ? `Peringatan: ${esc(suspReason(o))}. Belum diberlakukan, panitia yang memutuskan` : esc(suspReason(o));
    const btns = cancelled ? "" : soft
      ? `<button type="button" class="btn sm danger" data-act="susp-set" data-id="${esc(o.key)}" data-len="1">Terapkan skorsing</button><button type="button" class="btn sm ghost" data-act="susp-set" data-id="${esc(o.key)}" data-len="0" data-soft="1">Abaikan</button>`
      : `<button type="button" class="btn sm danger" data-act="susp-set" data-id="${esc(o.key)}" data-len="0">Batalkan skorsing</button><button type="button" class="btn sm ghost" data-act="susp-set" data-id="${esc(o.key)}" data-len="${o.len + 1}">+1 laga</button>`;
    return `<div class="susp-row ${cancelled ? "off" : ""}"><div><b>${esc(pName(o.playerId))}</b> <span class="muted">${esc(sideName(m, side))}</span>
      <small>${label} · dari laga ${esc(matchTag(o.matchId))}</small></div>
      <div class="btns">${btns}
      ${o.overridden ? `<button type="button" class="btn sm ghost" data-act="susp-set" data-id="${esc(o.key)}" data-len="">Kembalikan otomatis</button>` : ""}</div></div>`;
  })).join("");
  return rows ? `<div class="susp"><h3>Skorsing untuk laga ini</h3><p class="hint">Kartu merah (termasuk dua kuning di satu laga) otomatis memblokir pemain dari line up. Akumulasi kuning di laga berbeda hanya peringatan: panitia memilih Terapkan skorsing atau Abaikan.</p>${rows}</div>` : "";
}
const playerOpts = (ids) => ids.map((id) => state.playerById[id]).filter(Boolean).sort(byNumber).map((p) => `<option value="${esc(p.id)}">${p.number ?? "–"} · ${esc(p.name)}${p.isGK ? " (GK)" : ""}</option>`).join("");
const uniq = (l) => [...new Set(l.filter(Boolean))];
/** Pasang kiper baru. Bila kiper itu belum di lapangan (masih cadangan), dia masuk menggantikan kiper lama; riwayatnya disimpan di subLog supaya bisa dibatalkan. */
async function putKeeper(m, side, next, cur, text) {
  const on = onCourtIds(m, side, state.events), st = stampNow(m), b = writeBatch(db);
  const used = m["gkUsed" + side] ?? uniq([cur]);
  const patch = { ["gk" + side]: next, ["gkUsed" + side]: uniq([...used, next]) };
  if (!on.includes(next)) {
    const entry = { s: side, out: cur ?? null, in: next, minute: st.minute, extra: st.extra, sec: st.sec, p: st.p, ps: st.ps, pm: st.pm, ts: nowMs(), g: 1, gp: cur ?? null, gu: used };
    patch.subLog = [...(m.subLog || []), entry];
  }
  b.update(matchRef(m.id), patch);
  b.set(doc(collection(db, "events")), mkNote(m, text, st));
  await b.commit();
}
/** Kiper yang boleh menggantikan kiper sekarang: pemain bertanda GK di line up tim itu, belum kena merah, bukan kiper yang sedang jaga. */
function gkCandidates(m, side, cur) {
  const off = new Set(state.events.filter((e) => e.matchId === m.id && e.type === "red").map((e) => e.playerId));
  return lineupIds(m, side).filter((x) => x !== cur && state.playerById[x]?.isGK && !off.has(x));
}
function courtPanel(m) {
  const box = (side) => {
    const on = onCourtIds(m, side, state.events), gk = gkNow(m, side, state.players);
    const ct = cardTotals(state.events, m.id, side === "A" ? m.teamA : m.teamB);
    const names = on.map((id) => state.playerById[id]).filter(Boolean).sort(byNumber).map((p) => `<span class="oc ${p.id === gk ? "gk" : ""}">${p.number ?? "–"} ${esc(p.name)}${p.id === gk ? " · GK" : ""}</span>`).join("");
    const pp = gk === null, canSwap = !pp && gkCandidates(m, side, gk).length > 0;
    const gkWarn = gk && !on.includes(gk) ? `<p class="problems">Kiper dikeluarkan. Pilih kiper pengganti lewat Ganti kiper.</p>` : pp ? `<p class="hint"><b>Power play</b>: tanpa kiper, gol tidak dibebankan ke kiper mana pun.</p>` : !canSwap ? `<p class="hint">Hanya ada 1 kiper di line up, jadi kiper tidak bisa diganti. Pakai Power play bila ingin main tanpa kiper.</p>` : "";
    const id = esc(m.id);
    return `<div class="court-col"><h3>${esc(sideName(m, side))}</h3>
      <div class="foulrow"><span>Total kartu</span><span class="cardtot"><i class="card y"></i><b>${ct.y}</b><i class="card r"></i><b>${ct.r}</b></span></div>
      <div class="onc" aria-label="Pemain di lapangan">${names || `<span class="muted">Belum ada pemain di lapangan.</span>`}</div>${gkWarn}
      <div class="btns">${pp
        ? `<button type="button" class="btn" data-act="powerplay" data-id="${id}" data-side="${side}">Akhiri power play</button>`
        : `<button type="button" class="btn ghost" data-act="gk-change" data-id="${id}" data-side="${side}" ${canSwap ? "" : "disabled"}>Ganti kiper</button><button type="button" class="btn ghost" data-act="powerplay" data-id="${id}" data-side="${side}">Power play</button>`}</div></div>`;
  };
  const last = (m.subLog || []).at(-1), subs = (m.subLog || []).length;
  return `<div class="panel"><h2 class="a">Kiper</h2>
    <p class="hint">Ganti kiper hanya bisa dengan kiper lain di line up tim yang sama (tim dengan 1 kiper tidak bisa ganti). Power play = main tanpa kiper. Kebobolan dibebankan ke kiper yang sedang jaga saat gol terjadi.</p>
    <div class="court">${box("A")}${box("B")}</div>
    ${last ? `<p class="hint">${subs} ganti kiper tercatat. Terakhir: ${esc(pName(last.in))} masuk menggantikan ${esc(pName(last.out))} (${esc(sideName(m, last.s))}) ${eventMinute(last)}. <button type="button" class="btn sm ghost" data-act="sub-undo" data-id="${esc(m.id)}">Batalkan ganti kiper terakhir</button></p>` : ""}</div>`;
}
function suspCard() {
  const rows = [];
  for (const t of state.teams) {
    const next = state.matches.filter((x) => x.status === "scheduled" && (x.teamA === t.id || x.teamB === t.id)).sort(sortByKickoff)[0];
    if (!next) continue;
    for (const o of suspendedIn(next, t.id, state.matches, state.events, state.players, suspOv()).values()) rows.push({ t, o, next });
    for (const o of warnedIn(next, t.id, state.matches, state.events, state.players, suspOv()).values()) rows.push({ t, o, next, warn: true });
  }
  if (!rows.length) return "";
  return `<div class="panel warnbox"><h2 class="a">Skorsing dan peringatan di laga berikutnya</h2>${rows.map(({ t, o, next, warn }) => `<a class="arow" href="#match/${esc(next.id)}"><div class="vs"><span>${esc(pName(o.playerId))} <em>${esc(t.name)}</em></span><small>${warn ? "Peringatan, perlu keputusan panitia: " : ""}${esc(suspReason(o))} · ${warn ? "lawan" : "absen lawan"} ${esc(sideName(next, next.teamA === t.id ? "B" : "A"))}</small></div></a>`).join("")}</div>`;
}

const luSig = (m) => JSON.stringify([m.lineupA || null, m.lineupB || null]);
const draftOf = (m) => {
  // dibangun ulang bila ganti laga, atau bila belum diubah tapi data tersimpan berubah (mis. baru disimpan)
  if (!ui.draft || ui.draft.id !== m.id || (!ui.draft.dirty && ui.draft.sig !== luSig(m))) {
    const mk = (side) => {
      const lu = m["lineup" + side] || {};
      const o = {};
      (lu.starters || []).forEach((id) => (o[id] = "S"));
      (lu.subs || []).forEach((id) => (o[id] = "B"));
      return o;
    };
    ui.draft = { id: m.id, A: mk("A"), B: mk("B"), dirty: false, sig: luSig(m) };
  }
  return ui.draft;
};
function draftProblems(m, d) {
  const out = [];
  for (const side of ["A", "B"]) {
    const teamId = side === "A" ? m.teamA : m.teamB;
    const list = playersOf(teamId);
    const st = list.filter((p) => d[side][p.id] === "S");
    const name = sideName(m, side);
    if (st.length !== FUTSAL_STARTERS) out.push(`${name}: inti ${st.length}/${FUTSAL_STARTERS}`);
    else if (!st.some((p) => p.isGK)) out.push(`${name}: belum ada kiper di susunan inti`);
    const tot = list.filter((p) => d[side][p.id]).length;
    if (tot > LINEUP_MAX) out.push(`${name}: line up ${tot}/${LINEUP_MAX}, kelebihan ${tot - LINEUP_MAX} pemain`);
  }
  return out;
}
function lineupEditor(m) {
  const d = draftOf(m);
  const col = (side) => {
    const teamId = side === "A" ? m.teamA : m.teamB;
    const list = playersOf(teamId), susp = suspOf(m, side), warn = warnOf(m, side);
    const st = list.filter((p) => d[side][p.id] === "S").length;
    const bn = list.filter((p) => d[side][p.id] === "B").length;
    return `<div class="lu-col"><div class="lu-title"><b>${esc(sideName(m, side))}</b><span class="${st === FUTSAL_STARTERS ? "okc" : "badc"}">Inti ${st}/${FUTSAL_STARTERS}</span><span class="muted">Cadangan ${bn}</span><span class="${st + bn <= LINEUP_MAX ? "muted" : "badc"}">Line up ${st + bn}/${LINEUP_MAX}</span></div>
      <div class="tiles">${list.map((p) => {
        const v = d[side][p.id] || "", sp = susp.get(p.id);
        return `<button type="button" class="tile ${v === "S" ? "is-s" : v === "B" ? "is-b" : ""} ${sp ? "is-susp" : ""}" ${sp && !v ? "disabled" : ""} data-act="lu-toggle" data-id="${esc(p.id)}" data-side="${side}" aria-pressed="${v ? "true" : "false"}">
          <span class="no">${p.number ?? "–"}</span><span class="nm">${esc(p.name)}</span><span class="st">${p.isCaptain ? "C · " : ""}${p.isGK ? "GK · " : ""}${!sp && warn.has(p.id) ? "⚠ 2 kuning · " : ""}${sp ? "Skorsing" + (v ? " (lepas)" : "") : v === "S" ? "Inti" : v === "B" ? "Cadangan" : "Ketuk untuk pilih"}</span></button>`;
      }).join("") || `<p class="hint">Belum ada pemain di tim ini.</p>`}</div></div>`;
  };
  const probs = draftProblems(m, d);
  return `<p class="hint">Ketuk pemain: sekali = Inti, dua kali = Cadangan, tiga kali = batal. Inti harus 5 pemain dan wajib ada kiper (slot inti terakhir hanya bisa diisi kiper bila belum ada). Line up (inti + cadangan) maksimal ${LINEUP_MAX} pemain per tim, walau tim boleh mendaftarkan sampai ${LIMITS.players} pemain.</p>
    ${suspPanel(m)}
    <div class="lu-cols">${col("A")}${col("B")}</div>
    ${probs.length ? `<p class="problems">${probs.map(esc).join(" · ")}</p>` : `<p class="okline">Susunan inti lengkap.</p>`}
    <div class="btns"><button class="btn orange" data-act="lu-save" data-id="${esc(m.id)}" ${d.dirty ? "" : "disabled"}>Simpan line up</button>
      ${d.dirty ? `<button class="btn ghost" data-act="lu-reset" data-id="${esc(m.id)}">Batalkan perubahan</button>` : ""}</div>`;
}

// ---------- POS: satu pertandingan ----------
const typeLabel = { goal: "Gol", penalty: "Gol penalti", own_goal: "Gol bunuh diri", yellow: "Kartu kuning", red: "Kartu merah" };
const evLabel = (e) => (e.type === "phase" ? e.note : e.type === "goal" && e.pen ? typeLabel.penalty : e.type === "red" && e.second ? "Kartu merah (kuning kedua)" : typeLabel[e.type] || e.type);
const evIcon = (e) => e.type === "goal" ? `<span class="evic">${ballSvg()}${e.pen ? '<i class="evtag">P</i>' : ""}</span>`
  : e.type === "own_goal" ? `<span class="evic">${ballSvg("og")}<i class="evtag og">OG</i></span>`
  : e.type === "yellow" ? `<span class="evic"><i class="card y"></i></span>` : e.type === "red" ? `<span class="evic"><i class="card r"></i></span>` : "";

function playerTile(m, side, p) {
  const evs = state.events.filter((e) => e.matchId === m.id && e.playerId === p.id);
  const g = evs.filter((e) => e.type === "goal").length, pen = evs.some((e) => e.type === "goal" && e.pen);
  const og = evs.filter((e) => e.type === "own_goal").length;
  const yc = evs.some((e) => e.type === "yellow"), rc = evs.some((e) => e.type === "red");
  const starter = onCourtIds(m, side, state.events).includes(p.id);
  const marks = `${g ? `<i class="mk g">${ballSvg()}${g > 1 ? `<b>${g}</b>` : ""}${pen ? '<b class="evtag">P</b>' : ""}</i>` : ""}${og ? `<i class="mk og">${ballSvg("og")}<b class="evtag og">OG</b></i>` : ""}${yc ? `<i class="mk y"></i>` : ""}${rc ? `<i class="mk r"></i>` : ""}`;
  return `<button type="button" class="ptile ${starter ? "" : "bench"} ${rc ? "out" : ""}" data-act="pick" data-side="${side}" data-id="${esc(p.id)}">
    <span class="no">${p.number ?? "–"}</span><span class="nm">${esc(p.name)}</span><span class="tg">${[p.isCaptain ? "C" : "", p.isGK ? "GK" : rc ? "Keluar" : starter ? "" : "Cad."].filter(Boolean).join(" ")}</span><span class="marks">${marks}</span></button>`;
}

// Ubah kejadian yang sudah tercatat: pemain, assist, dan jenis (gol/penalti/bunuh diri atau kuning/merah)
const kindOf = (e) => (e.type === "goal" ? (e.pen ? "pen" : "goal") : e.type === "own_goal" ? "own" : e.type);
const KIND_LABEL = { goal: "Gol", pen: "Gol penalti", own: "Gol bunuh diri", yellow: "Kartu kuning", red: "Kartu merah" };
/** Menit kejadian sebagai isian form: waktu normal (menit berjalan 1..total) atau perpanjangan (ET1/ET2). */
function minuteFields(m, e) {
  if (e.p === "et1" || e.p === "et2") return { phase: e.p, minute: e.pm ?? Math.floor((e.ps || 0) / 60) + 1, extra: e.extra || 0 };
  return { phase: "reg", minute: e.minute ?? 1, extra: e.extra || 0 };
}
/** Ubah isian menit jadi cap waktu yang sama bentuknya dengan yang dibuat jam laga (p, ps, pm, sec, minute, extra). */
function stampFromFields(m, phase, minute, extra) {
  const c = m.cfg || cfgFor(m);
  if (!Number.isInteger(minute) || minute < 1) throw new Error("Menit harus angka bulat mulai dari 1.");
  if (!Number.isInteger(extra) || extra < 0) throw new Error("Tambahan waktu harus 0 atau lebih.");
  let p, pm, lim;
  if (phase === "et1" || phase === "et2") {
    p = phase; pm = minute; lim = c.etHalf;
    if (pm > lim) throw new Error(`Perpanjangan waktu hanya sampai menit ${lim}.`);
  } else {
    const reg = c.halves * c.half;
    if (minute > reg) throw new Error(`Waktu normal hanya sampai menit ${reg}. Untuk lewat dari itu, pakai tambahan waktu (mis. menit ${reg} tambahan 1 = ${reg}+1').`);
    if (c.halves >= 2 && minute > c.half) { p = "h2"; pm = minute - c.half; } else { p = "h1"; pm = minute; }
    lim = c.half;
  }
  if (extra > 0 && pm !== lim) throw new Error(`Tambahan waktu hanya untuk menit terakhir babak (menit ${p === "h2" ? c.half * 2 : p === "h1" ? c.half : lim}). Kosongkan tambahan waktu atau ubah menitnya.`);
  const ps = extra > 0 ? lim * 60 + (extra - 1) * 60 + 30 : (pm - 1) * 60 + 30;
  return stampAt(m, p, ps);
}
function editSheet(m, s) {
  const e = state.events.find((x) => x.id === s.eventId);
  if (!e) return "";
  const side = e.teamId === m.teamA ? "A" : "B";
  const d = s.draft, c = m.cfg || cfgFor(m);
  const isGoalEv = e.type === "goal" || e.type === "own_goal";
  const kinds = isGoalEv ? ["goal", "pen", "own"] : ["yellow", "red"];
  const lu = lineupIds(m, side).map((id) => state.playerById[id]).filter(Boolean).sort(byNumber);
  const label = (x) => `${x.number != null ? x.number + " · " : ""}${esc(x.name)}`;
  const showPh = !!m.etPlayed || d.phase !== "reg";
  const range = d.phase === "reg" ? `Waktu normal: menit 1 sampai ${c.halves * c.half}.` : `Perpanjangan waktu: menit 1 sampai ${c.etHalf} per babak.`;
  return `<div class="sheet-bg" data-act="close-sheet"></div><div class="sheet-box" role="dialog" aria-label="Ubah kejadian">
    <div class="sheet-head"><div><b>Ubah kejadian</b><small>${esc(sideName(m, side))}, sekarang ${eventMinute(e)}</small></div><button class="x" data-act="close-sheet" aria-label="Tutup">Tutup</button></div>
    <form data-form="edit-event" data-id="${esc(e.id)}" class="editev">
      <label for="ee-kind">Jenis kejadian</label>
      <select id="ee-kind" name="kind" data-evd="1">${kinds.map((k) => `<option value="${k}" ${d.kind === k ? "selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}</select>
      <label for="ee-pl">${d.kind === "own" ? "Pemain yang bunuh diri" : isGoalEv ? "Pencetak gol" : "Pemain yang dikartu"}</label>
      <select id="ee-pl" name="player" data-evd="1">${lu.map((x) => `<option value="${esc(x.id)}" ${d.playerId === x.id ? "selected" : ""}>${label(x)}</option>`).join("")}</select>
      ${d.kind === "goal" ? `<label for="ee-as">Assist</label>
      <select id="ee-as" name="assist"><option value="">Tanpa assist</option>${lu.filter((x) => x.id !== d.playerId).map((x) => `<option value="${esc(x.id)}" ${d.assistId === x.id ? "selected" : ""}>${label(x)}</option>`).join("")}</select>` : ""}
      ${showPh ? `<label for="ee-ph">Waktu</label>
      <select id="ee-ph" name="phase" data-evd="1"><option value="reg" ${d.phase === "reg" ? "selected" : ""}>Waktu normal</option><option value="et1" ${d.phase === "et1" ? "selected" : ""}>Perpanjangan babak 1 (ET1)</option><option value="et2" ${d.phase === "et2" ? "selected" : ""}>Perpanjangan babak 2 (ET2)</option></select>` : ""}
      <div class="evt-row"><div><label for="ee-min">Menit</label><input id="ee-min" name="minute" type="number" inputmode="numeric" min="1" step="1" value="${esc(d.minute)}"></div>
      <div><label for="ee-ex">Tambahan waktu</label><input id="ee-ex" name="extra" type="number" inputmode="numeric" min="0" step="1" value="${esc(d.extra)}"></div></div>
      <p class="hint">${range} Tambahan waktu diisi 0 bila tidak ada; hanya untuk menit terakhir babak (mis. menit ${c.half} tambahan 1 tampil ${c.half}+1').</p>
      <div class="form-actions"><button class="btn orange big" type="submit">Simpan perubahan</button><button type="button" class="btn ghost big" data-act="close-sheet">Batal</button></div>
    </form></div>`;
}

function sheetView(m) {
  const s = ui.sheet;
  if (!s || s.matchId !== m.id) return "";
  if (s.step === "edit") return editSheet(m, s);
  const p = state.playerById[s.playerId];
  if (!p) return "";
  const teamName = sideName(m, s.side);
  if (s.step === "assist") {
    const mates = lineupIds(m, s.side).filter((id) => id !== p.id).map((id) => state.playerById[id]).filter(Boolean).sort(byNumber);
    return `<div class="sheet-bg" data-act="close-sheet"></div><div class="sheet-box" role="dialog" aria-label="Pilih assist">
      <div class="sheet-head"><div><b>Gol ${esc(p.name)}</b><small>${esc(teamName)}, menit ${minuteNow(m)}</small></div><button class="x" data-act="close-sheet" aria-label="Tutup">Tutup</button></div>
      <p class="sheet-q">Siapa yang assist?</p>
      <div class="sheet-grid">${mates.map((a) => `<button class="opt" data-act="assist" data-pick="${esc(a.id)}"><b>${a.number ?? "–"}</b>${esc(a.name)}</button>`).join("")}
        <button class="opt none" data-act="assist" data-pick="">Tanpa assist</button></div></div>`;
  }
  return `<div class="sheet-bg" data-act="close-sheet"></div><div class="sheet-box" role="dialog" aria-label="Catat kejadian">
    <div class="sheet-head"><div><b>${p.number ?? "–"} · ${esc(p.name)}</b><small>${esc(teamName)}, menit ${minuteNow(m)}</small></div><button class="x" data-act="close-sheet" aria-label="Tutup">Tutup</button></div>
    <div class="sheet-grid acts">
      <button class="opt goal" data-act="ev" data-type="goal">${ballSvg("lg")} Gol</button>
      <button class="opt pen" data-act="ev" data-type="penalty">${ballSvg()} Gol penalti <i class="evtag">P</i></button>
      <button class="opt own" data-act="ev" data-type="own_goal">${ballSvg("og")} Gol bunuh diri <i class="evtag og">OG</i></button>
      <button class="opt yel" data-act="ev" data-type="yellow"><i class="card y"></i> Kartu kuning</button>
      <button class="opt red" data-act="ev" data-type="red"><i class="card r"></i> Kartu merah</button>
    </div></div>`;
}

/** Gol yang ikut dalam skor tampil tetapi belum punya pencetak (skor dipaksa lewat form Skor, atau lupa dicatat). */
function unexplained(m) {
  const [da, db_] = scoreFromEvents(m, state.events);
  return { a: (m.scoreA ?? 0) - da, b: (m.scoreB ?? 0) - db_, da, db: db_ };
}
function unexplainedNote(m) {
  const u = unexplained(m);
  if (u.a <= 0 && u.b <= 0) return "";
  const parts = [u.a > 0 ? `${u.a} gol ${esc(sideName(m, "A"))}` : "", u.b > 0 ? `${u.b} gol ${esc(sideName(m, "B"))}` : ""].filter(Boolean).join(" dan ");
  return `<div class="panel warnbox"><b>Pencetak gol belum lengkap.</b> Skor ${m.scoreA ?? 0} – ${m.scoreB ?? 0}, tetapi yang tercatat baru ${u.da} – ${u.db}. Belum ada pencetak untuk ${parts}. Tambahkan di <b>Kelola laga → Koreksi &amp; hapus → Tambah kejadian susulan</b>. Skor tidak berubah, hanya pencetaknya yang terisi.</div>`;
}
/** Tambah kejadian (gol, assist, kartu) ke laga yang sudah selesai, tanpa membuka kembali laganya. */
function addEventForm(m) {
  const d = ui.addEv && ui.addEv.matchId === m.id ? ui.addEv : (ui.addEv = { matchId: m.id, side: "A", kind: "goal", playerId: "", assistId: "", phase: "reg", minute: "", extra: "0" });
  const teamId = d.side === "A" ? m.teamA : m.teamB, c = m.cfg || cfgFor(m);
  const roster = teamId ? playersOf(teamId) : [];
  const label = (x) => `${x.number != null ? x.number + " · " : ""}${esc(x.name)}${x.isGK ? " (GK)" : ""}`;
  const kinds = ["goal", "pen", "own", "yellow", "red"], isGoalKind = ["goal", "pen", "own"].includes(d.kind);
  const range = d.phase === "reg" ? `Waktu normal: menit 1 sampai ${c.halves * c.half}.` : `Perpanjangan waktu: menit 1 sampai ${c.etHalf} per babak.`;
  return `<form data-form="add-event" data-id="${esc(m.id)}" class="editev addev">
    <h3 class="subh">Tambah kejadian susulan</h3>
    ${unexplained(m).a > 0 || unexplained(m).b > 0 ? `<p class="hint">Pakai ini untuk mengisi pencetak gol yang belum tercatat. Skor tetap, hanya pencetak dan assist yang terisi.</p>` : `<p class="hint">Lupa mencatat gol atau kartu? Tambahkan di sini. Gol baru menambah skor.</p>`}
    <label for="ae-side">Tim</label>
    <select id="ae-side" name="side" data-aevd="1"><option value="A" ${d.side === "A" ? "selected" : ""}>${esc(sideName(m, "A"))}</option><option value="B" ${d.side === "B" ? "selected" : ""}>${esc(sideName(m, "B"))}</option></select>
    <label for="ae-kind">Jenis kejadian</label>
    <select id="ae-kind" name="kind" data-aevd="1">${kinds.map((k) => `<option value="${k}" ${d.kind === k ? "selected" : ""}>${KIND_LABEL[k]}</option>`).join("")}</select>
    <label for="ae-pl">${d.kind === "own" ? "Pemain yang bunuh diri" : isGoalKind ? "Pencetak gol" : "Pemain yang dikartu"}</label>
    <select id="ae-pl" name="player" data-aevd="1"><option value="">— pilih pemain —</option>${roster.map((x) => `<option value="${esc(x.id)}" ${d.playerId === x.id ? "selected" : ""}>${label(x)}</option>`).join("")}</select>
    ${d.kind === "goal" ? `<label for="ae-as">Assist (boleh kosong)</label>
    <select id="ae-as" name="assist"><option value="">Tanpa assist</option>${roster.filter((x) => x.id !== d.playerId).map((x) => `<option value="${esc(x.id)}" ${d.assistId === x.id ? "selected" : ""}>${label(x)}</option>`).join("")}</select>` : ""}
    ${m.etPlayed || d.phase !== "reg" ? `<label for="ae-ph">Waktu</label>
    <select id="ae-ph" name="phase" data-aevd="1"><option value="reg" ${d.phase === "reg" ? "selected" : ""}>Waktu normal</option><option value="et1" ${d.phase === "et1" ? "selected" : ""}>Perpanjangan babak 1 (ET1)</option><option value="et2" ${d.phase === "et2" ? "selected" : ""}>Perpanjangan babak 2 (ET2)</option></select>` : ""}
    <div class="evt-row"><div><label for="ae-min">Menit (perkiraan juga boleh)</label><input id="ae-min" name="minute" type="number" inputmode="numeric" min="1" step="1" value="${esc(d.minute)}"></div>
    <div><label for="ae-ex">Tambahan waktu</label><input id="ae-ex" name="extra" type="number" inputmode="numeric" min="0" step="1" value="${esc(d.extra)}"></div></div>
    <p class="hint">${range}</p>
    <div class="form-actions"><button class="btn orange" type="submit">Tambah kejadian</button></div>
  </form>`;
}

function manageCard(m, allPlayers) {
  const id = m.id;
  const tabs = [];
  if (m.status !== "scheduled" && allPlayers.length) tabs.push(["motm", "Man of the Match"]);
  tabs.push(["jadwal", "Ubah jadwal &amp; tim"], ["koreksi", "Koreksi &amp; hapus"]);
  const cur = tabs.some((t) => t[0] === ui.tabs.matchMgmt) ? ui.tabs.matchMgmt : tabs[0][0];
  let body;
  if (cur === "motm") {
    body = `<form data-form="motm" data-id="${esc(id)}">
      <select name="motm" aria-label="Man of the Match"><option value="">— belum dipilih —</option>${allPlayers.map((p) => `<option value="${esc(p.id)}" ${m.motmId === p.id ? "selected" : ""}>${esc(p.name)} (${esc(tName(p.teamId))})</option>`).join("")}</select>
      <div class="form-actions"><button class="btn orange" type="submit">Simpan</button></div></form>`;
  } else if (cur === "jadwal") {
    body = matchForm(m);
  } else {
    const delBtn = `<div class="btns"><button class="btn danger" data-act="del-match" data-id="${esc(id)}">Hapus pertandingan ini</button></div>`;
    body = m.status === "scheduled"
      ? `<p class="hint">Laga belum dimulai, jadi belum ada yang perlu dikoreksi. Kalau tim lawan tidak hadir, pakai <b>Menang WO</b> di atas. Hapus hanya bila laga ini salah dibuat (dobel atau salah tim).</p>${delBtn}`
      : `${m.status === "ft" ? addEventForm(m) : ""}<form data-form="score" data-id="${esc(id)}"><p class="hint">Skor otomatis dari gol yang dicatat. Pakai ini hanya bila skor laga perlu dipaksa. Koreksi tetap berlaku bila ada gol baru.</p>
      <div class="grid2"><div><label>Skor ${esc(sideName(m, "A"))}</label><input type="number" name="a" min="0" value="${m.scoreA ?? 0}"></div>
      <div><label>Skor ${esc(sideName(m, "B"))}</label><input type="number" name="b" min="0" value="${m.scoreB ?? 0}"></div></div>
      <div class="form-actions"><button class="btn ghost" type="submit">Simpan skor</button></div></form>
    ${delBtn}`;
  }
  return `<div class="panel tabcard"><h2 class="a">Kelola laga</h2>${tabsNav("matchMgmt", tabs, cur)}${body}</div>`;
}

/** Tombol kontrol sesuai fase: satu tombol utama yang berubah + jeda darurat. */
function liveControls(m, miss) {
  const id = esc(m.id), p = phaseOf(m), c = m.clock || {};
  const playing = isPlayPhase(p), ready = isReadyToStart(m);
  const stopped = playing && !c.running && !ready && !m.correcting;
  const tied = (m.scoreA ?? 0) === (m.scoreB ?? 0);
  const out = [];
  if (ready) out.push(`<button class="btn go big" data-act="resume" data-id="${id}">Mulai ${PHASE_NAME[p]}</button>`);
  if (stopped) out.push(`<button class="btn go big" data-act="resume" data-id="${id}">Lanjutkan jam</button>`);
  if (!ready) {
    for (const a of phaseActions(m)) {
      const off = a.act === "finish" && (miss.length || (isKnockout(m) && tied && !m.penWinner));
      out.push(`<button class="btn ${a.kind} big" data-act="${a.act}" data-id="${id}" ${off ? "disabled" : ""}>${a.label}</button>`);
    }
  }
  if (playing && c.running && !m.correcting) out.push(`<button class="btn ghost" data-act="pause" data-id="${id}">Jeda darurat</button>`);
  return out.join("");
}
function phaseNote(m) {
  const p = phaseOf(m);
  if (m.correcting) return "Laga dibuka untuk koreksi. Perbaiki kejadian atau pemenang penalti, lalu tekan Selesai (FT).";
  if (isReadyToStart(m)) return "Menunggu peluit. Jam mulai saat tombol Mulai ditekan.";
  if (p === "ht" || p === "etb") return `${PHASE_NAME[p]}: hitung mundur hanya pengingat. Tekan tombol Mulai saat peluit babak berikutnya.`;
  if (p === "pen") return "Adu penalti: pilih pemenang di bawah. Gol adu penalti tidak dicatat sebagai gol.";
  if (m.pause) return `Jam berhenti (${m.pause.label}) dan tampil di layar penonton. Tekan Lanjutkan jam saat laga bermain lagi.`;
  const tieKo = isKnockout(m) && (m.scoreA ?? 0) === (m.scoreB ?? 0) && (p === "h2");
  return "Jam berjalan otomatis dan menit kejadian terisi sendiri. Di akhir babak jam tidak berhenti paksa (tampil +1', +2'); tekan tombol Akhiri saat wasit meniup peluit." + (tieKo ? " Skor seri di babak gugur: pilih perpanjangan waktu atau langsung adu penalti." : "");
}

function matchAdminView(id) {
  const m = state.matchById[id];
  if (!m) return `<a class="back" href="#matches">← Daftar laga</a><div class="panel"><p class="empty">Laga tidak ditemukan.</p></div>`;
  const evs = state.events.filter((e) => e.matchId === id).sort((a, b) => eventCmp(b, a));
  const p = phaseOf(m);
  const miss = [...matchReadiness(m, state.players), ...(m.status === "scheduled" ? suspProblems(m) : [])];
  const sub = m.stage === "group" || !m.stage ? "Grup " + esc(m.group || "?") + ", matchday " + esc(m.matchday ?? 1) : STAGES[m.stage];
  const when = m.kickoff ? dayShort(m.kickoff) + ", " + timeStr(m.kickoff) : "Waktu akan ditentukan";

  // papan skor + tombol jam
  let ctrl = "";
  if (m.status === "scheduled") ctrl = `<button class="btn go big" data-act="start" data-id="${esc(id)}" ${miss.length ? "disabled" : ""}>Mulai laga</button>`;
  if (m.status === "live") ctrl = liveControls(m, miss);
  if (m.status === "ft") ctrl = `<button class="btn ghost big" data-act="reopen" data-id="${esc(id)}">Buka kembali untuk koreksi</button>`;

  const board = `<div class="board ${m.status === "live" ? "is-live" : ""}">
    <div class="b-meta"><span>${sub} · ${when}</span>${statusPill(m)}</div>
    <div class="b-row"><div class="b-team">${esc(sideName(m, "A"))}</div><div class="b-score">${m.scoreA ?? 0}<i>–</i>${m.scoreB ?? 0}</div><div class="b-team r">${esc(sideName(m, "B"))}</div></div>
    ${m.status === "live" ? `<div class="b-phase">${esc(PHASE_NAME[p] || "")}</div><div class="b-clock" data-clockbig="${esc(id)}">${clockText(m)}</div>` : ""}
    ${m.status === "ft" ? `<div class="b-phase">${ftText(m)}</div>` : ""}
    ${m.status === "live" && isPlayPhase(p) && !m.correcting ? `<div class="b-added"><span>Tambahan waktu (pengingat di layar)</span>
      <button type="button" class="btn ghost sm" data-act="added-dec" data-id="${esc(id)}" aria-label="Kurangi tambahan waktu">−</button><b>+${m.addedMin || 0}'</b>
      <button type="button" class="btn ghost sm" data-act="added-inc" data-id="${esc(id)}" aria-label="Tambah tambahan waktu">+</button></div>` : ""}
    <div class="b-ctrl">${ctrl}</div>
    ${m.status === "live" ? `<p class="b-note">${esc(phaseNote(m))}</p>` : ""}
  </div>`;

  // syarat mulai
  const readiness = m.status === "scheduled" ? `<div class="panel ${miss.length ? "warnbox" : "okbox"}"><h2 class="a">${miss.length ? "Belum bisa dimulai" : "Siap dimulai"}</h2>
      ${miss.length ? `<ul class="need">${miss.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="hint">Isi line up di bawah, lalu tombol Mulai laga aktif.</p>` : `<p class="hint">Kedua line up sudah lengkap. Tekan Mulai laga saat peluit pertama.</p>`}</div>`
    : (m.status === "live" && miss.length) ? `<div class="panel warnbox"><h2 class="a">Line up belum lengkap</h2><ul class="need">${miss.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="hint">Laga ini dimulai sebelum aturan line up. Lengkapi dulu di bawah agar bisa diakhiri.</p></div>` : "";

  // papan pemain (POS)
  let pos = "";
  if (m.status === "live") {
    const grid = (side) => {
      const ids = lineupIds(m, side), on = onCourtIds(m, side, state.events);
      const list = ids.map((x) => state.playerById[x]).filter(Boolean).sort((a, b) => {
        const sa = on.includes(a.id) ? 0 : 1, sb = on.includes(b.id) ? 0 : 1;
        return sa - sb || byNumber(a, b);
      });
      return `<section class="pcol ${ui.side === side ? "show" : ""}" data-side="${side}"><h3>${esc(sideName(m, side))}</h3><div class="pgrid">${list.map((p) => playerTile(m, side, p)).join("") || `<p class="hint">Line up kosong.</p>`}</div></section>`;
    };
    pos = `<div class="panel"><h2 class="a">Catat kejadian</h2><p class="hint">Ketuk pemain, pilih kejadian. Menit mengikuti jam laga.</p>
      <div class="seg" role="tablist"><button type="button" class="${ui.side === "A" ? "on" : ""}" data-act="side" data-side="A">${esc(sideName(m, "A"))}</button><button type="button" class="${ui.side === "B" ? "on" : ""}" data-act="side" data-side="B">${esc(sideName(m, "B"))}</button></div>
      <div class="pcols">${grid("A")}${grid("B")}</div></div>`;
  }

  const evList = evs.length ? evs.map((e, i) => {
    if (e.type === "phase") return `<div class="aev aev2 s-c note"><b>${eventMinute(e)}</b><span class="muted">${esc(e.note)}</span></div>`;
    const sd = eventSide(m, e);
    const body = `<div class="aev-body">${evIcon(e)}<span>${evLabel(e)} · ${esc(pName(e.playerId))}${e.assistId ? `<br><span class="muted small">Assist: ${esc(pName(e.assistId))}</span>` : ""}</span>${m.status === "live" || m.status === "ft" ? `${e.second ? "" : `<button class="btn sm ghost mini" data-act="edit-event" data-id="${esc(e.id)}">Ubah</button>`}${m.status === "live" ? `<button class="btn sm danger mini" data-act="del-event" data-id="${esc(e.id)}">Batalkan</button>` : ""}` : ""}</div>`;
    return `<div class="aev aev2 s-${sd} ${i === 0 && m.status === "live" ? "latest" : ""}"><div class="aev-l">${sd === "a" ? body : ""}</div><b>${eventMinute(e)}</b><div class="aev-r">${sd === "b" ? body : ""}</div></div>`;
  }).join("") : `<p class="hint">${m.status === "scheduled" ? "Kejadian muncul di sini setelah laga dimulai." : "Belum ada kejadian."}</p>`;

  const allPlayers = [...lineupIds(m, "A"), ...lineupIds(m, "B")].map((x) => state.playerById[x]).filter(Boolean);

  const woCard = m.status === "scheduled" && m.teamA && m.teamB
    ? `<details class="panel fold"><summary>Menang WO (tim lawan tidak hadir)</summary>
      <form data-form="wo" data-id="${esc(id)}"><p class="hint">Laga langsung selesai tanpa line up dan hasilnya masuk klasemen. Tidak ada gol/kartu yang tercatat, jadi tidak memengaruhi top scorer maupun statistik kiper. Skor WO ditentukan panitia (umumnya 3 – 0).</p>
      <div class="grid3"><div><label for="wo-w">Pemenang</label><select id="wo-w" name="winner"><option value="A">${esc(sideName(m, "A"))}</option><option value="B">${esc(sideName(m, "B"))}</option></select></div>
        <div><label for="wo-s">Skor pemenang</label><input id="wo-s" type="number" name="w" min="0" value="3"></div>
        <div><label for="wo-l">Skor tim absen</label><input id="wo-l" type="number" name="l" min="0" value="0"></div></div>
      <div class="form-actions"><button class="btn danger" type="submit">Tetapkan menang WO</button></div></form></details>` : "";
  return `<a class="back" href="#matches">← Daftar laga</a>${board}${readiness}${penForm(m)}${m.status === "live" ? courtPanel(m) : ""}${pos}
  <div class="panel"><h2 class="a">Riwayat kejadian <small class="muted">(kiri: ${esc(sideName(m, "A"))}, kanan: ${esc(sideName(m, "B"))})</small> <span class="cntb">${evs.filter((e) => e.type !== "phase").length}</span></h2>${evList}${m.status === "ft" ? unexplainedNote(m) : ""}${m.status === "ft" && evs.some((e) => e.type !== "phase") ? `<p class="hint">Ada yang salah catat? Tekan Ubah di kejadiannya (pemain, assist, kartu, atau menit). Tidak perlu membuka kembali laga.</p>` : ""}${m.status === "live" ? `<p class="hint">Salah pemain, assist, jenis kartu, atau menit? Tekan Ubah. Salah tim? Batalkan lalu catat ulang. Skor ikut menyesuaikan.</p>` : ""}</div>
  <details class="panel fold" ${m.status === "scheduled" || miss.length ? "open" : ""}><summary>Line up ${miss.length ? '<span class="flag warn">perlu diisi</span>' : '<span class="flag ok">lengkap</span>'}</summary>${lineupEditor(m)}</details>
  ${woCard}
  ${h2hPanel(m)}
  ${manageCard(m, allPlayers)}
  ${sheetView(m)}`;
}

// --- Impor dari Excel / CSV ---
function importBody() {
  const st = importState;
  let preview = "";
  if (st) {
    const p = st.plan;
    const list = (arr, cls) => arr.length ? `<ul class="imp-list ${cls}">${arr.slice(0, 25).map((x) => `<li>${esc(x)}</li>`).join("")}${arr.length > 25 ? `<li>…dan ${arr.length - 25} lainnya</li>` : ""}</ul>` : "";
    const rows = p.teams.map((t) => `<details class="imp-team"><summary><span class="nm">${esc(t.name)}</span><span class="chip">${t.existing ? "Diperbarui" : "Baru"}</span><span class="chip">Grup ${esc(t.group || t.existing?.group || "–")}</span><span class="cnt">${t.players.length} pemain · ${t.officials.length} official</span></summary>
      <div class="imp-body">${[...t.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999)).map((x) => `<div class="imp-pl"><b>${x.number ?? "?"}</b><span>${esc(x.name)}</span>${x.isGK ? '<span class="badge-gk">GK</span>' : ""}${x.isCaptain ? '<span class="badge-gk badge-cap">C</span>' : ""}</div>`).join("")}
      ${t.officials.map((x) => `<div class="imp-pl"><b>–</b><span>${esc(x.name)}</span><span class="chip">Official</span></div>`).join("")}</div></details>`).join("");
    preview = `<div class="imp-sum"><b>${esc(st.fileName)}</b>: ${p.totals.teams} tim, ${p.totals.players} pemain, ${p.totals.officials} official</div>
      ${p.errors.length ? `<div class="imp-box err"><b>${p.errors.length} masalah harus diperbaiki di file, lalu pilih ulang file:</b>${list(p.errors, "e")}</div>` : ""}
      ${p.warnings.length ? `<div class="imp-box warn"><b>Perhatian (tidak menghalangi impor):</b>${list(p.warnings, "w")}</div>` : ""}
      ${rows}
      <label class="check"><input type="checkbox" data-import-replace ${st.replace ? "checked" : ""}> Ganti total: hapus pemain/official lama di tim yang ada di file bila tidak tercantum di file</label>
      <div class="btns"><button class="btn orange" data-act="apply-import" ${p.errors.length || !p.teams.length ? "disabled" : ""}>Impor ${p.totals.teams} tim &amp; ${p.totals.players + p.totals.officials} orang</button>
      <button class="btn ghost" data-act="clear-import">Batal</button></div>`;
  }
  return `<p class="hint">Satu baris = satu orang. Kolom: <b>Tim, Grup, Peran, No, Nama</b>. Peran: <b>Pemain</b>, <b>Kiper</b>, atau <b>Official</b>. No punggung wajib untuk pemain dan kiper, 0–99, tidak boleh kembar dalam satu tim.
    Impor aman diulang: tim dicocokkan lewat nama, pemain lewat no punggung.</p>
    <p class="hint">Unduh contoh: <a href="../templates/template-tim-pemain.xlsx" download>Excel (.xlsx)</a> · <a href="../templates/template-tim-pemain.csv" download>CSV</a>.
    Jangan menaruh NIK atau nomor telepon di file; kolom di luar daftar di atas diabaikan dan tidak disimpan karena data website bersifat publik.</p>
    <label for="impfile">Pilih file .xlsx atau .csv</label>
    <input id="impfile" type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" data-import-file>
    ${preview}`;
}

// --- Tim & pemain ---
const playerRow = (p) => `<div class="player-line"><b>${p.number ?? ""}</b><span>${esc(p.name)} ${p.isGK ? '<span class="badge-gk">GK</span>' : ""}${p.isCaptain ? ' <span class="badge-gk badge-cap">C</span>' : ""}</span>
  <button class="btn sm ghost mini" data-act="edit-player" data-id="${esc(p.id)}">Ubah</button><button class="btn sm danger mini" data-act="del-player" data-id="${esc(p.id)}">Hapus</button></div>`;

// Daftar tim: kotak per grup, sama seperti halaman "Tim peserta" di website. Ketuk tim untuk membuka dan mengubahnya.
function teamsView() {
  const byGroup = {};
  for (const t of state.teams) (byGroup[t.group || ""] ||= []).push(t);
  const keys = Object.keys(byGroup).sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
  const head = `<h1 class="page">Tim peserta <span class="cntb">${state.teams.length}</span></h1>${state.teams.length ? `` : ""}`;
  if (!keys.length) return `${head}<div class="panel"><p class="empty">Belum ada tim. Tambahkan lewat menu <a class="lnk" href="#team-add">Tambah tim</a>.</p></div>`;
  let i = 0;
  return `${head}<div class="tgroups">${keys.map((g) => `<section class="tgroup"><h2 class="gtitle">${g ? "Grup " + esc(g) : "Tanpa grup"}</h2>
    ${byGroup[g].sort(byEntry).map((t) => `<a class="tcard" style="--i:${i++}" href="#team/${esc(t.id)}">${badge(t)}<span class="tc-t"><b>${esc(t.name)}</b><small>${playersOf(t.id).length} pemain</small></span></a>`).join("")}</section>`).join("")}</div>`;
}

// Susun grup: pilih tim untuk tiap posisi (1, 2, 3, ...) sesuai urutan keluar di undian.
// Nomor posisi disimpan sebagai urutan tim di grupnya, jadi klasemen awal sama persis dengan susunan ini.
function syncSlots(form) {
  const sel = [...form.querySelectorAll("select[data-g]")];
  const used = new Set(sel.map((s) => s.value).filter(Boolean));
  sel.forEach((s) => s.querySelectorAll("option").forEach((o) => { o.disabled = !!o.value && used.has(o.value) && s.value !== o.value; }));
}
function groupSetupView() {
  const head = `<h1 class="page">Susun grup</h1>`;
  if (!state.teams.length) return `${head}<div class="panel"><p class="empty">Belum ada tim. Tambahkan dulu lewat menu <a class="lnk" href="#team-add">Tambah tim</a>.</p></div>`;
  const teams = [...state.teams].sort((a, b) => a.name.localeCompare(b.name, "id"));
  const gs = [...new Set(["A", "B", "C", "D", ...state.teams.map((t) => t.group).filter(Boolean)])].sort();
  const per = Math.max(Math.ceil(state.teams.length / gs.length), 4);
  const cur = (g) => state.teams.filter((t) => t.group === g).sort(byEntry);
  const cards = gs.map((g) => {
    const c = cur(g), n = Math.max(per, c.length);
    return `<section class="tgroup"><h2 class="gtitle">Grup ${esc(g)}</h2>${Array.from({ length: n }, (_, i) => {
      const key = g + i, want = ui.gs && key in ui.gs ? ui.gs[key] : (c[i]?.id || "");
      return `<div class="slotrow"><b class="slotno">${i + 1}</b><select data-g="${esc(g)}" data-p="${i + 1}" data-k="${esc(key)}"><option value="">— kosong —</option>${teams.map((t) => `<option value="${esc(t.id)}"${want === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>`;
    }).join("")}</section>`;
  }).join("");
  return `${head}<p class="hint">Isi sesuai urutan keluar di undian: posisi 1 = tim yang keluar pertama untuk grup itu, posisi 2 = yang kedua, dan seterusnya. Urutan ini menjadi urutan awal klasemen sebelum ada pertandingan. Satu tim hanya bisa dipilih sekali.</p>
  <form data-form="group-setup"><div class="tgroups">${cards}</div><div class="form-actions"><button class="btn orange" type="submit">Simpan susunan grup</button></div></form>`;
}

// ---------- Statistik tim, profil, riwayat pertemuan, juara ----------
const sbx = (v, l) => `<div><b>${v}</b><span>${l}</span></div>`;
const rchip = (r) => (r ? `<span class="rchip r-${r.res}">${r.res}</span>` : "");
const cardIc = (n, c) => (n ? `<span class="pe"><i class="card ${c}"></i>${n}</span>` : "");
const TS_SORTS = [["group", "Grup"], ["gf", "Gol"], ["assists", "Assist"], ["yellow", "Kuning"], ["red", "Merah"]];
function teamStatsView() {
  const key = ui.tsSort || "group";
  const rows = state.teams.map((t) => ({ t, s: teamSummary(t.id, state) }));
  rows.sort((a, b) => (key === "group" ? (a.t.group || "~").localeCompare(b.t.group || "~") : (b.s[key] ?? 0) - (a.s[key] ?? 0)) || byEntry(a.t, b.t));
  const sum = (k) => rows.reduce((n, r) => n + r.s[k], 0);
  const head = `<h1 class="page">Statistik tim</h1>`;
  if (!rows.length) return `${head}<div class="panel"><p class="empty">Belum ada tim.</p></div>`;
  return `${head}<div class="panel"><div class="chiprow">${TS_SORTS.map(([k, l]) => `<button type="button" class="btn sm ${key === k ? "" : "ghost"}" data-act="ts-sort" data-key="${k}">${l}</button>`).join("")}</div>
    <div class="tscroll"><table class="stbl"><thead><tr><th class="l">Tim</th><th>Grup</th><th>Main</th><th>M</th><th>S</th><th>K</th><th>Gol</th><th>KB</th><th>Assist</th><th><i class="card y"></i></th><th><i class="card r"></i></th></tr></thead>
    <tbody>${rows.map(({ t, s: x }) => `<tr><td class="l"><a class="lnk" href="#team/${esc(t.id)}">${esc(t.name)}</a></td><td>${esc(t.group || "–")}</td><td>${x.played}</td><td>${x.w}</td><td>${x.d}</td><td>${x.l}</td><td><b>${x.gf}</b></td><td>${x.ga}</td><td>${x.assists}</td><td>${x.yellow}</td><td>${x.red}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td class="l">Total</td><td></td><td></td><td></td><td></td><td></td><td>${sum("gf")}</td><td></td><td>${sum("assists")}</td><td>${sum("yellow")}</td><td>${sum("red")}</td></tr></tfoot></table></div>
    <p class="hint">Gol = gol memasukkan dan KB = kebobolan, dihitung dari laga selesai. Kartu dihitung dari semua kejadian. Semua angka ikut ke file Excel (Pengaturan → Ekspor ke Excel).</p></div>`;
}
function histRows(list, mode) {
  return list.length ? list.map((h) => `<a class="hrow" href="#match/${esc(h.m.id)}"><span>${rchip(h.r)}</span>
      <span class="hv">${mode === "team" ? (h.m.teamA === h.teamId ? "" : "@ ") : "vs "}${esc(h.opp ? tName(h.opp) : "Belum ditentukan")}<small>${h.m.stage === "group" || !h.m.stage ? "Grup " + esc(h.m.group || "?") : STAGES[h.m.stage]}${h.m.kickoff ? " · " + dayShort(h.m.kickoff) : ""}</small>${h.extra || ""}</span>
      <b>${h.r ? `${h.r.my} – ${h.r.opp}${h.r.pen ? ` <small>(pen ${h.r.pen})</small>` : ""}` : h.m.status === "live" ? "LIVE" : timeStr(h.m.kickoff)}</b></a>`).join("") : `<p class="hint">Belum ada laga.</p>`;
}
function teamStatsPanel(t) {
  const s = teamSummary(t.id, state), prog = teamProgress(t.id, state.teams, state.matches, state.events);
  const played = (pid) => state.matches.filter((m) => m.status !== "scheduled" && (lineupIds(m, "A").includes(pid) || lineupIds(m, "B").includes(pid))).length;
  return `<div class="panel"><h2 class="a">Statistik tim <span class="chip">${esc(prog.label)}</span></h2>
    <div class="sgrid">${sbx(s.played, "Main")}${sbx(`${s.w}-${s.d}-${s.l}`, "M-S-K")}${sbx(s.gf, "Gol")}${sbx(s.ga, "Kebobolan")}${sbx(s.assists, "Assist")}${sbx(s.yellow, "Kuning")}${sbx(s.red, "Merah")}</div>
    ${s.roster.length ? `<div class="tscroll"><table class="stbl"><thead><tr><th>#</th><th class="l">Pemain</th><th>Main</th><th>Gol</th><th>Assist</th><th><i class="card y"></i></th><th><i class="card r"></i></th></tr></thead><tbody>${s.roster.map((p) => `<tr><td>${p.number ?? ""}</td><td class="l"><a class="lnk" href="#player/${esc(p.id)}">${esc(p.name)}</a>${p.isGK ? ' <span class="badge-gk">GK</span>' : ""}</td><td>${played(p.id)}</td><td>${p.goals}</td><td>${p.assists}</td><td>${p.yellow}</td><td>${p.red}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <h3 class="a" style="margin-top:14px">Riwayat laga</h3>${histRows(s.history.map((h) => ({ ...h, teamId: t.id })), "team")}</div>`;
}
function playerAdminView(id) {
  const d = playerProfile(id, state);
  if (!d || isOfficial(d.p)) return `<a class="back" href="#teams">← Daftar tim</a><div class="panel"><p class="empty">Pemain tidak ditemukan.</p></div>`;
  const { p, stat, rows, keeper } = d, t = state.teamById[p.teamId];
  const boxes = [sbx(d.played, "Main"), sbx(stat.goals, "Gol"), sbx(stat.assists, "Assist"), sbx(stat.yellow, "Kuning"), sbx(stat.red, "Merah")];
  if (stat.ownGoals) boxes.push(sbx(stat.ownGoals, "Gol bunuh diri"));
  if (keeper && keeper.played) boxes.push(sbx(keeper.cleanSheets, "Clean sheet"), sbx(keeper.conceded, "Kebobolan"));
  const hist = histRows([...rows].reverse().map((rw) => ({ m: rw.m, opp: rw.opp, r: rw.r, extra: `<span class="pes">${[
    rw.goals.length ? `<span class="pe">${ballSvg()}${rw.goals.map((e) => eventMinute(e)).join(", ")}${rw.goals.some((e) => e.pen) ? " (P)" : ""}</span>` : "",
    rw.og.length ? `<span class="pe">${ballSvg("og")}${rw.og.map((e) => eventMinute(e)).join(", ")} (OG)</span>` : "",
    rw.assists.length ? `<span class="pe">Assist ${rw.assists.length}</span>` : "", cardIc(rw.yellow.length, "y"), cardIc(rw.red.length, "r"),
  ].join("")}</span>` })), "player");
  return `<a class="back" href="${t ? "#team/" + esc(t.id) : "#teams"}">← ${esc(t?.name || "Daftar tim")}</a>
    <div class="team-hero"><span class="ph-no">${p.number ?? ""}</span><div><h1 class="page">${esc(p.name)}</h1><div class="meta"><span>${esc(t?.name || "")}</span>${p.isGK ? '<span class="badge-gk">GK</span>' : ""}${p.isCaptain ? '<span class="badge-gk badge-cap">C</span>' : ""}</div></div></div>
    <div class="panel"><div class="sgrid">${boxes.join("")}</div></div><div class="panel"><h2 class="a">Riwayat laga</h2>${hist}</div>`;
}
function h2hPanel(m) {
  const h = headToHead(m, state.matches);
  if (!h) return "";
  const A = esc(sideName(m, "A")), B = esc(sideName(m, "B"));
  return `<div class="panel"><h2 class="a">Riwayat pertemuan</h2>${h.list.length
    ? `<div class="sgrid">${sbx(h.w, A + " menang")}${sbx(h.d, "Seri")}${sbx(h.l, B + " menang")}</div><p class="hint">Total gol: ${A} ${h.gf} – ${h.ga} ${B}</p>${h.list.map((x) => `<a class="arow" href="#match/${esc(x.id)}"><div class="when">${x.kickoff ? dayShort(x.kickoff) : "–"}</div><div class="vs"><span>${esc(sideName(x, "A"))} <b>${x.scoreA ?? 0} – ${x.scoreB ?? 0}</b> ${esc(sideName(x, "B"))}</span><small>${x.stage === "group" || !x.stage ? "Grup " + esc(x.group || "?") : STAGES[x.stage]}</small></div></a>`).join("")}`
    : `<p class="hint">Belum ada pertemuan sebelumnya antara kedua tim di turnamen ini.</p>`}</div>`;
}
function champPanel() {
  const c = championInfo(state.matches);
  if (!c) return "";
  const row = (l, id) => (id ? `<div class="podr"><small>${l}</small><a class="lnk" href="#team/${esc(id)}">${esc(tName(id))}</a></div>` : "");
  return `<div class="panel okbox"><h2 class="a">Turnamen selesai</h2><div class="podium2">${row("Juara", c.champion)}${row("Runner-up", c.runnerUp)}</div>
    <p class="hint">Halaman juara dan arsip hasil sudah tampil di website (menu Info → Juara &amp; arsip).</p></div>`;
}

// Satu tim: info, logo, pemain, official.
function teamView(id) {
  const t = state.teamById[id];
  if (!t) return `<a class="back" href="#teams">← Daftar tim</a><div class="panel"><p class="empty">Tim tidak ditemukan. Mungkin sudah dihapus.</p></div>`;
  const roster = playersOf(t.id), offs = officialsOf(t.id);
  return `<a class="back" href="#teams">← Daftar tim</a>
    <div class="team-hero">${badge(t, "lg")}<div><h1 class="page">${esc(t.name)}</h1>
      <div class="meta"><span class="chip">${t.group ? "Grup " + esc(t.group) : "Tanpa grup"}</span><span>${roster.length} pemain · ${offs.length} official</span></div></div></div>
    ${teamStatsPanel(t)}
    <div class="panel"><h2 class="a">Info tim</h2>
      <form data-form="team" data-id="${esc(t.id)}" class="grid3" style="align-items:end"><div style="grid-column:span 2"><label>Nama tim</label><input type="text" name="name" value="${esc(t.name)}" required></div>
        <div><label>Grup</label><input type="text" name="group" value="${esc(t.group || "")}" maxlength="2"></div>
        <div style="grid-column:1 / -1"><button class="btn orange" type="submit">Simpan info tim</button></div></form></div>
    <div class="panel"><h2 class="a">Logo tim</h2>
      <div class="logo-edit">${badge(t, "lg")}
        <div><b>${logoOf(t) ? "Logo unggahan" : "Belum ada logo"}</b>
          <p class="hint" style="margin:4px 0 0">Unggah logo tim sendiri. Tanpa logo, tim tampil dengan lingkaran singkatan nama.</p></div></div>
      <div class="logo-up"><label>${logoOf(t) ? "Ganti logo" : "Unggah logo"}</label><input type="file" accept="image/*" data-logo="${esc(t.id)}">
        <p class="hint">PNG latar transparan atau SVG, sebaiknya 512 px ke atas supaya tajam di layar besar. Ruang kosong di sekitar logo dipangkas otomatis, dan logo lurus/memanjang tidak perlu dibuat persegi: kotaknya menyesuaikan bentuk logo.</p></div>
      ${logoOf(t) ? `<button class="btn sm danger mini" style="margin-top:12px" data-act="del-logo" data-id="${esc(t.id)}">Hapus logo (pakai singkatan)</button>` : ""}
    </div>
    <div class="panel"><h2 class="a">Pemain <span class="cntb">${roster.length}/${LIMITS.players}</span></h2>
      ${roster.map(playerRow).join("") || `<p class="hint">Belum ada pemain.</p>`}
      <form data-form="player" data-id="${esc(t.id)}" class="addform"><h3 class="a">Tambah pemain</h3><div class="grid3" style="align-items:end"><div><label>No.</label><input type="number" name="number" min="0" max="99"></div>
        <div style="grid-column:span 2"><label>Nama pemain</label><input type="text" name="name" required></div></div>
        <label class="check"><input type="checkbox" name="gk"> Kiper (GK)</label>
        <label class="check"><input type="checkbox" name="cap"> Kapten (C), satu per tim</label>
        <div class="form-actions"><button class="btn orange" type="submit">Tambah pemain</button></div></form>
      <details class="fold"><summary>Tempel banyak pemain</summary><form data-form="bulk-players" data-id="${esc(t.id)}">
        <p class="hint">Satu pemain per baris: <code>nomor, nama, gk, c</code> (kata <b>gk</b> untuk kiper, <b>c</b> untuk kapten; maksimal satu kapten).<br><code>1, Dedi, gk</code><br><code>7, Andi, c</code><br><code>9, Budi</code></p>
        <textarea name="text"></textarea><div class="form-actions"><button class="btn orange" type="submit">Tambahkan semua</button></div></form></details></div>
    <div class="panel"><h2 class="a">Official <span class="cntb">${offs.length}/${LIMITS.officials}</span></h2>
      ${offs.map((o) => `<div class="player-line"><b>–</b><span>${esc(o.name)}</span><span></span><button class="btn sm danger mini" data-act="del-player" data-id="${esc(o.id)}">Hapus</button></div>`).join("") || `<p class="hint">Belum ada official.</p>`}
      ${offs.length < LIMITS.officials ? `<form data-form="official" data-id="${esc(t.id)}" class="addform"><h3 class="a">Tambah official</h3>
        <label>Nama official</label><input type="text" name="name" required maxlength="60" placeholder="mis. Budi Santoso">
        <div class="form-actions"><button class="btn orange" type="submit">Tambah official</button></div></form>` : `<p class="hint">Jumlah official sudah maksimal (${LIMITS.officials}). Hapus salah satu untuk menambah yang baru.</p>`}</div>
    <div class="panel dz"><h2 class="a">Hapus tim</h2><p class="hint">Tim beserta semua pemainnya dihapus dan tidak bisa dikembalikan.</p>
      <div class="btns"><button class="btn danger" data-act="del-team" data-id="${esc(t.id)}">Hapus tim ini</button></div></div>`;
}

function addTeamCard() {
  const tab = ui.tabs.addTeam || (state.teams.length ? "manual" : "impor");
  let body;
  if (tab === "impor") body = importBody();
  else if (tab === "tempel") body = `<form data-form="bulk-teams">
      <p class="hint">Satu tim per baris: <code>nama tim | grup</code><br><code>Tim A1 | A</code><br><code>Tim A2 | A</code></p>
      <textarea name="text"></textarea><div class="form-actions"><button class="btn orange" type="submit">Tambahkan semua</button></div></form>`;
  else body = `<form data-form="new-team" class="grid3" style="align-items:end"><div style="grid-column:span 2"><label>Nama tim</label><input type="text" name="name" required></div>
        <div><label>Grup</label><input type="text" name="group" maxlength="2" placeholder="A"></div>
        <div style="grid-column:span 3"><button class="btn orange" type="submit">Tambah tim</button></div></form>`;
  return `<div class="panel tabcard">${tabsNav("addTeam", [["impor", "Impor Excel / CSV"], ["tempel", "Tempel"], ["manual", "Manual"]], tab)}${body}</div>`;
}
function teamAddView() {
  return `<h1 class="page">Tambah tim</h1>${addTeamCard()}`;
}

// --- Pengaturan: satu halaman per topik ---
function announceView() {
  const a = state.settings.announcement || {};
  return `<h1 class="page">Pengumuman beranda</h1>
    <div class="panel"><form data-form="announce">
      <label class="check"><input type="checkbox" name="active" ${a.active ? "checked" : ""}> Tampilkan pengumuman di beranda</label>
      <label>Judul</label><input type="text" name="title" value="${esc(a.title || "")}">
      <label>Isi</label><textarea name="body" style="font-family:inherit;font-size:15px;min-height:110px">${esc(a.body || "")}</textarea>
      <div class="form-actions"><button class="btn orange" type="submit">Simpan pengumuman</button></div></form></div>`;
}
function timingView() {
  const t = timingOf(state.settings), g1 = t.groupHalves === 1;
  const num = (name, label, v, lo, hi) => `<div><label for="tm-${name}">${label}</label><input id="tm-${name}" type="number" name="${name}" min="${lo}" max="${hi}" step="1" value="${v}" inputmode="numeric"></div>`;
  return `<h1 class="page">Durasi pertandingan</h1><div class="panel"><form data-form="timing">
    <p class="hint" style="margin-top:0">Jam hitung maju dan mulai dari 0 di tiap babak. Nilai ini dibekukan saat laga dimulai, jadi mengubahnya tidak mengganggu laga yang sedang berjalan.</p>
    <div class="grid2"><div><label for="tm-groupHalves">Babak grup dimainkan</label><select id="tm-groupHalves" name="groupHalves"><option value="2" ${g1 ? "" : "selected"}>2 babak + istirahat</option><option value="1" ${g1 ? "selected" : ""}>1 babak non-stop</option></select></div>
      ${num("groupHalf", "Grup: menit per babak", t.groupHalf, 1, 45)}</div>
    <p class="hint">Bila 1 babak non-stop, isi durasi totalnya (mis. 20). Contoh bawaan: 2 × 10 menit.</p>
    <div class="grid2">${num("koHalf", "Babak gugur (QF dan SF): menit per babak", t.koHalf, 1, 45)}<div><label for="tm-finalHalf">Final: menit per babak</label><input id="tm-finalHalf" type="number" name="finalHalf" min="1" max="45" step="1" value="${t.finalHalf || ""}" placeholder="sama dengan babak gugur" inputmode="numeric"></div></div>
    <p class="hint">Kosongkan durasi Final bila sama dengan QF dan SF. Isi mis. 20 bila Final dimainkan 2 × 20 menit.</p>
    <div class="grid2">${num("etHalf", "Perpanjangan waktu: menit per babak", t.etHalf, 1, 15)}<div></div></div>
    <div class="grid2">${num("breakMin", "Istirahat antar babak (menit)", t.breakMin, 0, 20)}${num("etBreakMin", "Istirahat ET1 ke ET2 (menit)", t.etBreakMin, 0, 10)}</div>
    <p class="hint">Aturan futsal (FIFA): 2 × 20 menit, istirahat maksimal 15 menit, perpanjangan 2 × 5 menit, lalu adu penalti. Durasi di sini mengikuti keputusan panitia.</p>
    <div class="form-actions"><button class="btn orange" type="submit">Simpan durasi</button></div></form></div>`;
}
// Kiper terbaik: kartu urut dari nilai terbaik. Ketuk kartu = panitia memilih kiper itu.
function keeperView() {
  const s = state.settings;
  const stats = computeKeeperStats(state.players, state.matches, state.teams, state.events);
  const seen = new Set(stats.map((k) => k.id));
  const idle = state.players.filter((p) => p.isGK && !isOfficial(p) && !seen.has(p.id))
    .sort((a, b) => tName(a.teamId).localeCompare(tName(b.teamId), "id") || byNumber(a, b))
    .map((p) => ({ ...p, played: 0, cleanSheets: 0, conceded: 0, avg: 0, goals: 0, assists: 0, progress: teamProgress(p.teamId, state.teams, state.matches, state.events) }));
  const list = [...stats, ...idle];
  const best = s.bestGkId ? state.playerById[s.bestGkId] : null;
  const head = `<h1 class="page">Kiper terbaik</h1>`;
  if (!list.length) return `${head}<div class="panel"><p class="empty">Belum ada kiper. Tandai pemain sebagai kiper (GK) di menu Tim &amp; Pemain.</p></div>`;
  const cards = list.map((k, i) => {
    const sel = s.bestGkId === k.id, played = k.played > 0;
    return `<button type="button" class="kcard ${sel ? "is-sel" : ""}" style="--i:${i}" data-act="pick-gk" data-id="${esc(k.id)}" aria-pressed="${sel}">
      ${played ? `<span class="kc-rank">#${i + 1}</span>` : ""}
      <span class="kc-top">${badge(state.teamById[k.teamId])}<span class="kc-name"><b>${esc(k.name)}</b><small>${esc(tName(k.teamId))}</small></span></span>
      <span class="kc-stats"><span><b>${k.played}</b><small>Main</small></span><span><b>${k.cleanSheets}</b><small>Clean sheet</small></span><span><b>${k.conceded}</b><small>Kebobolan</small></span>
        <span><b>${played ? k.avg.toFixed(1) : "–"}</b><small>Rata²</small></span><span><b>${k.goals}</b><small>Gol</small></span><span><b>${k.assists}</b><small>Assist</small></span></span>
      <span class="kc-prog ${k.progress.out ? "badc" : ""}">${esc(k.progress.label)}</span>
      ${sel ? `<span class="kc-flag">Kiper terbaik</span>` : ""}</button>`;
  }).join("");
  return `${head}
    <p class="lead">Dipilih oleh panitia, tidak otomatis. Ketuk kartu untuk menjadikan kiper itu <b>Kiper terbaik</b>, ketuk lagi untuk membatalkan. Urutan dari nilai terbaik: clean sheet terbanyak, lalu rata-rata kebobolan paling kecil.</p>
    <div class="pick-now ${best ? "has" : ""}">${best ? `Terpilih: <b>${esc(best.name)}</b> · ${esc(tName(best.teamId))}` : "Belum ada kiper terbaik yang dipilih."}</div>
    <div class="kgrid">${cards}</div>
    <p class="hint">Clean sheet = lawan 0 gol (termasuk perpanjangan waktu). Dihitung dari kiper di susunan inti laga yang sudah FT; gol adu penalti tidak dihitung.</p>`;
}

// Hapus data: bersihkan semua pertandingan atau semua tim sekaligus
function exportView() {
  return `<h1 class="page">Ekspor ke Excel</h1><div class="panel"><h2 class="a">Unduh data turnamen</h2>
    <p class="hint">Satu file .xlsx berisi delapan lembar: Klasemen, Jadwal &amp; hasil, Kejadian (gol dan kartu), Top scorer, Kartu &amp; skorsing, Kiper, Statistik tim, dan Statistik pemain. Data diambil dari kondisi terbaru di layar ini, jadi cocok untuk arsip harian atau laporan ke panitia.</p>
    <div class="btns"><button class="btn orange big" data-act="export-xlsx">Unduh Excel</button></div></div>`;
}
function exportSheets() {
  const ev = state.events, ms = [...state.matches].sort(sortByKickoff);
  const std = computeStandings(state.teams, state.matches, ev);
  const cardsOf = (t, type) => ev.filter((e) => e.teamId === t && e.type === type).length;
  const stage = (m) => (m.stage === "group" || !m.stage ? "Grup " + (m.group || "?") + ", matchday " + (m.matchday ?? 1) : STAGES[m.stage]);
  const mname = (m) => `${sideName(m, "A")} vs ${sideName(m, "B")}`;
  const statusTxt = { scheduled: "Terjadwal", live: "LIVE", ft: "Selesai" };
  const klasemen = [["Grup", "Posisi", "Tim", "Main", "Menang", "Seri", "Kalah", "Gol memasukkan", "Gol kemasukan", "Selisih", "Poin", "Kuning", "Merah"]];
  Object.keys(std).sort().forEach((g) => std[g].forEach((r, i) => klasemen.push([g, i + 1, r.name, r.p, r.w, r.d, r.l, r.gf, r.ga, r.gf - r.ga, r.pts, cardsOf(r.teamId, "yellow"), cardsOf(r.teamId, "red")])));
  const jadwal = [["Tanggal", "Jam (WIB)", "Fase", "Tim A", "Skor A", "Skor B", "Tim B", "Status", "Catatan"]];
  ms.forEach((m) => jadwal.push([m.kickoff ? dayShort(m.kickoff) : "", m.kickoff ? timeStr(m.kickoff) : "TBD", stage(m), sideName(m, "A"), m.status === "scheduled" ? "" : m.scoreA ?? 0, m.status === "scheduled" ? "" : m.scoreB ?? 0, sideName(m, "B"), statusTxt[m.status] || m.status, m.wo ? "Menang WO" : (shootout(m).any && (m.scoreA ?? 0) === (m.scoreB ?? 0) ? "Adu penalti" : "")]));
  const label = { goal: "Gol", own_goal: "Gol bunuh diri", yellow: "Kartu kuning", red: "Kartu merah" };
  const kejadian = [["Laga", "Menit", "Tim", "Pemain", "Kejadian", "Assist"]];
  ms.forEach((m) => ev.filter((e) => e.matchId === m.id && label[e.type]).sort(eventCmp).forEach((e) => kejadian.push([mname(m), eventMinute(e), tName(e.teamId), pName(e.playerId), e.type === "goal" && e.pen ? "Gol penalti" : label[e.type], e.assistId ? pName(e.assistId) : ""])));
  const stats = computePlayerStats(state.players, ev, state.teams, state.matches);
  const scorer = [["Peringkat", "Pemain", "Tim", "Gol", "Assist"]];
  topBy(stats, "goals", 200).forEach((p, i) => scorer.push([i + 1, p.name, tName(p.teamId), p.goals, p.assists]));
  const kartu = [["Pemain", "Tim", "Kuning", "Merah", "Skorsing di laga berikutnya"]];
  const nextOf = (t) => state.matches.filter((x) => x.status === "scheduled" && (x.teamA === t || x.teamB === t)).sort(sortByKickoff)[0];
  stats.filter((p) => p.yellow || p.red).sort((a, b) => b.red - a.red || b.yellow - a.yellow).forEach((p) => {
    const nx = nextOf(p.teamId), o = nx ? suspendedIn(nx, p.teamId, state.matches, ev, state.players, suspOv()).get(p.id) : null;
    kartu.push([p.name, tName(p.teamId), p.yellow, p.red, o ? suspReason(o) : ""]);
  });
  const kiper = [["Kiper", "Tim", "Main", "Clean sheet", "Kebobolan", "Rata-rata kebobolan"]];
  computeKeeperStats(state.players, state.matches, state.teams, ev).forEach((g) => kiper.push([g.name, tName(g.teamId), g.played, g.cleanSheets, g.conceded, Number(g.avg.toFixed(2))]));
  const tstat = [["Tim", "Grup", "Main", "Menang", "Seri", "Kalah", "Gol memasukkan", "Gol kemasukan", "Assist", "Kuning", "Merah"]];
  [...state.teams].sort((a, b) => (a.group || "").localeCompare(b.group || "") || byEntry(a, b)).forEach((t) => { const x = teamSummary(t.id, state); tstat.push([t.name, t.group || "", x.played, x.w, x.d, x.l, x.gf, x.ga, x.assists, x.yellow, x.red]); });
  const pstat = [["Pemain", "Tim", "No", "Gol", "Assist", "Kuning", "Merah"]];
  stats.filter((p) => p.role !== "official").sort((a, b) => tName(a.teamId).localeCompare(tName(b.teamId), "id") || (a.number ?? 999) - (b.number ?? 999)).forEach((p) => pstat.push([p.name, tName(p.teamId), p.number ?? "", p.goals, p.assists, p.yellow, p.red]));
  return [{ name: "Klasemen", rows: klasemen }, { name: "Jadwal & hasil", rows: jadwal }, { name: "Kejadian", rows: kejadian }, { name: "Top scorer", rows: scorer }, { name: "Kartu & skorsing", rows: kartu }, { name: "Kiper", rows: kiper }, { name: "Statistik tim", rows: tstat }, { name: "Statistik pemain", rows: pstat }];
}
// ---------- Backup & unduh semua data ----------
// Backup = salinan mentah semua koleksi Firestore (tim, pemain, pertandingan, kejadian/gol/kartu, pengaturan) dalam satu file JSON.
// Dibaca dari data yang sudah tersinkron di layar, jadi tidak menambah jumlah baca Firestore.
const BK_KEY = "ifl-last-backup";
let backupState = null; // { fileName, data, replace }
const stamp2 = () => { const d = new Date(), z = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };
const bkSer = (v) => {
  if (v && typeof v === "object") {
    if (typeof v.toMillis === "function" && "seconds" in v) return { __ts: v.toMillis() };
    return Array.isArray(v) ? v.map(bkSer) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bkSer(x)]));
  }
  return v === undefined ? null : v;
};
const bkDe = (v) => {
  if (v && typeof v === "object") {
    if (!Array.isArray(v) && Object.keys(v).length === 1 && typeof v.__ts === "number") return Timestamp.fromMillis(v.__ts);
    return Array.isArray(v) ? v.map(bkDe) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bkDe(x)]));
  }
  return v;
};
function backupData() {
  const col = (list) => list.map((x) => bkSer(x));
  return {
    app: "ifl-website", version: 1, exportedAt: new Date().toISOString(),
    counts: { teams: state.teams.length, players: state.players.length, matches: state.matches.length, events: state.events.length },
    settings: bkSer(state.settings || {}),
    teams: col(state.teams), players: col(state.players), matches: col(state.matches), events: col(state.events),
  };
}
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
function markBackup() { try { localStorage.setItem(BK_KEY, new Date().toISOString()); } catch (e) { /* abaikan */ } }
function lastBackupText() {
  let t = null;
  try { t = localStorage.getItem(BK_KEY); } catch (e) { /* abaikan */ }
  if (!t) return "Belum pernah backup dari browser ini.";
  const d = new Date(t);
  return `Backup terakhir dari browser ini: ${d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })}, ${d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}.`;
}
// CSV mentah: satu baris per dokumen, semua kolom. Logo (gambar base64) dilewati karena ada di file JSON.
function rawCsv(list, skip = ["logoUrl"]) {
  const keys = ["id"];
  list.forEach((x) => Object.keys(x).forEach((k) => { if (!keys.includes(k) && !skip.includes(k)) keys.push(k); }));
  return toCsv([keys, ...list.map((x) => keys.map((k) => { const v = bkSer(x[k]); return v && typeof v === "object" ? JSON.stringify(v) : v; }))]);
}
const safeName = (n) => String(n).replace(/[\\/:*?"<>|&]+/g, "-").replace(/\s+/g, " ").trim();
function backupView() {
  const n = { t: state.teams.length, p: state.players.length, m: state.matches.length, e: state.events.length };
  const goals = state.events.filter((e) => e.type === "goal" || e.type === "own_goal").length;
  const bs = backupState;
  let restore;
  if (bs) {
    const c = bs.data.counts || {};
    restore = `<div class="panel okbox"><h2 class="a">Siap dipulihkan: ${esc(bs.fileName)}</h2>
      <p class="hint">Dibuat ${bs.data.exportedAt ? esc(new Date(bs.data.exportedAt).toLocaleString("id-ID")) : "(waktu tidak tercatat)"}. Isi: <b>${c.teams ?? bs.data.teams.length}</b> tim, <b>${c.players ?? bs.data.players.length}</b> pemain, <b>${c.matches ?? bs.data.matches.length}</b> pertandingan, <b>${c.events ?? bs.data.events.length}</b> kejadian.</p>
      <label class="check"><input type="checkbox" data-restore-replace ${bs.replace ? "checked" : ""}> Ganti total: hapus data yang sekarang ada tapi tidak ada di file backup</label>
      <p class="hint">${bs.replace ? "Data sekarang yang tidak ada di backup akan <b>dihapus</b>, sehingga hasilnya sama persis dengan isi file." : "Data di file backup akan menimpa data dengan ID yang sama. Data lain yang sudah ada dibiarkan."} Sebelum memulihkan, backup kondisi sekarang otomatis diunduh dulu sebagai pengaman.</p>
      <div class="btns"><button class="btn danger" data-act="restore-run">Pulihkan data</button><button class="btn ghost" data-act="restore-clear">Batal</button></div></div>`;
  } else {
    restore = `<div class="panel dz"><h2 class="a">Pulihkan dari file backup</h2>
      <p class="hint">Pilih file <code>.json</code> hasil backup di atas. Kamu masih bisa memeriksa isinya dulu sebelum benar-benar dipulihkan.</p>
      <input id="restorefile" type="file" accept=".json,application/json" data-restore-file></div>`;
  }
  return `<h1 class="page">Backup &amp; unduh data</h1>
    <p class="lead">Simpan salinan seluruh data turnamen: tim, pemain, jadwal, skor, gol, assist, kartu, dan pengaturan. Sekarang ada <b>${n.t}</b> tim, <b>${n.p}</b> pemain, <b>${n.m}</b> pertandingan, <b>${n.e}</b> kejadian (<b>${goals}</b> gol).</p>
    <div class="panel"><h2 class="a">Backup lengkap (JSON)</h2>
      <p class="hint">Satu file berisi semua data mentah, termasuk logo tim. Inilah file yang dipakai untuk memulihkan database. ${esc(lastBackupText())}</p>
      <div class="btns"><button class="btn orange big" data-act="backup-json">Unduh backup (.json)</button></div></div>
    <div class="panel"><h2 class="a">Unduh semua data (ZIP)</h2>
      <p class="hint">Satu file ZIP berisi: file backup JSON, laporan Excel (klasemen, jadwal &amp; hasil, gol dan kartu, top scorer, kiper, statistik), CSV untuk tiap lembar laporan, dan CSV data mentah (tim, pemain, pertandingan, kejadian). Cocok untuk arsip akhir turnamen atau dibuka di Excel / Google Sheets.</p>
      <div class="btns"><button class="btn orange big" data-act="backup-zip">Unduh semua (.zip)</button></div></div>
    ${restore}
    <p class="hint">Saran: unduh backup setiap selesai hari pertandingan dan simpan di dua tempat (misalnya HP dan Google Drive). Bila database bermasalah, pindah layanan, atau data terhapus tidak sengaja, file ini yang menyelamatkan.</p>`;
}
function resetView() {
  const nM = state.matches.length, nE = state.events.length, nT = state.teams.length, nP = state.players.length;
  return `<h1 class="page">Hapus data</h1>
    <p class="lead">Dipakai untuk mengosongkan data contoh atau mengulang dari awal. Yang sudah dihapus tidak bisa dikembalikan.</p>
    <div class="panel dz"><h2 class="a">Hapus semua pertandingan</h2>
      <p class="hint">${nM ? `Akan menghapus <b>${nM}</b> pertandingan beserta <b>${nE}</b> kejadian (gol, kartu, dan lainnya). Tim dan pemain tidak ikut terhapus.` : "Belum ada pertandingan."}</p>
      <div class="btns"><button class="btn danger" data-act="wipe-matches" ${nM ? "" : "disabled"}>Hapus semua pertandingan</button></div></div>
    <div class="panel dz"><h2 class="a">Hapus semua tim</h2>
      <p class="hint">${nT ? `Akan menghapus <b>${nT}</b> tim beserta <b>${nP}</b> pemain dan official, termasuk pilihan kiper terbaik.${nM ? ` Masih ada <b>${nM}</b> pertandingan yang memakai tim, jadi hapus semua pertandingan dulu.` : ""}` : "Belum ada tim."}</p>
      <div class="btns"><button class="btn danger" data-act="wipe-teams" ${nT ? "" : "disabled"}>Hapus semua tim</button></div></div>`;
}

// ---------- Render ----------
let pending = false;
let lastBar = "", lastKey = "", enterTimer;
// Skeleton shimmer: saat data belum siap dan sekilas tiap pindah halaman
const SKEL_KIND = { matches: "list", "match-add": "form", teams: "grid", "team-stats": "list", player: "list", team: "form", "team-add": "form", "group-setup": "grid", settings: "form", "set-announce": "form", "set-timing": "form", "set-keeper": "cards", "set-reset": "form", "set-backup": "form", match: "pos" };
let skelOn = false, skelTimer;
function startSkeleton() { skelOn = true; clearTimeout(skelTimer); skelTimer = setTimeout(() => { skelOn = false; render(); }, 350); }
function showSkel(r) {
  const kind = SKEL_KIND[r.name] || "list", k = kind + "|" + r.name;
  if ($app.dataset.skel === k) return;
  $app.dataset.skel = k;
  $app.innerHTML = (r.name === "match" || r.name === "team" ? "" : subNav()) + skeleton(kind);
}
// Menu samping hanya digambar ulang bila isinya berubah, supaya animasinya tidak terulang tiap data masuk.
function setBar(h) { if (h !== lastBar) { $bar.innerHTML = h; lastBar = h; } }
function render() {
  document.body.classList.toggle("has-side", !!user);
  if (user === undefined) { setBar(""); showSkel({ name: "matches" }); return; }
  if (!user) { setBar(""); delete $app.dataset.skel; $app.innerHTML = loginView(); return; }
  setBar(topBar());
  if (isReady()) {
    const b = computeBracket(state.teams, state.matches, state.events);
    slotByMatch = new Map([...b.qf, ...b.sf, b.final].filter((x) => x.match).map((x) => [x.match.id, x]));
  }
  const r = route();
  if (!isReady()) {
    if (state.error) { delete $app.dataset.skel; $app.innerHTML = `<div class="error-box">Data gagal dimuat: ${esc(state.error.code || state.error.message)}</div>`; }
    else showSkel(r);
    return;
  }
  if (skelOn) { showSkel(r); return; }
  delete $app.dataset.skel;
  const open = [...$app.querySelectorAll("details[open]")].map((d) => d.querySelector("summary")?.textContent);
  let h;
  if (r.name === "match") h = matchAdminView(r.id);
  else if (r.name === "match-add") h = matchAddView();
  else if (r.name === "team") h = teamView(r.id);
  else if (r.name === "team-add") h = teamAddView();
  else if (r.name === "group-setup") h = groupSetupView();
  else if (r.name === "teams") h = teamsView();
  else if (r.name === "team-stats") h = teamStatsView();
  else if (r.name === "player") h = playerAdminView(r.id);
  else if (r.name === "set-timing") h = timingView();
  else if (r.name === "set-keeper") h = keeperView();
  else if (r.name === "set-backup") h = backupView();
  else if (r.name === "set-export") h = exportView();
  else if (r.name === "set-reset") h = resetView();
  else if (r.name === "set-announce" || r.name === "settings") h = announceView();
  else if (r.name === "matches") h = matchesView();
  else h = dashboardView();
  $app.innerHTML = subNav() + h;
  { const gf = $app.querySelector('form[data-form="group-setup"]'); if (gf) syncSlots(gf); }
  // tombol cabang di HP: tampilkan yang aktif di tengah
  const sn = $app.querySelector(".subnav"), on = sn?.querySelector("a.on");
  if (sn && on) sn.scrollLeft = on.offsetLeft - (sn.clientWidth - on.offsetWidth) / 2;
  // animasi masuk hanya saat pindah halaman
  const key = r.name + "/" + (r.id || "");
  if (key !== lastKey) {
    lastKey = key;
    $app.classList.remove("enter"); void $app.offsetWidth; $app.classList.add("enter");
    clearTimeout(enterTimer); enterTimer = setTimeout(() => $app.classList.remove("enter"), 1200);
  }
  // pertahankan lipatan yang sedang terbuka
  $app.querySelectorAll("details").forEach((d) => { if (open.includes(d.querySelector("summary")?.textContent)) d.open = true; });
  pending = false;
}
tickRtClocks();
function safeRender() {
  const a = document.activeElement;
  if (a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox") { pending = true; return; }
  render();
}
setInterval(() => {
  if (!pending) return;
  const a = document.activeElement;
  if (a && $app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  render();
}, 2000);

// ---------- Aksi ----------
const curMatch = () => state.matchById[route().id];

/** Catat satu kejadian dan hitung ulang skor dari seluruh kejadian (bukan increment), supaya skor tidak bisa menyimpang. */
async function recordEvent(m, side, playerId, type, assistId, opts = {}) {
  if (m.status !== "live") throw new Error("Laga tidak sedang LIVE.");
  const teamId = side === "A" ? m.teamA : m.teamB;
  if (!teamId) throw new Error("Tim belum ditentukan untuk laga ini.");
  if (!lineupIds(m, side).includes(playerId)) throw new Error("Pemain ini tidak ada di line up.");
  if (assistId && (assistId === playerId || !lineupIds(m, side).includes(assistId))) throw new Error("Assist tidak valid.");
  const ph = phaseOf(m), isGoal = type === "goal" || type === "own_goal";
  if (ph === "pen") throw new Error("Sedang adu penalti: gol dan kartu tidak dicatat di sini. Pilih pemenang penalti, lalu Selesai (FT).");
  if ((ph === "ht" || ph === "etb") && isGoal) throw new Error("Sedang istirahat: gol tidak bisa dicatat. Mulai babak berikutnya dulu.");
  // Aturan futsal: kuning kedua = merah; pemain yang sudah merah tidak bisa dikartu lagi
  const mine = state.events.filter((e) => e.matchId === m.id && e.playerId === playerId);
  let secondYellow = false;
  if (type === "yellow" || type === "red") {
    if (mine.some((e) => e.type === "red")) throw new Error(`${pName(playerId)} sudah dikeluarkan (kartu merah). Batalkan kartu merahnya dulu bila salah catat.`);
    if (type === "yellow" && mine.some((e) => e.type === "yellow")) {
      if (!(await confirmBox(`${pName(playerId)} sudah punya satu kartu kuning. Kartu kuning kedua otomatis menjadi kartu merah (pemain dikeluarkan).`, { title: "Kartu kuning kedua", ok: "Ya, catat kuning + merah" }))) return;
      secondYellow = true;
    }
  }
  const st = stampNow(m);
  const ref = doc(collection(db, "events"));
  const ev = { matchId: m.id, type, teamId, playerId, assistId: type === "goal" && assistId ? assistId : null, minute: st.minute, extra: st.extra, sec: st.sec, p: st.p, ps: st.ps, pm: st.pm, ts: nowMs() };
  if (type === "goal" && opts.pen) ev.pen = true;
  if (isGoal) { const conc = type === "goal" ? (side === "A" ? "B" : "A") : side; if (m["gk" + conc] !== undefined) ev.gkId = m["gk" + conc] ?? null; } // kiper yang kebobolan
  const [a, b] = finalScore(m, [...state.events.filter((e) => e.matchId === m.id), { ...ev, id: ref.id }]);
  const patch = { scoreA: a, scoreB: b };
  if (a !== b && (m.penWinner || m.penKicks?.length)) { patch.penWinner = null; patch.penKicks = []; }
  const batch = writeBatch(db);
  batch.set(ref, ev);
  if (secondYellow) batch.set(doc(collection(db, "events")), { ...ev, type: "red", second: true, ts: nowMs() + 1 });
  if (isGoal) batch.update(matchRef(m.id), patch);
  await batch.commit();
  toast(`${secondYellow ? "Kuning kedua + merah" : typeLabel[opts.pen ? "penalty" : type]} · ${pName(playerId)} ${eventMinute(ev)}`);
}

// ---------- Fase laga ----------
const runClock = (base = 0) => ({ running: true, baseSec: base, startedAt: nowMs() });
const stopClock = (base = 0) => ({ running: false, baseSec: base, startedAt: null });
const limitText = (m, ph) => { const s = periodLimitSec(m, ph); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
/** Catatan fase yang tampil di jalannya laga (bukan gol/kartu, jadi tidak memengaruhi skor atau statistik). */
const mkNote = (m, note, st) => ({ matchId: m.id, type: "phase", teamId: null, playerId: null, assistId: null, note, minute: st.minute, extra: st.extra, sec: st.sec, p: st.p, ps: st.ps, pm: st.pm, ts: nowMs() });
/** Pindah fase: jam fase baru dimulai dari 0, jeda dan tambahan waktu direset, catatan fase ikut tersimpan. */
async function goPhase(m, phase, { notes = [], clock, extra = {} }) {
  const b = writeBatch(db);
  notes.forEach((n) => b.set(doc(collection(db, "events")), n));
  b.update(matchRef(m.id), { phase, clock, pause: null, addedMin: 0, ...extra });
  await b.commit();
}
async function confirmEarly(m, what) {
  const ph = phaseOf(m);
  if (!isPlayPhase(ph) || elapsedSec(m) >= periodLimitSec(m, ph)) return true;
  return confirmBox(`${what[0].toUpperCase() + what.slice(1)} baru berjalan ${clockText(m)} dari ${limitText(m, ph)}. Akhiri sekarang?`, { title: "Waktu belum habis", ok: "Ya, akhiri" });
}
async function setAdded(id, d) {
  const m = state.matchById[id];
  await updateDoc(matchRef(id), { addedMin: Math.max(0, Math.min(10, (m.addedMin || 0) + d)) });
}

const actions = {
  async logout() { await signOut(auth); },
  async start(id) {
    const m = state.matchById[id];
    const miss = [...matchReadiness(m, state.players), ...suspProblems(m)];
    if (miss.length) throw new Error("Belum bisa mulai: " + miss.join("; ") + ".");
    const warn = warnProblems(m);
    if (warn.length && !(await confirmBox(`Pemain berikut kena akumulasi kartu kuning dan ada di line up:\n• ${warn.join("\n• ")}\n\nPanitia belum memutuskan skorsingnya. Lanjut mulai laga?`, { title: "Peringatan akumulasi kuning", ok: "Ya, mulai laga", danger: true }))) return;
    // durasi dibekukan sekarang: mengubah Pengaturan nanti tidak mengacaukan laga ini
    await updateDoc(matchRef(id), {
      status: "live", phase: "h1", cfg: cfgFor(m, timingOf(state.settings)), clock: runClock(), pause: null, addedMin: 0,
      correcting: false, etPlayed: false, timeouts: {}, penWinner: null, penKicks: [], wo: false,
      // pelacakan kiper dan pergantian
      gkA: gkNow(m, "A", state.players), gkB: gkNow(m, "B", state.players),
      gkUsedA: uniq([gkNow(m, "A", state.players)]), gkUsedB: uniq([gkNow(m, "B", state.players)]),
      subLog: [],
    });
  },
  async "end-h1"(id) {
    const m = state.matchById[id];
    if (!(await confirmEarly(m, "babak 1"))) return;
    await goPhase(m, "ht", { notes: [mkNote(m, "Akhir babak 1 · Istirahat", stampNow(m))], clock: runClock() });
  },
  async "start-h2"(id) {
    const m = state.matchById[id];
    await goPhase(m, "h2", { notes: [mkNote(m, "Babak 2 dimulai", stampAt(m, "h2", 0))], clock: runClock() });
  },
  async "to-et"(id) {
    const m = state.matchById[id];
    if (!(await confirmEarly(m, "waktu normal"))) return;
    await goPhase(m, "et1", { notes: [mkNote(m, "Akhir waktu normal · Perpanjangan waktu", stampNow(m))], clock: stopClock(), extra: { etPlayed: true } });
  },
  async "end-et1"(id) {
    const m = state.matchById[id];
    if (!(await confirmEarly(m, "ET1"))) return;
    await goPhase(m, "etb", { notes: [mkNote(m, "Akhir ET1 · Istirahat", stampNow(m))], clock: runClock() });
  },
  async "start-et2"(id) {
    const m = state.matchById[id];
    await goPhase(m, "et2", { notes: [mkNote(m, "ET2 dimulai", stampAt(m, "et2", 0))], clock: runClock() });
  },
  async "to-pen"(id) {
    const m = state.matchById[id], ph = phaseOf(m);
    if (!(await confirmEarly(m, ph === "et2" ? "ET2" : "waktu normal"))) return;
    await goPhase(m, "pen", { notes: [mkNote(m, ph === "et2" ? "Akhir ET2 · Adu penalti" : "Akhir waktu normal · Adu penalti", stampNow(m))], clock: stopClock() });
  },
  async "added-inc"(id) { await setAdded(id, +1); },
  async "added-dec"(id) { await setAdded(id, -1); },
  async pause(id) {
    const m = state.matchById[id], ph = phaseOf(m);
    const v = await openModal({
      title: "Jeda darurat", ok: "Hentikan jam", message: "Jam berhenti dan alasannya tampil di layar penonton.",
      fields: `<div class="pausef"><div>${PAUSE_REASONS.map(([k, l], i) => `<label class="check"><input type="radio" name="reason" value="${k}" ${i === 0 ? "checked" : ""}> ${l}</label>`).join("")}</div>
        <div class="when-to"><label for="pz-side">Time-out untuk tim</label><select id="pz-side" name="side"><option value="A">${esc(sideName(m, "A"))}</option><option value="B">${esc(sideName(m, "B"))}</option></select></div>
        <div class="when-ot"><label for="pz-note">Keterangan (opsional, tampil di publik)</label><input id="pz-note" type="text" name="note" maxlength="30" autocomplete="off"></div></div>`,
      read: (r) => ({ key: r.querySelector('[name="reason"]:checked').value, side: r.querySelector('[name="side"]').value, note: r.querySelector('[name="note"]').value.trim() }),
    });
    if (!v) return;
    const patch = { clock: stopClock(elapsedSec(m)) };
    let label = (PAUSE_REASONS.find((x) => x[0] === v.key) || [])[1] || "Jeda";
    if (v.key === "other" && v.note) label = v.note;
    if (v.key === "timeout") {
      // Aturan futsal: 1 time-out (1 menit) per tim per babak, tidak ada di perpanjangan waktu. Peringatan saja, tidak memblokir.
      const used = m.timeouts && m.timeouts[ph + v.side];
      const warn = ph === "et1" || ph === "et2" ? "Di perpanjangan waktu tidak ada time-out menurut aturan futsal." : used ? `${sideName(m, v.side)} sudah memakai time-out di babak ini (jatah 1 per tim per babak).` : "";
      if (warn && !(await confirmBox(warn + "\nTetap catat time-out ini?", { title: "Time-out", ok: "Ya, catat" }))) return;
      label = `Time-out ${sideName(m, v.side)}`;
      patch.timeouts = { ...(m.timeouts || {}), [ph + v.side]: true };
    }
    patch.pause = { key: v.key, label, ...(v.key === "timeout" ? { side: v.side } : {}) };
    const b = writeBatch(db);
    b.set(doc(collection(db, "events")), mkNote(m, `Jeda · ${label}`, stampNow(m)));
    b.update(matchRef(id), patch);
    await b.commit();
  },
  async resume(id) {
    const m = state.matchById[id];
    await updateDoc(matchRef(id), { clock: runClock(m.clock?.baseSec || 0), pause: null });
  },
  async finish(id) {
    const m = state.matchById[id];
    const miss = matchReadiness(m, state.players);
    if (miss.length) throw new Error("Lengkapi line up dulu: " + miss.join("; ") + ".");
    const [a, b] = finalScore(m, state.events.filter((e) => e.matchId === id));
    if (isKnockout(m) && a === b && !m.penWinner) throw new Error("Skor seri di babak gugur. Pilih pemenang adu penalti dulu.");
    const ph = phaseOf(m);
    const early = isPlayPhase(ph) && !m.correcting && elapsedSec(m) < periodLimitSec(m, ph) ? `\n\nPerhatian: ${PHASE_NAME[ph]} baru ${clockText(m)} dari ${limitText(m, ph)}.` : "";
    if (!(await confirmBox(`Akhiri laga ${sideName(m, "A")} ${a} – ${b} ${sideName(m, "B")}?\nHasil akan masuk klasemen.${early}`, { title: "Akhiri pertandingan?", ok: "Ya, akhiri laga" }))) return;
    await updateDoc(matchRef(id), { status: "ft", scoreA: a, scoreB: b, clock: stopClock(elapsedSec(m)), pause: null, addedMin: 0, correcting: false });
    ui.sheet = null;
  },
  async "backup-json"() {
    const data = backupData();
    saveBlob(new Blob([JSON.stringify(data)], { type: "application/json" }), `ifl-backup-${stamp2()}.json`);
    markBackup();
    toast("Backup JSON diunduh");
  },
  async "backup-zip"() {
    const data = backupData(), day = stamp2();
    const files = [[`ifl-backup-${day}.json`, JSON.stringify(data)]];
    const sheets = exportSheets();
    files.push([`laporan-ifl-${day}.xlsx`, new Uint8Array(await buildXlsx(sheets).arrayBuffer())]);
    sheets.forEach((sh) => files.push([`csv-laporan/${safeName(sh.name)}.csv`, toCsv(sh.rows)]));
    files.push(["csv-mentah/tim.csv", rawCsv(state.teams)], ["csv-mentah/pemain.csv", rawCsv(state.players)], ["csv-mentah/pertandingan.csv", rawCsv(state.matches)], ["csv-mentah/kejadian.csv", rawCsv(state.events)]);
    files.push(["BACA-SAYA.txt", `Arsip data Industropolis Batang Futsal League\nDiunduh: ${new Date().toLocaleString("id-ID")}\n\n- ifl-backup-*.json : backup lengkap, dipakai untuk Pulihkan di Admin -> Pengaturan -> Backup & unduh data\n- laporan-ifl-*.xlsx : laporan Excel siap baca\n- csv-laporan/ : isi tiap lembar laporan dalam CSV (klasemen, jadwal & hasil, kejadian gol dan kartu, top scorer, dst.)\n- csv-mentah/ : data mentah per koleksi (kolom apa adanya dari database; logo tim hanya ada di file JSON)\n`]);
    saveBlob(zipBlob(files), `ifl-semua-data-${day}.zip`);
    markBackup();
    toast("ZIP semua data diunduh");
  },
  async "restore-clear"() { backupState = null; },
  async "restore-run"() {
    const bs = backupState;
    if (!bs) throw new Error("Pilih file backup dulu.");
    const d = bs.data;
    const msg = bs.replace
      ? `Database akan disamakan persis dengan file "${bs.fileName}": ${d.teams.length} tim, ${d.players.length} pemain, ${d.matches.length} pertandingan, ${d.events.length} kejadian. Data sekarang yang tidak ada di file akan dihapus.`
      : `${d.teams.length} tim, ${d.players.length} pemain, ${d.matches.length} pertandingan, dan ${d.events.length} kejadian dari "${bs.fileName}" akan ditulis ke database dan menimpa data dengan ID yang sama.`;
    if (!(await typeConfirm(msg, "PULIHKAN", { title: "Pulihkan data dari backup?", ok: "Ya, pulihkan" }))) return;
    // pengaman: simpan kondisi sekarang dulu
    saveBlob(new Blob([JSON.stringify(backupData())], { type: "application/json" }), `ifl-sebelum-pemulihan-${stamp2()}.json`);
    const writes = [];
    const put = (name, list) => list.forEach((x) => { const { id, ...rest } = x; writes.push({ ref: doc(db, name, String(id)), data: bkDe(rest) }); });
    put("teams", d.teams); put("players", d.players); put("matches", d.matches); put("events", d.events);
    writes.push({ ref: doc(db, "settings", "main"), data: bkDe(d.settings || {}) });
    for (let i = 0; i < writes.length; i += 400) {
      const b = writeBatch(db);
      writes.slice(i, i + 400).forEach((w) => b.set(w.ref, w.data));
      await b.commit();
    }
    let removed = 0;
    if (bs.replace) {
      const keep = (list) => new Set(list.map((x) => String(x.id)));
      const k = { teams: keep(d.teams), players: keep(d.players), matches: keep(d.matches), events: keep(d.events) };
      const extra = [];
      for (const name of Object.keys(k)) state[name].forEach((x) => { if (!k[name].has(String(x.id))) extra.push(doc(db, name, x.id)); });
      await deleteMany(extra);
      removed = extra.length;
    }
    backupState = null;
    toast(`Data dipulihkan: ${writes.length} dokumen ditulis${removed ? `, ${removed} dihapus` : ""}`);
  },
  async "export-xlsx"() {
    const blob = buildXlsx(exportSheets());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ifl-2026-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    toast("File Excel diunduh");
  },
  // --- Skorsing, pergantian ---
  async "susp-set"(key, el) {
    const len = el.dataset.len === "" ? null : Number(el.dataset.len);
    const soft = el.dataset.soft === "1";
    if (len === 0 && !(await confirmBox(soft ? "Peringatan akumulasi kuning diabaikan: pemain ini boleh bermain dan tidak ada skorsing. Bisa dikembalikan lewat Kembalikan otomatis." : "Pemain ini akan boleh bermain lagi di laga ini. Pakai untuk banding yang diterima atau salah catat kartu.", { title: soft ? "Abaikan peringatan kuning?" : "Batalkan skorsing?", ok: soft ? "Ya, abaikan" : "Ya, batalkan skorsing", danger: !soft }))) return;
    await setDoc(doc(db, "settings", "main"), { suspOverrides: { [key]: len } }, { merge: true });
    toast(len === null ? "Dikembalikan ke hitungan otomatis" : len === 0 ? (soft ? "Peringatan diabaikan" : "Skorsing dibatalkan") : `Skorsing menjadi ${len} laga`);
  },
  async "sub-undo"(id) {
    const m = state.matchById[id], last = (m?.subLog || []).at(-1);
    if (!last) return;
    if (!(await confirmBox(`${pName(last.in)} masuk menggantikan ${pName(last.out)} (${sideName(m, last.s)}).`, { title: "Batalkan ganti kiper terakhir?", ok: "Ya, batalkan", danger: true }))) return;
    const patch = { subLog: m.subLog.slice(0, -1) };
    if (last.g && m["gk" + last.s] === last.in) { patch["gk" + last.s] = last.gp ?? null; patch["gkUsed" + last.s] = last.gu || []; }
    await updateDoc(matchRef(id), patch);
  },
  async "gk-change"(id, el) {
    const m = state.matchById[id], side = el.dataset.side;
    if (!m || m.status !== "live") throw new Error("Laga tidak sedang LIVE.");
    if (phaseOf(m) === "pen") throw new Error("Tidak ada ganti kiper saat adu penalti.");
    const cur = gkNow(m, side, state.players);
    if (cur === null) throw new Error("Sedang power play. Tekan Akhiri power play dulu.");
    const cands = gkCandidates(m, side, cur);
    if (!cands.length) throw new Error(`${sideName(m, side)} hanya punya 1 kiper di line up, jadi kiper tidak bisa diganti. Untuk main tanpa kiper pakai Power play.`);
    const v = await openModal({
      title: `Ganti kiper · ${sideName(m, side)}`, ok: "Ganti kiper", message: `Kiper sekarang: ${pName(cur)}. Pilih kiper pengganti.`,
      fields: `<label for="gk-sel">Kiper pengganti</label><select id="gk-sel" name="gk">${playerOpts(cands)}</select>`,
      read: (root) => ({ gk: root.querySelector("[name=gk]").value }),
    });
    if (!v || !v.gk || v.gk === cur) return;
    await putKeeper(m, side, v.gk, cur, `Ganti kiper (${sideName(m, side)}): ${pName(cur)} → ${pName(v.gk)}`);
    toast(`${pName(v.gk)} jaga gawang`);
  },
  async powerplay(id, el) {
    const m = state.matchById[id], side = el.dataset.side;
    if (!m || m.status !== "live") throw new Error("Laga tidak sedang LIVE.");
    if (phaseOf(m) === "pen") throw new Error("Tidak ada power play saat adu penalti.");
    const cur = gkNow(m, side, state.players), st = stampNow(m);
    if (cur) { // mulai power play: kiper tetap di lapangan sebagai pemain biasa
      const b = writeBatch(db);
      b.update(matchRef(id), { ["gk" + side]: null, ["gkPrev" + side]: cur });
      b.set(doc(collection(db, "events")), mkNote(m, `Kiper terbang (${sideName(m, side)})`, st));
      await b.commit();
      toast(`Power play ${sideName(m, side)}`);
      return;
    }
    const cands = gkCandidates(m, side, null);
    if (!cands.length) throw new Error("Tidak ada kiper yang bisa kembali menjaga gawang (kiper kena kartu merah).");
    const prev = m["gkPrev" + side];
    let back = cands.includes(prev) ? prev : cands.length === 1 ? cands[0] : null;
    if (!back) {
      const v = await openModal({
        title: `Akhiri power play · ${sideName(m, side)}`, ok: "Simpan", message: "Pilih kiper yang kembali menjaga gawang.",
        fields: `<label for="gk-sel">Kiper</label><select id="gk-sel" name="gk">${playerOpts(cands)}</select>`,
        read: (root) => ({ gk: root.querySelector("[name=gk]").value }),
      });
      if (!v || !v.gk) return;
      back = v.gk;
    }
    await putKeeper(m, side, back, null, `Kiper kembali (${sideName(m, side)}): ${pName(back)}`);
    toast(`${pName(back)} kembali jaga gawang`);
  },
  "ts-sort"(_, el) { ui.tsSort = el.dataset.key; },
  // --- POS ---
  side(_, el) { ui.side = el.dataset.side; },
  tab(_, el) { ui.tabs[el.dataset.group] = el.dataset.tab; },
  pick(id, el) { ui.sheet = { matchId: route().id, side: el.dataset.side, playerId: id, step: "act" }; },
  "close-sheet"() { ui.sheet = null; },
  "edit-event"(id) {
    const e = state.events.find((x) => x.id === id), m = e && state.matchById[e.matchId];
    if (!e || !m) throw new Error("Kejadian tidak ditemukan.");
    if (m.status !== "live" && m.status !== "ft") throw new Error("Kejadian hanya bisa diubah saat laga LIVE atau sudah selesai.");
    if (e.second) throw new Error("Kartu merah ini otomatis dari kuning kedua. Batalkan kejadiannya lalu catat ulang.");
    ui.sheet = { matchId: m.id, step: "edit", eventId: id, draft: { kind: kindOf(e), playerId: e.playerId, assistId: e.assistId || "", ...minuteFields(m, e) } };
    ui.sheet.init = { ...minuteFields(m, e) };
  },
  async ev(_, el) {
    const s = ui.sheet, m = curMatch();
    if (!s || !m) return;
    const type = el.dataset.type;
    if (type === "goal" && lineupIds(m, s.side).length > 1) { s.step = "assist"; s.type = "goal"; return; }
    ui.sheet = null;
    // gol penalti disimpan sebagai gol biasa bertanda pen (tanpa assist), jadi ikut hitungan top scorer
    if (type === "penalty") await recordEvent(m, s.side, s.playerId, "goal", null, { pen: true });
    else await recordEvent(m, s.side, s.playerId, type, null);
  },
  async assist(_, el) {
    const s = ui.sheet, m = curMatch();
    if (!s || !m) return;
    ui.sheet = null;
    await recordEvent(m, s.side, s.playerId, "goal", el.dataset.pick || null);
  },
  // --- Line up ---
  "lu-toggle"(id, el) {
    const m = curMatch(); if (!m) return;
    const d = draftOf(m), side = el.dataset.side, cur = d[side][id] || "";
    const sp = suspOf(m, side).get(id);
    if (sp && !cur) throw new Error(`${pName(id)} sedang skorsing (${suspReason(sp)}). Panitia bisa membatalkannya di panel Skorsing.`);
    const next = cur === "" ? "S" : cur === "S" ? "B" : "";
    if (cur === "" && Object.values(d[side]).filter(Boolean).length >= LINEUP_MAX) throw new Error(`Line up sudah ${LINEUP_MAX} pemain (maksimal). Lepas satu pemain dulu sebelum menambah yang baru.`);
    if (next === "S") {
      // slot inti terakhir wajib kiper: kalau 4 inti belum ada kiper, pemain biasa tidak boleh mengisinya
      const team = playersOf(side === "A" ? m.teamA : m.teamB);
      const starters = team.filter((p) => d[side][p.id] === "S");
      const me = team.find((p) => p.id === id);
      if (starters.length === FUTSAL_STARTERS - 1 && !starters.some((p) => p.isGK) && !(me && me.isGK)) {
        throw new Error("Slot inti terakhir harus kiper. Pilih kiper dulu sebagai inti.");
      }
    }
    if (next === "S" && Object.values(d[side]).filter((v) => v === "S").length >= FUTSAL_STARTERS) {
      // inti penuh: lompat ke cadangan
      d[side][id] = "B";
    } else if (next) d[side][id] = next; else delete d[side][id];
    d.dirty = true;
  },
  "lu-reset"() { ui.draft = null; },
  async "lu-save"(id) {
    const m = state.matchById[id], d = draftOf(m);
    const build = (side) => {
      const starters = [], subs = [];
      for (const p of playersOf(side === "A" ? m.teamA : m.teamB)) {
        if (d[side][p.id] === "S") starters.push(p.id); else if (d[side][p.id] === "B") subs.push(p.id);
      }
      return { starters, subs };
    };
    const A = build("A"), B = build("B");
    for (const [side, L] of [["A", A], ["B", B]]) {
      const sp = suspOf(m, side), bad = [...L.starters, ...L.subs].find((pid) => sp.has(pid));
      if (bad) throw new Error(`${pName(bad)} (${sideName(m, side)}) sedang skorsing: ${suspReason(sp.get(bad))}. Keluarkan dari line up atau batalkan skorsingnya.`);
    }
    for (const [side, L] of [["A", A], ["B", B]]) {
      const tot = L.starters.length + L.subs.length;
      if (tot > LINEUP_MAX) throw new Error(`${sideName(m, side)}: line up maksimal ${LINEUP_MAX} pemain (sekarang ${tot}).`);
    }
    if (A.starters.length > FUTSAL_STARTERS || B.starters.length > FUTSAL_STARTERS) throw new Error(`Susunan inti maksimal ${FUTSAL_STARTERS} pemain per tim.`);
    for (const [side, L] of [["A", A], ["B", B]]) {
      if (L.starters.length === FUTSAL_STARTERS && !L.starters.some((pid) => state.playerById[pid]?.isGK)) {
        throw new Error(`${sideName(m, side)}: susunan inti harus ada kiper (GK).`);
      }
    }
    // pemain yang sudah punya kejadian di laga ini tidak boleh dikeluarkan dari line up
    const inLu = new Set([...A.starters, ...A.subs, ...B.starters, ...B.subs]);
    const gone = state.events.filter((e) => e.matchId === id && [e.playerId, e.assistId].some((x) => x && !inLu.has(x)));
    if (gone.length) throw new Error(`${pName(gone[0].playerId)} sudah punya kejadian di laga ini, tidak bisa dikeluarkan dari line up. Hapus kejadiannya dulu.`);
    await updateDoc(matchRef(id), { lineupA: A, lineupB: B });
    ui.draft = null;
    toast("Line up tersimpan");
  },
  async "fill-ko"() {
    const plan = planKnockout(state.teams, state.matches, state.events);
    if (!plan.length) throw new Error("Pasangan babak gugur sudah sesuai bagan.");
    const over = plan.filter((x) => x.patch.lineupA || x.patch.lineupB);
    if (over.length && !(await confirmBox(`Tim di ${over.map((x) => x.name).join(", ")} akan diganti dan line up laga itu dikosongkan.`, { title: "Ganti tim di bagan?", ok: "Ya, ganti", danger: true }))) return;
    const b = writeBatch(db);
    plan.forEach((x) => b.update(matchRef(x.id), x.patch));
    await b.commit();
    toast(`${plan.length} laga babak gugur terisi`);
  },
  async reopen(id) {
    const m = state.matchById[id];
    if (m.wo) {
      if (!(await confirmBox("Status WO dibatalkan, laga kembali ke Terjadwal dengan skor 0 – 0 dan hasilnya keluar dari klasemen.", { title: "Batalkan hasil WO?", ok: "Ya, batalkan WO", danger: true }))) return;
      await updateDoc(matchRef(id), { status: "scheduled", wo: false, scoreA: 0, scoreB: 0, adjA: 0, adjB: 0, phase: null, penWinner: null, penKicks: [], correcting: false, pause: null, addedMin: 0, clock: stopClock(0) });
      return;
    }
    if (!(await confirmBox("Hasilnya keluar dari klasemen sampai kamu menekan Selesai (FT) lagi.", { title: "Buka kembali laga ini untuk koreksi?", ok: "Ya, buka kembali" }))) return;
    // laga lama (sebelum fase) diberi fase terakhir supaya cap menit koreksi masuk akal
    await updateDoc(matchRef(id), {
      status: "live", phase: m.phase || "h2", cfg: m.cfg || cfgFor(m, timingOf(state.settings)), correcting: true,
      pause: { key: "koreksi", label: "Koreksi" }, clock: stopClock(m.clock?.baseSec || 0),
    });
  },
  async "pen-kick"(id, el) {
    const m = state.matchById[id];
    if (!m || m.status !== "live" || !isKnockout(m) || (m.scoreA ?? 0) !== (m.scoreB ?? 0)) throw new Error("Adu penalti hanya untuk laga babak gugur yang masih seri.");
    if (phaseOf(m) !== "pen" && !m.correcting) throw new Error("Adu penalti belum dimulai. Pilih Langsung adu penalti / Lanjut adu penalti dulu.");
    const side = el.dataset.side, so = shootout(m);
    if (side !== "A" && side !== "B") return;
    if (so.winner) throw new Error(`Pemenang sudah pasti: ${sideName(m, so.winner)}. Batalkan tendangan terakhir bila salah catat.`);
    if (so.next && so.next !== side) throw new Error(`Giliran ${sideName(m, so.next)} dulu.`);
    const kicks = [...so.kicks, { s: side, g: el.dataset.res === "g" }];
    await updateDoc(matchRef(id), { penKicks: kicks, penWinner: shootout({ penKicks: kicks }).winner });
    toast(`${sideName(m, side)}: ${el.dataset.res === "g" ? "gol" : "gagal"}`);
  },
  async "pen-undo"(id) {
    const m = state.matchById[id], so = shootout(m);
    if (!so.any) throw new Error("Belum ada tendangan.");
    const kicks = so.kicks.slice(0, -1);
    await updateDoc(matchRef(id), { penKicks: kicks, penWinner: kicks.length ? shootout({ penKicks: kicks }).winner : null });
  },
  async "del-event"(id) {
    const e = state.events.find((x) => x.id === id);
    if (!e) return;
    if (!(await confirmBox(`${evLabel(e)} · ${pName(e.playerId)} menit ${e.minute ?? 0}'. Skor ikut menyesuaikan.`, { title: "Batalkan kejadian ini?", ok: "Ya, batalkan", cancel: "Tidak", danger: true }))) return;
    const m = state.matchById[e.matchId];
    const batch = writeBatch(db);
    batch.delete(doc(db, "events", id));
    if (m) {
      const [a, b] = finalScore(m, state.events.filter((x) => x.matchId === m.id && x.id !== id));
      const patch = { scoreA: a, scoreB: b };
      if (a !== b && (m.penWinner || m.penKicks?.length)) { patch.penWinner = null; patch.penKicks = []; }
      batch.update(matchRef(m.id), patch);
    }
    await batch.commit();
  },
  async "del-match"(id) {
    if (!(await confirmBox("Semua kejadian di laga ini ikut terhapus dan tidak bisa dikembalikan.", { title: "Hapus pertandingan ini?", ok: "Ya, hapus", danger: true }))) return;
    const b = writeBatch(db);
    state.events.filter((e) => e.matchId === id).forEach((e) => b.delete(doc(db, "events", e.id)));
    b.delete(matchRef(id));
    await b.commit();
    location.hash = "#matches";
  },
  async "wipe-matches"() {
    const n = state.matches.length;
    if (!n) throw new Error("Belum ada pertandingan.");
    if (!(await typeConfirm(`${n} pertandingan beserta ${state.events.length} kejadiannya akan dihapus dan tidak bisa dikembalikan. Tim dan pemain tidak ikut terhapus.`, "HAPUS", { title: "Hapus semua pertandingan?", ok: "Ya, hapus semua" }))) return;
    await deleteMany([...state.events.map((e) => doc(db, "events", e.id)), ...state.matches.map((m) => matchRef(m.id))]);
    toast(`${n} pertandingan dihapus`);
  },
  async "wipe-teams"() {
    const n = state.teams.length;
    if (!n) throw new Error("Belum ada tim.");
    if (state.matches.length) throw new Error(`Masih ada ${state.matches.length} pertandingan yang memakai tim. Hapus semua pertandingan dulu.`);
    if (!(await typeConfirm(`${n} tim beserta ${state.players.length} pemain dan official akan dihapus dan tidak bisa dikembalikan.`, "HAPUS", { title: "Hapus semua tim?", ok: "Ya, hapus semua" }))) return;
    await deleteMany([...state.players.map((p) => doc(db, "players", p.id)), ...state.teams.map((t) => doc(db, "teams", t.id))]);
    await setDoc(doc(db, "settings", "main"), { bestGkId: null }, { merge: true });
    toast(`${n} tim dihapus`);
  },
  async "del-team"(id) {
    const t = state.teamById[id];
    if (state.matches.some((m) => m.teamA === id || m.teamB === id)) throw new Error("Tim ini masih dipakai di jadwal. Hapus atau ubah laganya dulu.");
    if (!(await confirmBox(`Tim "${t.name}" beserta semua pemainnya akan dihapus dan tidak bisa dikembalikan.`, { title: "Hapus tim ini?", ok: "Ya, hapus tim", danger: true }))) return;
    const b = writeBatch(db);
    state.players.filter((p) => p.teamId === id).forEach((p) => b.delete(doc(db, "players", p.id)));
    b.delete(doc(db, "teams", id));
    await b.commit();
    location.hash = "#teams";
  },
  async "pick-gk"(id) {
    const next = state.settings.bestGkId === id ? null : id;
    await setDoc(doc(db, "settings", "main"), { bestGkId: next }, { merge: true });
    toast(next ? `Kiper terbaik: ${pName(id)}` : "Pilihan kiper terbaik dibatalkan");
  },
  "clear-import"() { importState = null; },
  async "apply-import"() {
    const st = importState;
    if (!st || st.plan.errors.length) throw new Error("Perbaiki masalah di file dulu.");
    if (st.replace && !(await confirmBox("Mode ganti total aktif: pemain/official lama yang tidak ada di file akan DIHAPUS. Kejadian dan line up yang memakainya akan kehilangan nama.", { title: "Ganti total data tim?", ok: "Ya, lanjutkan impor", danger: true }))) return;
    const ops = buildOps(st.plan, { existingPlayers: state.players, matches: state.matches, replace: st.replace, newId: (c) => doc(collection(db, c)).id });
    if (!ops.length) throw new Error("Tidak ada perubahan.");
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(db);
      for (const o of ops.slice(i, i + 400)) {
        const ref = doc(db, o.col, o.id);
        if (o.op === "set") b.set(ref, o.data); else if (o.op === "update") b.update(ref, o.data); else b.delete(ref);
      }
      await b.commit();
    }
    importState = null;
    toast(`Impor selesai: ${st.plan.totals.teams} tim, ${st.plan.totals.players + st.plan.totals.officials} orang`);
    location.hash = "#teams";
  },
  async "del-logo"(id) {
    if (!(await confirmBox("Tim ini akan kembali memakai lingkaran berisi singkatan nama.", { title: "Hapus logo tim?", ok: "Ya, hapus logo", danger: true }))) return;
    await updateDoc(doc(db, "teams", id), { logoUrl: null, logoWide: false, logoRatio: null, logoId: "none" });
  },
  async "del-player"(id) {
    const p = state.playerById[id];
    if (!(await confirmBox(`${p.number != null ? p.number + " · " : ""}${p.name} akan dihapus dari tim.${state.events.some((e) => e.playerId === id) ? "\nPemain ini punya gol/kartu yang tercatat; namanya akan tampil '–' di riwayat." : ""}`, { title: "Hapus pemain?", ok: "Ya, hapus", danger: true }))) return;
    const b = writeBatch(db);
    b.delete(doc(db, "players", id));
    state.matches.forEach((m) => {
      const patch = {};
      for (const k of ["lineupA", "lineupB"]) {
        const lu = m[k];
        if (lu && ([...(lu.starters || []), ...(lu.subs || [])].includes(id))) patch[k] = { starters: (lu.starters || []).filter((x) => x !== id), subs: (lu.subs || []).filter((x) => x !== id) };
      }
      if (m.motmId === id) patch.motmId = null;
      if (Object.keys(patch).length) b.update(matchRef(m.id), patch);
    });
    await b.commit();
  },
  async "edit-player"(id) {
    const p = state.playerById[id];
    const v = await playerBox(p, playersOf(p.teamId).filter((x) => x.id !== id));
    if (!v) return;
    const b = writeBatch(db);
    b.update(doc(db, "players", id), { number: v.number === "" ? null : Number(v.number), name: v.name, isGK: v.isGK, isCaptain: !!v.isCaptain });
    if (v.isCaptain) playersOf(p.teamId).filter((x) => x.id !== id && x.isCaptain).forEach((x) => b.update(doc(db, "players", x.id), { isCaptain: false }));
    await b.commit();
    toast("Pemain diperbarui");
  },
};

const forms = {
  async "group-setup"(f) {
    const picked = [...f.querySelectorAll("select[data-g]")].filter((s) => s.value).map((s) => ({ id: s.value, g: s.dataset.g, p: Number(s.dataset.p) }));
    if (!picked.length) throw new Error("Pilih minimal satu tim.");
    const dup = picked.find((x, i) => picked.findIndex((y) => y.id === x.id) !== i);
    if (dup) throw new Error(`${state.teamById[dup.id]?.name || "Tim"} dipilih lebih dari satu kali.`);
    const want = new Map(picked.map((x) => [x.id, x]));
    const changes = [];
    for (const t of state.teams) {
      const w = want.get(t.id);
      if (w) { if ((t.group || "") !== w.g || t.ord !== w.p) changes.push({ t, group: w.g, ord: w.p }); }
      else if (t.group || t.ord != null) changes.push({ t, group: "", ord: null });
    }
    if (!changes.length) throw new Error("Tidak ada perubahan.");
    const moved = changes.filter((c) => (c.t.group || "") !== c.group);
    const affected = state.matches.filter((m) => m.stage === "group" && moved.some((c) => m.teamA === c.t.id || m.teamB === c.t.id));
    if (affected.length && !(await confirmBox(`${affected.length} pertandingan grup ikut dipindah grupnya mengikuti tim.`, { title: "Pindahkan tim?", ok: "Ya, simpan" }))) return;
    const b = writeBatch(db);
    for (const c of changes) b.update(doc(db, "teams", c.t.id), { group: c.group, ord: c.ord });
    const seen = new Set();
    for (const c of moved) state.matches.filter((m) => m.stage === "group" && (m.teamA === c.t.id || m.teamB === c.t.id) && !seen.has(m.id)).forEach((m) => { seen.add(m.id); b.update(matchRef(m.id), { group: c.group }); });
    await b.commit();
    ui.gs = null;
  },
  async tiebreak(f) {
    const entries = [...new FormData(f).entries()].filter(([k]) => k.startsWith("tb-")).map(([k, v]) => [k.slice(3), Number(v)]);
    const nums = entries.map(([, n]) => n);
    if (entries.some(([, n]) => !Number.isInteger(n) || n < 1)) throw new Error("Isi urutan dengan angka 1, 2, 3, ...");
    if (new Set(nums).size !== nums.length) throw new Error("Urutan tidak boleh kembar. Beri tiap tim nomor berbeda.");
    for (const [id, n] of entries) await updateDoc(doc(db, "teams", id), { tbRank: n });
  },
  async login(f) {
    const fd = new FormData(f);
    await signInWithEmailAndPassword(auth, String(fd.get("email")).trim(), String(fd.get("password")));
  },
  async match(f) {
    const fd = new FormData(f), id = f.dataset.id, old = id ? state.matchById[id] : null;
    // laga yang sudah dimulai: fase dan tim dikunci (field disabled tidak ikut terkirim, jadi ambil dari data laga)
    const locked = !!old && old.status !== "scheduled";
    const stage = locked ? (old.stage || "group") : String(fd.get("stage") || "group");
    const teamA = locked ? old.teamA || null : fd.get("teamA") || null, teamB = locked ? old.teamB || null : fd.get("teamB") || null;
    if (teamA && teamA === teamB) throw new Error("Tim A dan Tim B tidak boleh sama.");
    const group = stage === "group" ? (state.teamById[teamA]?.group || state.teamById[teamB]?.group || "") : "";
    // urutan bagan eksplisit (QF1-4, SF1-2) supaya bagan tidak bergantung pada jam kickoff
    let slot = null;
    if (stage === "qf" || stage === "sf") {
      const raw = String(fd.get("slot") ?? "").trim(), max = stage === "qf" ? 4 : 2;
      if (raw !== "") {
        slot = Number(raw);
        if (!Number.isInteger(slot) || slot < 1 || slot > max) throw new Error(`Urutan bagan ${stage.toUpperCase()} harus angka 1–${max}.`);
        if (state.matches.some((x) => x.id !== id && x.stage === stage && x.slot === slot)) throw new Error(`${stage.toUpperCase()}${slot} sudah dipakai laga lain.`);
      }
    }
    // Fase gugur: satu tim tidak boleh dipakai dua kali di fase yang sama, dan tim yang tidak berhak (mis. peringkat 3-4 grup) butuh konfirmasi
    if (!locked && (stage === "qf" || stage === "sf" || stage === "final")) {
      for (const t of [teamA, teamB]) {
        if (t && state.matches.some((x) => x.id !== id && x.stage === stage && (x.teamA === t || x.teamB === t))) throw new Error(`${tName(t)} sudah dipakai di laga ${STAGES[stage]} lain.`);
      }
      const bad = knockoutTeamProblems(stage, [teamA, teamB], state.teams, state.matches, state.events);
      if (bad.length && !(await confirmBox(`Tim berikut tidak memenuhi syarat untuk ${STAGES[stage]}:\n• ${bad.join("\n• ")}\n\nLanjutkan hanya untuk kasus darurat, misalnya tim didiskualifikasi atau mundur.`, { title: "Tim tidak berhak tampil", ok: "Ya, tetap simpan", danger: true }))) return;
    }
    const data = { stage, group, matchday: Number(fd.get("matchday")) || 1, teamA, teamB, kickoff: fromLocalInput(fd.get("kickoff")), slot };
    if (old && !locked) {
      // tim diganti: line up lama milik tim sebelumnya, kosongkan
      if (teamA !== (old.teamA || null)) data.lineupA = { starters: [], subs: [] };
      if (teamB !== (old.teamB || null)) data.lineupB = { starters: [], subs: [] };
    }
    if (id) { await updateDoc(matchRef(id), data); toast("Tersimpan"); }
    else {
      await setDoc(doc(collection(db, "matches")), {
        ...data, status: "scheduled", scoreA: 0, scoreB: 0, clock: { running: false, baseSec: 0, startedAt: null },
        lineupA: { starters: [], subs: [] }, lineupB: { starters: [], subs: [] }, motmId: null, createdAt: Date.now(),
      });
      f.reset();
      toast("Pertandingan ditambahkan");
    }
  },
  async "import-matches"(f) {
    const lines = String(new FormData(f).get("text")).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Tempel jadwal dulu.");
    const byName = Object.fromEntries(state.teams.map((t) => [t.name.trim().toLowerCase(), t]));
    const stageMap = { qf: "qf", perempat: "qf", sf: "sf", semi: "sf", final: "final" };
    const docs = [], problems = [], slotCount = { qf: 0, sf: 0 };
    lines.forEach((line, i) => {
      const p = line.split(/\s*[|\t;]\s*/);
      const dt = (p[0] || "").trim();
      let iso = dt;
      const dm = dt.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\s+(\d{1,2})[.:](\d{2})$/);
      if (dm) iso = `${dm[3]}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")} ${dm[4].padStart(2, "0")}:${dm[5]}`;
      const tbd = /^(tbd|tba|-|–|menyusul|akan ditentukan)$/i.test(dt);
      const kickoff = tbd ? null : fromLocalInput(iso.replace(" ", "T"));
      const tag = (p[1] || "").trim();
      const stage = /^[A-Za-z]$/.test(tag) ? "group" : stageMap[tag.toLowerCase()];
      const A = (p[3] || "").trim(), B = (p[4] || "").trim();
      const ta = A ? byName[A.toLowerCase()] : null, tb = B ? byName[B.toLowerCase()] : null;
      if (!tbd && !kickoff) problems.push(`Baris ${i + 1}: tanggal/jam tidak valid ("${dt}"). Tulis TBD bila waktu belum ditentukan.`);
      else if (!stage) problems.push(`Baris ${i + 1}: grup/fase tidak dikenal ("${tag}")`);
      else if (A && !ta) problems.push(`Baris ${i + 1}: tim "${A}" tidak ditemukan`);
      else if (B && !tb) problems.push(`Baris ${i + 1}: tim "${B}" tidak ditemukan`);
      else if (stage === "group" && (!ta || !tb)) problems.push(`Baris ${i + 1}: laga grup harus punya dua tim`);
      else if (stage === "group" && ((ta.group || "") !== tag.toUpperCase() || (tb.group || "") !== tag.toUpperCase())) problems.push(`Baris ${i + 1}: ${!ta.group || ta.group !== tag.toUpperCase() ? ta.name : tb.name} bukan anggota grup ${tag.toUpperCase()}`);
      else docs.push({
        stage, group: stage === "group" ? tag.toUpperCase() : "", matchday: Number(p[2]) || 1,
        slot: stage === "qf" || stage === "sf" ? (++slotCount[stage] <= (stage === "qf" ? 4 : 2) ? slotCount[stage] : null) : null,
        teamA: ta?.id || null, teamB: tb?.id || null, kickoff, status: "scheduled", scoreA: 0, scoreB: 0,
        clock: { running: false, baseSec: 0, startedAt: null }, lineupA: { starters: [], subs: [] }, lineupB: { starters: [], subs: [] }, motmId: null, createdAt: Date.now() + i,
      });
    });
    if (problems.length) throw new Error(problems.slice(0, 4).join(" · ") + (problems.length > 4 ? ` (+${problems.length - 4} lagi)` : ""));
    for (let i = 0; i < docs.length; i += 400) {
      const b = writeBatch(db);
      docs.slice(i, i + 400).forEach((d) => b.set(doc(collection(db, "matches")), d));
      await b.commit();
    }
    f.reset();
    toast(`${docs.length} pertandingan diimpor`);
  },
  async "add-event"(f) {
    const m = state.matchById[f.dataset.id];
    if (!m || m.status !== "ft") throw new Error("Kejadian susulan hanya untuk laga yang sudah selesai. Saat LIVE, catat lewat papan pemain.");
    const fd = new FormData(f), side = fd.get("side") === "B" ? "B" : "A", kind = fd.get("kind"), playerId = fd.get("player"), assistRaw = fd.get("assist") || "";
    const teamId = side === "A" ? m.teamA : m.teamB;
    if (!teamId) throw new Error("Tim belum ditentukan untuk laga ini.");
    if (!KIND_LABEL[kind]) throw new Error("Jenis kejadian tidak valid.");
    const player = state.playerById[playerId];
    if (!player || player.teamId !== teamId) throw new Error("Pilih pemainnya dulu.");
    const type = kind === "pen" ? "goal" : kind === "own" ? "own_goal" : kind, isGoal = type === "goal" || type === "own_goal";
    const assistId = kind === "goal" && assistRaw ? assistRaw : null;
    if (assistId && (assistId === playerId || state.playerById[assistId]?.teamId !== teamId)) throw new Error("Assist tidak valid.");
    const stamp = stampFromFields(m, fd.get("phase") || "reg", Number(fd.get("minute")), Number(fd.get("extra") || 0));
    let secondYellow = false;
    if (type === "yellow" || type === "red") {
      const mine = state.events.filter((x) => x.matchId === m.id && x.playerId === playerId);
      if (mine.some((x) => x.type === "red")) throw new Error(`${pName(playerId)} sudah dikeluarkan (kartu merah) di laga ini.`);
      if (type === "yellow" && mine.some((x) => x.type === "yellow")) secondYellow = true;
    }
    const ev = { matchId: m.id, type, teamId, playerId, assistId, ...stamp, ts: nowMs() };
    if (kind === "pen") ev.pen = true;
    if (isGoal) { const conc = type === "goal" ? (side === "A" ? "B" : "A") : side; if (m["gk" + conc] !== undefined) ev.gkId = m["gk" + conc] ?? null; }
    const batch = writeBatch(db), patch = {};
    // pemain yang belum ada di line up ikut dimasukkan sebagai cadangan supaya tampil di line up dan bisa diubah nanti
    const lu = m["lineup" + side] || { starters: [], subs: [] }, inLu = new Set([...(lu.starters || []), ...(lu.subs || [])]);
    const add = [playerId, assistId].filter((x) => x && !inLu.has(x));
    if (add.length) patch["lineup" + side] = { starters: lu.starters || [], subs: [...(lu.subs || []), ...add] };
    batch.set(doc(collection(db, "events")), ev);
    if (secondYellow) batch.set(doc(collection(db, "events")), { ...ev, type: "red", second: true, assistId: null, ts: nowMs() + 1 });
    if (isGoal) {
      // gol yang tadinya "tanpa pencetak" (selisih manual) diganti pencetak: skor tetap. Kalau tidak ada selisih, skor bertambah.
      const forSide = type === "goal" ? side : side === "A" ? "B" : "A", k = forSide === "A" ? "adjA" : "adjB";
      if ((m[k] || 0) > 0) patch[k] = m[k] - 1;
      const [a, b] = finalScore({ ...m, ...patch }, [...state.events.filter((x) => x.matchId === m.id), { ...ev, id: "new" }]);
      patch.scoreA = a; patch.scoreB = b;
      if (a !== b && (m.penWinner || m.penKicks?.length)) { patch.penWinner = null; patch.penKicks = []; }
    }
    if (Object.keys(patch).length) batch.update(matchRef(m.id), patch);
    await batch.commit();
    ui.addEv = { matchId: m.id, side, kind, playerId: "", assistId: "", phase: fd.get("phase") || "reg", minute: "", extra: "0" };
  },
  async "edit-event"(f) {
    const e = state.events.find((x) => x.id === f.dataset.id), m = e && state.matchById[e.matchId];
    if (!e || !m) throw new Error("Kejadian tidak ditemukan (mungkin sudah dibatalkan).");
    if (m.status !== "live" && m.status !== "ft") throw new Error("Laga belum dimulai.");
    const fd = new FormData(f), kind = fd.get("kind"), playerId = fd.get("player"), assistRaw = fd.get("assist") || "";
    const side = e.teamId === m.teamA ? "A" : "B", lu = lineupIds(m, side);
    const wasGoal = e.type === "goal" || e.type === "own_goal", isGoalKind = ["goal", "pen", "own"].includes(kind);
    if (wasGoal !== isGoalKind || !KIND_LABEL[kind]) throw new Error("Jenis kejadian tidak valid.");
    if (!lu.includes(playerId)) throw new Error("Pemain ini tidak ada di line up.");
    const type = kind === "pen" ? "goal" : kind === "own" ? "own_goal" : kind;
    const assistId = kind === "goal" && assistRaw ? assistRaw : null;
    if (assistId && (assistId === playerId || !lu.includes(assistId))) throw new Error("Assist tidak valid.");
    if (type === "yellow" || type === "red") {
      const others = state.events.filter((x) => x.matchId === m.id && x.playerId === playerId && x.id !== e.id);
      if (others.some((x) => x.type === "red")) throw new Error(`${pName(playerId)} sudah dikeluarkan (kartu merah). Batalkan kartu merahnya dulu bila salah catat.`);
      if (type === "yellow" && others.some((x) => x.type === "yellow")) throw new Error(`${pName(playerId)} sudah punya kartu kuning. Batalkan kartu ini, lalu catat dari tombol pemain agar kuning kedua otomatis jadi merah.`);
      if ((e.playerId !== playerId || e.type !== type) && state.events.some((x) => x.matchId === m.id && x.playerId === e.playerId && x.second)) throw new Error("Kartu kuning ini sudah berpasangan dengan merah dari kuning kedua. Batalkan keduanya lalu catat ulang.");
    }
    if (m.status === "ft" && wasGoal && (e.type === "own_goal") !== (type === "own_goal")) throw new Error("Mengubah gol biasa jadi bunuh diri (atau sebaliknya) mengubah skor akhir. Buka kembali laga untuk koreksi dulu.");
    const patch = { type, playerId, assistId, pen: kind === "pen" ? true : deleteField() };
    // menit: hanya dihitung ulang kalau isian waktu/menit/tambahan diubah (detik asli dipertahankan kalau tidak)
    const init = ui.sheet?.eventId === e.id ? ui.sheet.init : minuteFields(m, e);
    const phase = fd.get("phase") || "reg", minute = Number(fd.get("minute")), extra = Number(fd.get("extra") || 0);
    if (phase !== init.phase || minute !== Number(init.minute) || extra !== Number(init.extra)) Object.assign(patch, stampFromFields(m, phase, minute, extra));
    if (wasGoal && e.type !== type) {
      // gol biasa <-> bunuh diri: kiper yang kebobolan ikut berubah sisi
      const conc = type === "goal" ? (side === "A" ? "B" : "A") : side;
      if (m["gk" + conc] !== undefined) patch.gkId = m["gk" + conc] ?? null;
    }
    const batch = writeBatch(db);
    let flipped = false;
    batch.update(doc(db, "events", e.id), patch);
    if (wasGoal) {
      const [a0, b0] = finalScore(m, state.events.filter((x) => x.matchId === m.id));
      const next = state.events.filter((x) => x.matchId === m.id).map((x) => (x.id === e.id ? { ...x, type, playerId, assistId, pen: kind === "pen" } : x));
      const [a, b] = finalScore(m, next);
      flipped = m.status === "ft" && Math.sign(a0 - b0) !== Math.sign(a - b);
      const sp = { scoreA: a, scoreB: b };
      if (a !== b && (m.penWinner || m.penKicks?.length)) { sp.penWinner = null; sp.penKicks = []; }
      batch.update(matchRef(m.id), sp);
    }
    await batch.commit();
    ui.sheet = null;
    // hasil laga yang sudah selesai berubah (menang/seri/kalah): ingatkan efek ke klasemen dan babak gugur
    if (flipped) setTimeout(() => toast("Hasil laga berubah. Klasemen ikut otomatis. Kalau babak gugur sudah terisi, tekan Isi pasangan otomatis lagi dan cek line up laga berikutnya.", true), 2200);
  },
  async motm(f) { await updateDoc(matchRef(f.dataset.id), { motmId: new FormData(f).get("motm") || null }); },
  async score(f) {
    const m = state.matchById[f.dataset.id], fd = new FormData(f);
    const ta = Math.max(0, Number(fd.get("a")) || 0), tb = Math.max(0, Number(fd.get("b")) || 0);
    const [da, db_] = scoreFromEvents(m, state.events);
    await updateDoc(matchRef(m.id), { scoreA: ta, scoreB: tb, adjA: ta - da, adjB: tb - db_, ...(ta !== tb && (m.penWinner || m.penKicks?.length) ? { penWinner: null, penKicks: [] } : {}) });
  },
  async "new-team"(f) {
    const fd = new FormData(f);
    const name = String(fd.get("name")).trim();
    if (state.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error("Nama tim sudah ada.");
    const grp = String(fd.get("group")).trim().toUpperCase();
    await setDoc(doc(collection(db, "teams")), { name, group: grp, ...(grp ? { ord: Date.now() } : {}) });
    f.reset();
  },
  async "bulk-teams"(f) {
    const lines = String(new FormData(f).get("text")).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Tempel daftar tim dulu.");
    const have = new Set(state.teams.map((t) => t.name.toLowerCase()));
    const b = writeBatch(db); let n = 0;
    for (const l of lines) {
      const [name, group = ""] = l.split(/\s*[|\t;]\s*/);
      if (!name || have.has(name.trim().toLowerCase())) continue;
      have.add(name.trim().toLowerCase());
      { const g = group.trim().toUpperCase(); b.set(doc(collection(db, "teams")), { name: name.trim(), group: g, ...(g ? { ord: Date.now() + n } : {}) }); } n++;
    }
    if (!n) throw new Error("Tidak ada tim baru (semua sudah ada).");
    await b.commit(); f.reset(); toast(`${n} tim ditambahkan`);
  },
  async team(f) {
    const id = f.dataset.id, fd = new FormData(f);
    const name = String(fd.get("name")).trim(), group = String(fd.get("group")).trim().toUpperCase();
    if (!name) throw new Error("Nama tim tidak boleh kosong.");
    if (state.teams.some((t) => t.id !== id && t.name.trim().toLowerCase() === name.toLowerCase())) throw new Error("Nama tim sudah dipakai tim lain.");
    const b = writeBatch(db);
    b.update(doc(db, "teams", id), { name, group, ...(group && group !== (state.teams.find((t) => t.id === id)?.group || "") ? { ord: Date.now() } : {}) });
    state.matches.filter((m) => m.stage === "group" && (m.teamA === id || m.teamB === id)).forEach((m) => b.update(matchRef(m.id), { group }));
    await b.commit();
  },
  async player(f) {
    const fd = new FormData(f);
    const n = String(fd.get("number")).trim();
    if (n !== "" && playersOf(f.dataset.id).some((p) => p.number === Number(n))) throw new Error(`No punggung ${n} sudah dipakai di tim ini.`);
    if (playersOf(f.dataset.id).length >= LIMITS.players && !(await confirmBox(`Tim ini sudah punya ${playersOf(f.dataset.id).length} pemain (ketentuan maksimal ${LIMITS.players}). Tetap tambahkan?`, { title: "Melebihi batas pemain", ok: "Ya, tambahkan" }))) return;
    const cap = !!fd.get("cap"), nb = writeBatch(db);
    nb.set(doc(collection(db, "players")), { teamId: f.dataset.id, name: String(fd.get("name")).trim(), number: n === "" ? null : Number(n), isGK: !!fd.get("gk"), isCaptain: cap, role: "player" });
    if (cap) playersOf(f.dataset.id).filter((x) => x.isCaptain).forEach((x) => nb.update(doc(db, "players", x.id), { isCaptain: false }));
    await nb.commit();
    f.reset();
  },
  async official(f) {
    const name = String(new FormData(f).get("name")).trim();
    if (!name) throw new Error("Isi nama official.");
    if (officialsOf(f.dataset.id).length >= LIMITS.officials) throw new Error(`Official maksimal ${LIMITS.officials} orang per tim.`);
    await setDoc(doc(collection(db, "players")), { teamId: f.dataset.id, name, number: null, isGK: false, role: "official" });
    f.reset();
  },
  async "bulk-players"(f) {
    const lines = String(new FormData(f).get("text")).split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error("Tempel daftar pemain dulu.");
    const entries = [];
    lines.forEach((l) => {
      const parts = l.split(/\s*[,|\t;]\s*/);
      let number = null;
      if (/^\d{1,2}$/.test(parts[0]) && parts.length > 1) number = Number(parts.shift());
      const name = (parts.shift() || "").trim();
      const isGK = parts.some((x) => /^(gk|kiper)$/i.test(x.trim()));
      const isCaptain = parts.some((x) => /^(c|cap|kapten)$/i.test(x.trim()));
      if (name) entries.push({ name, number, isGK, isCaptain });
    });
    if (!entries.length) throw new Error("Tidak ada pemain yang terbaca.");
    // nomor punggung tidak boleh kembar (di daftar ini maupun dengan pemain yang sudah ada)
    const used = new Map(playersOf(f.dataset.id).filter((p) => p.number != null).map((p) => [p.number, p.name]));
    for (const e of entries) {
      if (e.number == null) continue;
      if (used.has(e.number)) throw new Error(`No punggung ${e.number} dipakai dua kali (${used.get(e.number)} dan ${e.name}).`);
      used.set(e.number, e.name);
    }
    const newCaps = entries.filter((e) => e.isCaptain).length;
    if (newCaps > 1) throw new Error("Kapten hanya boleh satu orang per tim.");
    const total = playersOf(f.dataset.id).length + entries.length;
    if (total > LIMITS.players && !(await confirmBox(`Tim ini akan punya ${total} pemain (ketentuan maksimal ${LIMITS.players}). Tetap tambahkan?`, { title: "Melebihi batas pemain", ok: "Ya, tambahkan" }))) return;
    const b = writeBatch(db);
    if (newCaps) playersOf(f.dataset.id).filter((p) => p.isCaptain).forEach((p) => b.update(doc(db, "players", p.id), { isCaptain: false }));
    entries.forEach((e) => b.set(doc(collection(db, "players")), { teamId: f.dataset.id, name: e.name, number: e.number, isGK: e.isGK, isCaptain: !!e.isCaptain, role: "player" }));
    await b.commit(); f.reset(); toast("Pemain ditambahkan");
  },
  async announce(f) {
    const fd = new FormData(f);
    await setDoc(doc(db, "settings", "main"), { announcement: { active: !!fd.get("active"), title: String(fd.get("title")).trim(), body: String(fd.get("body")).trim() } }, { merge: true });
  },
  async timing(f) {
    const fd = new FormData(f);
    const num = (k, lo, hi, label) => { const v = Number(fd.get(k)); if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${label}: isi angka bulat ${lo}–${hi}.`); return v; };
    const timing = {
      groupHalves: Number(fd.get("groupHalves")) === 1 ? 1 : 2,
      groupHalf: num("groupHalf", 1, 45, "Grup: menit per babak"), koHalf: num("koHalf", 1, 45, "Babak gugur: menit per babak"),
      finalHalf: String(fd.get("finalHalf") ?? "").trim() === "" ? 0 : num("finalHalf", 1, 45, "Final: menit per babak"),
      etHalf: num("etHalf", 1, 15, "Perpanjangan waktu: menit per babak"), breakMin: num("breakMin", 0, 20, "Istirahat"), etBreakMin: num("etBreakMin", 0, 10, "Istirahat ET"),
    };
    await setDoc(doc(db, "settings", "main"), { timing }, { merge: true });
  },
  async wo(f) {
    const m = state.matchById[f.dataset.id], fd = new FormData(f);
    if (!m || m.status !== "scheduled") throw new Error("WO hanya bisa ditetapkan untuk laga yang belum dimulai.");
    if (!m.teamA || !m.teamB) throw new Error("Kedua tim harus sudah ditentukan.");
    const side = fd.get("winner") === "B" ? "B" : "A";
    const w = parseInt(fd.get("w"), 10), l = parseInt(fd.get("l"), 10);
    if (!Number.isInteger(w) || !Number.isInteger(l) || w < 0 || l < 0) throw new Error("Skor harus angka bulat 0 atau lebih.");
    if (w <= l) throw new Error("Skor pemenang harus lebih besar dari skor tim yang tidak hadir.");
    if (!(await confirmBox(`${sideName(m, side)} menang WO ${w} – ${l}. Laga langsung selesai tanpa line up dan hasilnya masuk klasemen.`, { title: "Tetapkan menang WO?", ok: "Ya, tetapkan WO", danger: true }))) return;
    const [sa, sb] = side === "A" ? [w, l] : [l, w];
    await updateDoc(matchRef(m.id), { status: "ft", wo: true, scoreA: sa, scoreB: sb, adjA: sa, adjB: sb, phase: null, clock: stopClock(0), pause: null, addedMin: 0, correcting: false, etPlayed: false, penWinner: null, penKicks: [] });
  },
  async pen(f) {
    const v = new FormData(f).get("pen");
    await updateDoc(matchRef(f.dataset.id), { penWinner: v === "A" || v === "B" ? v : null, penKicks: [] });
  },
};
const okText = {
  motm: "Tersimpan", "edit-event": "Kejadian diperbarui", "add-event": "Kejadian ditambahkan",
  score: "Skor diperbarui", "new-team": "Tim ditambahkan", team: "Tersimpan", player: "Pemain ditambahkan", official: "Official ditambahkan", tiebreak: "Urutan tersimpan", "group-setup": "Susunan grup tersimpan",
  pen: "Pemenang penalti tersimpan", wo: "WO ditetapkan", timing: "Durasi tersimpan", announce: "Pengumuman tersimpan",
};

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || !$app.contains(b) && !$bar.contains(b)) return;
  const fn = actions[b.dataset.act];
  if (!fn) return;
  b.disabled = true;
  act(() => fn(b.dataset.id, b), null).finally(() => { b.disabled = false; render(); });
});
document.addEventListener("submit", (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const fn = forms[f.dataset.form];
  const btn = f.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  act(() => fn(f), okText[f.dataset.form]).finally(() => { if (btn) btn.disabled = false; if (f.dataset.form !== "login") render(); });
});
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.matches?.("select[data-evd]") && ui.sheet?.draft) {
    const d = ui.sheet.draft, fd = new FormData(t.closest("form"));
    d.kind = fd.get("kind"); d.playerId = fd.get("player"); d.assistId = fd.get("assist") || "";
    d.phase = fd.get("phase") || d.phase; d.minute = fd.get("minute"); d.extra = fd.get("extra");
    if (d.kind !== "goal" || d.assistId === d.playerId) d.assistId = "";
    render();
    return;
  }
  if (t.matches?.("select[data-aevd]") && ui.addEv) {
    const d = ui.addEv, fd = new FormData(t.closest("form")), side = fd.get("side") === "B" ? "B" : "A", changed = side !== d.side;
    d.side = side; d.kind = fd.get("kind") || d.kind;
    d.playerId = changed ? "" : (fd.get("player") || "");
    d.assistId = changed || d.kind !== "goal" || fd.get("assist") === d.playerId ? "" : (fd.get("assist") || "");
    d.phase = fd.get("phase") || d.phase; d.minute = fd.get("minute") || ""; d.extra = fd.get("extra") || "0";
    render();
    return;
  }
  if (t.matches?.("select[data-g]")) { (ui.gs ||= {})[t.dataset.k] = t.value; syncSlots(t.closest("form")); return; }
  if (t.matches?.("[data-import-replace]") && importState) { importState.replace = t.checked; return; }
  if (!t.matches?.("[data-import-file]")) return;
  const file = t.files?.[0];
  if (!file) return;
  try {
    const rows = await parseFile(file);
    importState = { fileName: file.name, plan: buildPlan(rows, state.teams, state.players), replace: false };
    ui.tabs.addTeam = "impor";
    render();
  } catch (err) {
    console.error(err);
    importState = null;
    toast(errMsg(err), true);
  }
});
// Logo tim: dipangkas rapat ke isinya, diratakan ke tengah, lalu dikecilkan di browser dan disimpan langsung di dokumen tim (tanpa Firebase Storage)
// Hasil: { url, wide }. wide = true untuk logo lurus (lebih lebar dari 1,6 : 1), supaya tampil di kotak lebar dan tidak mengecil.
function fileToLogo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w0 = img.naturalWidth || 256, h0 = img.naturalHeight || 256;
      // 1) cari batas isi logo (abaikan piksel transparan dan latar putih polos)
      let x0 = 0, y0 = 0, x1 = w0 - 1, y1 = h0 - 1;
      try {
        const wk = document.createElement("canvas");
        wk.width = w0; wk.height = h0;
        const wx = wk.getContext("2d", { willReadFrequently: true });
        wx.drawImage(img, 0, 0);
        const d = wx.getImageData(0, 0, w0, h0).data;
        let a0 = w0, b0 = h0, a1 = -1, b1 = -1;
        for (let y = 0; y < h0; y++) for (let x = 0; x < w0; x++) {
          const i = (y * w0 + x) * 4;
          const solidWhite = d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245;
          if (d[i + 3] > 16 && !solidWhite) { if (x < a0) a0 = x; if (x > a1) a1 = x; if (y < b0) b0 = y; if (y > b1) b1 = y; }
        }
        if (a1 > a0 && b1 > b0) { x0 = a0; y0 = b0; x1 = a1; y1 = b1; }
      } catch { /* gambar dari sumber lain: pakai seluruh gambar */ }
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      // 2) kanvas hasil: logo lurus tetap lebar (maks. 3 : 1), selain itu persegi. Resolusi tinggi supaya tajam di monitor besar;
      //    bila terlalu besar untuk disimpan, resolusi diturunkan bertahap.
      const ratio = cw / ch, wide = ratio > 1.6, rr = Math.min(ratio, 3);
      const render = (long, q) => {
        const outW = wide ? long : Math.round(long * 0.8), outH = wide ? Math.round(outW / rr) : outW, pad = Math.round(outW * 0.03);
        const s = Math.min((outW - pad * 2) / cw, (outH - pad * 2) / ch, 4);
        const dw = Math.round(cw * s), dh = Math.round(ch * s);
        const c = document.createElement("canvas");
        c.width = outW; c.height = outH;
        const cx = c.getContext("2d");
        cx.imageSmoothingQuality = "high";
        cx.drawImage(img, x0, y0, cw, ch, Math.round((outW - dw) / 2), Math.round((outH - dh) / 2), dw, dh);
        let o = c.toDataURL("image/webp", q);
        if (!o.startsWith("data:image/webp")) o = c.toDataURL("image/png");
        return o;
      };
      let out = "";
      for (const [long, q] of [[960, 0.92], [800, 0.9], [640, 0.88], [512, 0.85], [384, 0.8], [256, 0.8]]) {
        out = render(long, q);
        if (out.length <= 420000) break;
      }
      URL.revokeObjectURL(url);
      if (out.length > 420000) return reject(new Error("Logo terlalu besar/rumit. Coba gambar yang lebih sederhana."));
      resolve({ url: out, wide, ratio: wide ? Math.round(rr * 100) / 100 : 1, lowRes: Math.max(cw, ch) < 200 });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("File bukan gambar yang valid.")); };
    img.src = url;
  });
}

document.addEventListener("change", (e) => {
  const inp = e.target.closest("input[data-logo]");
  if (inp && inp.files[0]) {
    const id = inp.dataset.logo, file = inp.files[0];
    act(async () => { const lg = await fileToLogo(file); await updateDoc(doc(db, "teams", id), { logoUrl: lg.url, logoWide: lg.wide, logoRatio: lg.ratio, logoId: "upload" }); if (lg.lowRes) toast("Logo tersimpan, tapi resolusinya kecil dan mungkin tampak buram. Minta file yang lebih besar ke tim.", true); }, "Logo tersimpan").finally(render);
    return;
  }
});

// Pilih file backup untuk dipulihkan: diperiksa dulu, belum ditulis ke database.
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.matches?.("[data-restore-replace]") && backupState) { backupState.replace = t.checked; render(); return; }
  if (!t.matches?.("[data-restore-file]")) return;
  const file = t.files?.[0];
  if (!file) return;
  try {
    if (file.size > 40 * 1024 * 1024) throw new Error("File terlalu besar untuk file backup.");
    let data;
    try { data = JSON.parse(await file.text()); } catch (err) { throw new Error("File bukan JSON yang valid."); }
    if (!data || data.app !== "ifl-website" || !["teams", "players", "matches", "events"].every((k) => Array.isArray(data[k]))) throw new Error("Ini bukan file backup website IFL.");
    const bad = ["teams", "players", "matches", "events"].find((k) => data[k].some((x) => !x || typeof x.id !== "string" || !x.id || x.id.includes("/")));
    if (bad) throw new Error(`Ada data ${bad} tanpa ID yang sah. File mungkin rusak.`);
    backupState = { fileName: file.name, data, replace: false };
  } catch (err) {
    console.error(err);
    toast(err.message || "File backup tidak bisa dibaca", true);
  }
  render();
});

// Jam LIVE bergerak tiap detik
setInterval(() => {
  document.querySelectorAll("[data-clock]").forEach((el) => {
    const m = state.matchById[el.dataset.clock];
    if (m && m.status === "live") el.textContent = livePill(m).text;
  });
  document.querySelectorAll("[data-clockbig]").forEach((el) => {
    const m = state.matchById[el.dataset.clockbig];
    if (m && m.status === "live") el.textContent = clockText(m);
  });
}, 1000);

window.addEventListener("hashchange", () => { ui.sheet = null; ui.draft = null; window.scrollTo(0, 0); startSkeleton(); render(); });
onChange(safeRender);

// Isi bagan babak gugur otomatis: hanya slot tim yang masih kosong, jadi line up dan tim yang sudah diisi admin tidak tertimpa.
// Percobaan yang sama tidak diulang dalam satu sesi (mencegah loop bila tulis gagal, dan tidak memaksa isi ulang slot yang sengaja dikosongkan).
let autoBusy = false;
const autoTried = new Map();
async function autoFillKnockout() {
  if (!user || !isReady() || autoBusy) return;
  const todo = autoFillPlan(state.teams, state.matches, state.events).filter((x) => autoTried.get(x.id) !== JSON.stringify(x.patch));
  if (!todo.length) return;
  autoBusy = true;
  try {
    const b = writeBatch(db);
    todo.forEach((x) => { b.update(matchRef(x.id), x.patch); autoTried.set(x.id, JSON.stringify(x.patch)); });
    await b.commit();
    toast(`Bagan terisi otomatis: ${todo.map((x) => x.name).join(", ")}`);
  } catch (e) { console.error("auto-fill bagan", e); } finally { autoBusy = false; }
}
onChange(autoFillKnockout);

// Ganti Fase di form laga: daftar tim ikut menyesuaikan (tim yang berhak dipisah dari yang tidak)
document.addEventListener("change", (e) => {
  const s = e.target.closest && e.target.closest('form[data-form="match"] select[name="stage"]');
  if (!s || !s.form) return;
  for (const nm of ["teamA", "teamB"]) {
    const el = s.form.elements[nm];
    if (el && !el.disabled) { const cur = el.value; el.innerHTML = teamOptions(cur, undefined, s.value); }
  }
});

onAuthStateChanged(auth, (u) => {
  user = u || null;
  if (user) { startStore(); syncServerTime().then(render); }
  render();
});
render();

setInterval(() => { if (user) syncServerTime(); }, 5 * 60 * 1000);
