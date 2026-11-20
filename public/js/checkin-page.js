// Halaman terpisah /checkin/ : registrasi tim hari-H. Memakai login dan data Firebase yang sama dengan Admin IFL.
import { auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "./firebase.js";
import { startStore, onChange, isReady } from "./store.js";
import * as CK from "./checkin.js";

const app = document.getElementById("app"), toastEl = document.getElementById("toast"), esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let user = null, tt;
function toast(msg, err) { toastEl.textContent = msg; toastEl.className = "ck-toast on" + (err ? " err" : ""); clearTimeout(tt); tt = setTimeout(() => (toastEl.className = "ck-toast"), 2600); }
const chrome = (title, sub, inner) => `<div class="ck-page"><div class="ck-hd"><div class="ck-hl ck-noprint"><a href="../admin/">← Admin</a>${user ? '<button id="ck-out">Keluar</button>' : ""}</div><small>IFL 2026 · Registrasi</small><h1>${title}</h1><p>${sub}</p></div><div class="ck-main">${inner}</div></div>`;

function login(msg = "") {
  app.innerHTML = chrome("Check-in Tim", "Masuk dengan akun panitia", `<form class="ck-form" id="ck-lf"><input type="email" name="e" placeholder="Email" autocomplete="username" required><input type="password" name="p" placeholder="Kata sandi" autocomplete="current-password" required><button class="ck-btn pri">Masuk</button><p class="ck-muted" style="color:var(--live)">${esc(msg)}</p></form>`);
  document.getElementById("ck-lf").onsubmit = async (ev) => { ev.preventDefault(); const f = new FormData(ev.target); try { await signInWithEmailAndPassword(auth, f.get("e"), f.get("p")); } catch { login("Email atau kata sandi salah."); } };
}
function render() {
  if (!user) return;
  if (!isReady()) { app.innerHTML = chrome("Check-in Tim", "Memuat data…", ""); return; }
  if (CK.typing()) return; // jangan ganggu yang sedang mengetik
  const [name, id] = location.hash.replace(/^#\/?/, "").split("/");
  let title = "Registrasi Tim", inner;
  if (name === "tim") { inner = CK.teamView(decodeURIComponent(id || "")); title = CK.teamTitle(decodeURIComponent(id || "")); }
  else if (name === "laporan") { inner = CK.reportView(); title = "Laporan Registrasi"; }
  else inner = CK.listView();
  app.innerHTML = chrome(title, "Jumat, 20 November · 17.00–17.20 WIB", inner);
  document.getElementById("ck-out").onclick = () => signOut(auth);
  CK.bind(app);
}
CK.init({ toast, render });
onAuthStateChanged(auth, (u) => { user = u; if (!u) { CK.stop(); return login(); } startStore(); CK.start(); render(); });
onChange(render);
addEventListener("hashchange", () => { document.activeElement?.blur?.(); render(); scrollTo(0, 0); });
