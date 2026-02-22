// =============== admin-guard.js ===============
(function (w) {
  // --- config: sesuaikan ikut projek anda ---
  const SB_URL = "https://dduizetstqqjrpsezbpi.supabase.co";
  const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdWl6ZXRzdHFxanJwc2V6YnBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg3MzI0ODQsImV4cCI6MjA3NDMwODQ4NH0.CrlHXrmHtKgR9qc2192U6quRb5lpFEeOSgwG0Lb8KRM";

  // --- init supabase client sekali sahaja (elak multiple GoTrue) ---
  const sb = (function () {
    if (!w.supabase || !w.supabase.createClient) return null;
    if (w.__sb) return w.__sb;                        // guna semula jika dah ada
    w.__sb = w.supabase.createClient(SB_URL, SB_KEY); // cipta sekali, simpan global
    return w.__sb;
  })();

  // --- util ---
  const norm = (msisdn) => {
    if (!msisdn) return null;
    let s = ("" + msisdn).trim();
    if (s.startsWith("+60")) return s;
    if (s.startsWith("601")) return "+" + s;
    if (s.startsWith("0")) return "+60" + s.slice(1);
    return s; // biar apa ada
  };

  async function getSession() {
    try {
      // auth.js simpan {name, phone, ...}
      const a = (w.auth_get && w.auth_get()) || null;
      return a || null;
    } catch { return null; }
  }

  async function isActiveAdmin(phone) {
    if (!sb) return false;
    const p = norm(phone);
    if (!p) return false;

    try {
      const { data, error } = await sb.rpc('check_admin_by_phone', { p_phone: p });
      if (error) { console.warn('[admin-guard] rpc error:', error.message); return false; }
      return (data === true || data === 't' || data === 'true' || data === 1);
    } catch (e) {
      console.warn('[admin-guard] rpc ex:', e);
      return false;
    }
  }

  async function requireAdmin(opts = {}) {
    const {
      onChecking, onDenied, onAllowed,
      redirectIfNoLogin = "login.html#login",
      redirectIfNotAdmin = "index.html"
    } = opts;

    onChecking?.();

    const a = await getSession();
    if (!a) {
      if (redirectIfNoLogin) location.href = redirectIfNoLogin;
      onDenied?.("not_logged_in");
      return false;
    }

    const phone = norm(a.phone || a.msisdn || a.username || "");
    if (!phone) {
      if (redirectIfNoLogin) location.href = redirectIfNoLogin;
      onDenied?.("no_phone");
      return false;
    }

    const ok = await isActiveAdmin(phone);
    if (!ok) {
      if (redirectIfNotAdmin) location.href = redirectIfNotAdmin;
      onDenied?.("not_admin");
      return false;
    }

    onAllowed?.(phone);
    return true;
  }

  async function actorPhone() {
    const a = await getSession();
    return norm(a?.phone || a?.msisdn || a?.username || "");
  }

  w.adminGuard = { require: requireAdmin, actorPhone, norm, sb };
})(window);
// =============== /admin-guard.js ===============