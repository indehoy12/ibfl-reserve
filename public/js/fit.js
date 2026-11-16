/* Penyesuaian layar besar (monitor lebar, 2K, 4K, TV).
   Semua ukuran di CSS memakai px, jadi di monitor besar tampilan tampak kecil dan tidak mengisi layar.
   Skrip ini memperbesar seluruh halaman secara proporsional mengikuti lebar layar.
   - Layar <= 1366px (HP, tablet, laptop): tidak berubah (skala 1).
   - Layar lebih lebar: skala = lebar layar / 1366, maksimum 4x.
   - Layar TV (#/tv): tidak diskala, karena tampilan TV sudah memakai satuan vh/vw. */
(function () {
  var BASE = 1366, MAX = 4, root = document.documentElement;
  function isTv() { return /^#\/?tv(\/|$)/.test(location.hash); }
  function apply() {
    var w = window.innerWidth || root.clientWidth || BASE;
    var z = isTv() || w <= BASE ? 1 : Math.min(MAX, Math.round((w / BASE) * 100) / 100);
    root.style.zoom = z === 1 ? "" : String(z);
    root.style.setProperty("--fit", String(z));
  }
  apply();
  window.addEventListener("resize", apply);
  window.addEventListener("hashchange", apply);
})();
