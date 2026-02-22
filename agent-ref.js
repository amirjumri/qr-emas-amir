// =======================================================
// agent-ref.js
// Tracker link agen
// - Sokong URL jenis:
//     1) https://emasamir.app/a/amir-jumri
//     2) https://emasamir.app/?ref=amir-jumri  (atau /j916.html?ref=...)
// - Simpan dalam localStorage supaya boleh guna di page lain
// - Expose helper di window.EmasAmirAgent
// =======================================================
(function () {
  const STORAGE_KEY = "emasamir_agent_ref";

  // ---------- Helper localStorage selamat ----------
  function safeSet(key, value) {
    try {
      localStorage.setItem(key, value);
      console.log("[AgentRef] Simpan =", value);
    } catch (e) {
      console.warn("[AgentRef] Tak boleh simpan:", e);
    }
  }

  function safeGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      // abaikan
    }
  }

  // ---------- Baca slug agen dari URL ----------
  function detectRefFromUrl() {
    try {
      const url = new URL(window.location.href);

      // 1) Cuba dari query ?ref=...
      let ref = (url.searchParams.get("ref") || "").trim();

      // 2) Kalau tiada, cuba dari path /a/slug
      //    contoh: /a/amir-jumri → "amir-jumri"
      if (!ref) {
        const m = url.pathname.match(/^\/a\/([^\/?#]+)/i);
        if (m && m[1]) {
          ref = decodeURIComponent(m[1]).trim();
        }
      }

      return ref || null;
    } catch (e) {
      console.warn("[AgentRef] detectRefFromUrl error:", e);
      return null;
    }
  }

  // ---------- Capture & bersihkan URL ----------
  function captureFromUrl() {
    const ref = detectRefFromUrl();
    if (!ref) return null;

    safeSet(STORAGE_KEY, ref);

    // Kalau datang dengan ?ref=..., buang supaya URL nampak bersih
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("ref")) {
        url.searchParams.delete("ref");

        const cleanPath =
          url.pathname +
          (url.searchParams.toString()
            ? "?" + url.searchParams.toString()
            : "") +
          url.hash;

        window.history.replaceState({}, "", cleanPath);
      }
    } catch (e) {
      // tak critical, boleh abaikan
    }

    return ref;
  }

  // ---------- API untuk page lain ----------
  function getRef() {
    return safeGet(STORAGE_KEY);
  }

  function setRef(ref) {
    if (!ref) return;
    const v = String(ref).trim();
    if (!v) return;
    safeSet(STORAGE_KEY, v);
  }

  function clearRef() {
    safeRemove(STORAGE_KEY);
  }

  // Expose ke global
  window.EmasAmirAgent = {
    getRef,          // dapatkan slug semasa
    setRef,          // (jarang perlu) set manual
    clearRef,        // padam dari browser
    captureFromUrl   // kalau nak paksa re-scan URL
  };

  // Terus run sekali masa page load
  captureFromUrl();
})();