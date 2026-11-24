// Penghubung ke Supabase. Menyediakan fungsi bernama sama seperti Firestore (collection, doc, setDoc, updateDoc,
// writeBatch, onSnapshot, ...) sehingga store.js dan admin.js tidak perlu tahu database apa yang dipakai.
//
// Cara kerja:
//  - Tiap koleksi = satu tabel (id + data JSON). Data dimuat sekali, lalu diperbarui lewat Supabase Realtime.
//  - Tulis (setDoc / updateDoc / writeBatch) dikirim lewat fungsi SQL apply_batch dalam satu transaksi (semua berhasil atau semua batal).
//  - Setelah tulis berhasil, tampilan lokal langsung diperbarui (tidak menunggu Realtime), seperti Firestore.
//  - Logo tim disimpan di tabel terpisah dan di-cache di browser (IndexedDB), supaya hemat bandwidth.
import { createClient } from "./vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

const CONFIG_MISSING = /GANTI-DENGAN/.test(SUPABASE_URL + SUPABASE_ANON_KEY);
const sb = createClient(CONFIG_MISSING ? "https://example.invalid" : SUPABASE_URL, CONFIG_MISSING ? "missing" : SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  realtime: { params: { eventsPerSecond: 20 } },
});
export const _client = sb; // untuk pengujian

export const db = { _db: true };
export const auth = { _auth: true };

// ---------- Galat: samakan kode dengan yang dipahami admin.js ----------
function fail(e, kind = "db") {
  const msg = String(e?.message || e || "Terjadi kesalahan.");
  let code = e?.code;
  if (CONFIG_MISSING) return Object.assign(new Error("Supabase belum dikonfigurasi. Isi js/supabase-config.js."), { code: "unavailable" });
  if (code === "42501" || code === "PGRST301" || code === "PGRST303" || /row-level security|permission denied|jwt/i.test(msg)) code = "permission-denied";
  else if (code === "P0002") code = "not-found";
  else if (kind === "auth" && (code === "invalid_credentials" || /invalid login credentials/i.test(msg))) code = "auth/invalid-credential";
  else if (kind === "auth" && (code === "over_request_rate_limit" || e?.status === 429)) code = "auth/too-many-requests";
  else if (/failed to fetch|networkerror|load failed|retryable/i.test(msg) || e?.name === "AuthRetryableFetchError") code = kind === "auth" ? "auth/network-request-failed" : "unavailable";
  const out = new Error(code === "not-found" ? "Data tidak ditemukan (mungkin sudah dihapus)." : msg);
  out.code = code;
  return out;
}

// ---------- Referensi & penanda ----------
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function autoId() {
  const b = new Uint8Array(20);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => ID_CHARS[x % ID_CHARS.length]).join("");
}
export const collection = (_db, name) => ({ _t: "col", name: String(name) });
export function doc(a, col, id) {
  if (a?._t === "col") return { _t: "doc", col: a.name, id: autoId() };
  if (!col || id === undefined || id === null || String(id) === "") throw new Error("doc(): koleksi dan id wajib diisi.");
  return { _t: "doc", col: String(col), id: String(id) };
}
const DEL = Object.freeze({ __s: "delete" });
export const deleteField = () => DEL;
export const increment = () => { throw new Error("increment() belum didukung di versi Supabase."); };
export const serverTimestamp = () => Date.now();
export const Timestamp = { fromMillis: (ms) => ms, now: () => Date.now() };

// ---------- Operasi tulis ----------
const clean = (v) => JSON.parse(JSON.stringify(v ?? {}));
function mk(ref, op, data) {
  const del = [], rest = {};
  for (const [k, v] of Object.entries(data || {})) { if (v === DEL) del.push(k); else rest[k] = v; }
  const o = { t: ref.col, id: ref.id, op, data: clean(rest) };
  if (del.length && op === "update") o.del = del;
  return o;
}
async function commit(ops) {
  if (!ops.length) return;
  const chunks = [];
  let cur = [], size = 0;
  for (const o of ops) {
    const s = JSON.stringify(o).length;
    if (cur.length && (cur.length >= 300 || size + s > 1_500_000)) { chunks.push(cur); cur = []; size = 0; }
    cur.push(o); size += s;
  }
  if (cur.length) chunks.push(cur);
  for (const ch of chunks) {
    if (CONFIG_MISSING) throw fail(null);
    let res;
    try { res = await sb.rpc("apply_batch", { ops: ch }); } catch (e) { throw fail(e); }
    if (res.error) throw fail(res.error);
    applyLocal(ch, res.data);
  }
}
export const setDoc = (ref, data, opts) => commit([mk(ref, opts?.merge ? "merge" : "set", data)]);
export const updateDoc = (ref, data) => commit([mk(ref, "update", data)]);
export const deleteDoc = (ref) => commit([{ t: ref.col, id: ref.id, op: "delete" }]);
export async function addDoc(colRef, data) { const ref = doc(colRef); await setDoc(ref, data); return ref; }
export function writeBatch() {
  const ops = []; let used = false;
  const b = {
    set(ref, data, opts) { ops.push(mk(ref, opts?.merge ? "merge" : "set", data)); return b; },
    update(ref, data) { ops.push(mk(ref, "update", data)); return b; },
    delete(ref) { ops.push({ t: ref.col, id: ref.id, op: "delete" }); return b; },
    commit() { if (used) throw new Error("Batch sudah dikirim."); used = true; return commit(ops); },
  };
  return b;
}

// ---------- Cache logo (IndexedDB) ----------
const idb = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => {
    try { const r = indexedDB.open("ifl-cache", 1); r.onupgradeneeded = () => r.result.createObjectStore("logos"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); }
  }));
  return {
    async get(k) { try { const d = await open(); return await new Promise((res) => { const q = d.transaction("logos").objectStore("logos").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); } catch { return undefined; } },
    async set(k, v) { try { const d = await open(); d.transaction("logos", "readwrite").objectStore("logos").put(v, k); } catch { /* abaikan */ } },
  };
})();
const logoMem = new Map(); // id tim -> { hash, url }

// ---------- Koleksi dalam memori ----------
const ms = (t) => { const n = Date.parse(t); return Number.isFinite(n) ? n : 0; };
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}
const colls = new Map();
const coll = (name) => { if (!colls.has(name)) colls.set(name, new Coll(name)); return colls.get(name); };

class Coll {
  constructor(name) {
    this.name = name; this.rows = new Map(); this.subs = new Set(); this.tomb = new Map();
    this.loaded = false; this.loading = false; this.again = false; this.started = false; this.queue = []; this.logoBusy = false;
  }
  view(id, row) {
    if (!row.view) {
      const o = structuredClone(row.data);
      if (this.name === "teams" && o.logoHash) { const l = logoMem.get(id); if (l) o.logoUrl = l.url; }
      row.view = o;
    }
    return row.view;
  }
  emit() {
    if (!this.loaded) return;
    const docs = [...this.rows].map(([id, row]) => ({ id, data: () => this.view(id, row) }));
    this.subs.forEach((s) => {
      if (s.id === undefined) s.cb({ docs, size: docs.length, empty: !docs.length });
      else { const row = this.rows.get(s.id); s.cb({ id: s.id, exists: () => !!row, data: () => (row ? this.view(s.id, row) : undefined) }); }
    });
  }
  fireError(e) { this.subs.forEach((s) => s.errCb?.(e)); }
  async load() {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    try {
      if (CONFIG_MISSING) throw fail(null);
      const all = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await sb.from(this.name).select("id,data,updated_at").order("id").range(from, from + 999);
        if (error) throw fail(error);
        all.push(...data);
        if (data.length < 1000) break;
      }
      const next = new Map();
      for (const r of all) next.set(r.id, { data: parseData(r.data), u: r.updated_at });
      this.rows = next; this.tomb.clear(); this.loaded = true;
      const q = this.queue; this.queue = [];
      q.forEach((p) => this.applyEvent(p));
      this.emit();
      this.ensureLogos();
    } catch (e) {
      this.fireError(e.code ? e : fail(e));
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.load(), 8000);
    } finally {
      this.loading = false;
      if (this.again) { this.again = false; this.load(); }
    }
  }
  onEvent(p) {
    if (!this.loaded) { this.queue.push(p); return; }
    this.applyEvent(p);
    this.emit();
    this.ensureLogos();
  }
  applyEvent(p) {
    if (p.eventType === "DELETE") {
      const id = p.old?.id; if (id == null) return;
      const t = ms(p.commit_timestamp) || Date.now(), cur = this.rows.get(id);
      if (cur && ms(cur.u) > t) return;
      this.rows.delete(id); this.tomb.set(id, t);
      return;
    }
    const r = p.new; if (!r || r.id == null) return;
    const t = ms(r.updated_at), cur = this.rows.get(r.id), tomb = this.tomb.get(r.id);
    if (cur && ms(cur.u) > t) return;
    if (tomb && t <= tomb) return;
    this.tomb.delete(r.id);
    this.rows.set(r.id, { data: parseData(r.data), u: r.updated_at });
  }
  // tulis lokal setelah transaksi berhasil (meniru hasil apply_batch)
  localOp(o, ts) {
    const t = ms(ts);
    if (o.op === "delete") { this.rows.delete(o.id); this.tomb.set(o.id, t); if (this.name === "teams") logoMem.delete(o.id); return; }
    const cur = this.rows.get(o.id);
    let d = { ...(o.data || {}) };
    if (this.name === "teams") delete d.logoHash;
    let next;
    if (o.op === "set") next = d;
    else if (o.op === "merge") next = deepMerge(cur?.data || {}, d);
    else { if (!cur) return; next = { ...cur.data, ...d }; (o.del || []).forEach((k) => delete next[k]); }
    if (this.name === "teams") {
      const dropLogo = () => { delete next.logoUrl; delete next.logoHash; logoMem.delete(o.id); };
      if ("logoUrl" in d) {
        const url = d.logoUrl; delete next.logoUrl;
        if (!url) dropLogo(); else { logoMem.set(o.id, { hash: "local", url }); next.logoHash = "local"; }
      } else if ((o.del || []).includes("logoUrl") || o.op === "set") dropLogo();
      else if (cur?.data.logoHash) next.logoHash = cur.data.logoHash;
    }
    this.tomb.delete(o.id);
    this.rows.set(o.id, { data: next, u: ts });
  }
  // unduh logo yang belum ada di cache (cek IndexedDB dulu, baru server)
  async ensureLogos() {
    if (this.name !== "teams" || this.logoBusy) return;
    this.logoBusy = true;
    try {
      for (let round = 0; round < 3; round++) {
        const need = [];
        for (const [id, row] of this.rows) {
          const h = row.data.logoHash; if (!h) continue;
          const m = logoMem.get(id);
          if (m && (m.hash === h || m.hash === "local")) continue;
          need.push([id, h]);
        }
        if (!need.length) break;
        let changed = false;
        const miss = [];
        for (const [id, h] of need) {
          const c = await idb.get(id);
          if (c && c.hash === h) { logoMem.set(id, { hash: h, url: c.url }); changed = true; } else miss.push(id);
        }
        for (let i = 0; i < miss.length; i += 6) {
          const { data, error } = await sb.from("team_logos").select("id,logo,hash").in("id", miss.slice(i, i + 6));
          if (error) break;
          for (const r of data) { logoMem.set(r.id, { hash: r.hash, url: r.logo }); idb.set(r.id, { hash: r.hash, url: r.logo }); changed = true; }
        }
        if (changed) { this.rows.forEach((row) => { row.view = null; }); this.emit(); } else break;
      }
    } catch (e) { console.warn("Logo belum termuat:", e?.message || e); }
    finally { this.logoBusy = false; }
  }
}
function parseData(d) { if (typeof d === "string") { try { return JSON.parse(d) || {}; } catch { return {}; } } return d && typeof d === "object" ? d : {}; }
function applyLocal(ops, ts) {
  const touched = new Set();
  for (const o of ops) { const c = colls.get(o.t); if (!c || !c.loaded) continue; c.localOp(o, ts); touched.add(c); }
  touched.forEach((c) => { c.emit(); c.ensureLogos(); });
}

// ---------- Langganan realtime ----------
let pendingStart = [], scheduled = false;
function scheduleStart(c) {
  pendingStart.push(c);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const list = pendingStart; pendingStart = [];
    // satu kanal untuk semua tabel yang mulai bersamaan (hemat koneksi)
    let ch = sb.channel("ifl-" + list.map((c) => c.name).join("-") + "-" + Math.random().toString(36).slice(2, 6));
    list.forEach((c) => { ch = ch.on("postgres_changes", { event: "*", schema: "public", table: c.name }, (p) => c.onEvent(p)); });
    ch.subscribe((status) => { if (status === "SUBSCRIBED") list.forEach((c) => { clearTimeout(c.t0); c.load(); }); });
    list.forEach((c) => { c.t0 = setTimeout(() => c.load(), 4000); });   // bila Realtime lambat, data tetap dimuat
  });
}
Coll.prototype.start = function start() { if (this.started) return; this.started = true; scheduleStart(this); };
export function onSnapshot(ref, cb, errCb) {
  const c = coll(ref._t === "col" ? ref.name : ref.col);
  const sub = ref._t === "col" ? { cb, errCb } : { id: ref.id, cb, errCb };
  c.subs.add(sub);
  c.start();
  if (c.loaded) c.emit();
  return () => c.subs.delete(sub);
}
if (typeof document !== "undefined") {
  let hiddenAt = 0;
  const resync = () => colls.forEach((c) => c.started && c.load());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 45000) resync();
  });
  addEventListener("online", resync);
}

// ---------- Login admin ----------
export async function signInWithEmailAndPassword(_auth, email, password) {
  if (CONFIG_MISSING) throw fail(null, "auth");
  let res;
  try { res = await sb.auth.signInWithPassword({ email, password }); } catch (e) { throw fail(e, "auth"); }
  if (res.error) throw fail(res.error, "auth");
  return { user: res.data.user };
}
export async function signOut() { await sb.auth.signOut(); }
export function onAuthStateChanged(_auth, cb) {
  let last, fired = false;
  const fire = (u) => { const k = u?.id || null; if (fired && k === last) return; fired = true; last = k; cb(u || null); };
  if (CONFIG_MISSING) { queueMicrotask(() => fire(null)); return () => {}; }
  const { data } = sb.auth.onAuthStateChange((_e, session) => fire(session?.user || null));
  sb.auth.getSession().then(({ data: d }) => fire(d.session?.user || null), () => fire(null));
  return () => data?.subscription?.unsubscribe();
}
