<!-- auth.js – Emas Amir (v13.1) -->

(function () {
  "use strict";
  console.log("[auth_js] v13.1 start");

  /* ===== 0) KONFIG SUPABASE ===== */
  const SB_URL = "https://dduizetstqqjrpsezbpi.supabase.co";
  const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdWl6ZXRzdHFxanJwc2V6YnBpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg3MzI0ODQsImV4cCI6MjA3NDMwODQ4NH0.CrlHXrmHtKgR9qc2192U6quRb5lpFEeOSgwG0Lb8KRM";

  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.warn("[auth_js] Supabase library not loaded!");
    window.sb = null;
  } else {
    try {
      // ⬇️ MINIMAL CHANGE: gunakan singleton supaya tak wujud multiple GoTrue
      window.__sb = window.__sb || window.supabase.createClient(SB_URL, SB_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      window.sb = window.__sb; // kekalkan alias asal
      console.log("[auth_js] Supabase client ready ✅");
    } catch (e) {
      console.error("[auth_js] Supabase client create failed ❌:", e);
      window.sb = null;
    }
  }

  /* ===== 1) LocalStorage utils ===== */
  const LS_USER = "emasamir_user";
  const LS_USED_REFS = "emasamir_used_refs";

  const jget = (k, fb) => { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : fb; } catch { return fb; } };
  const jset = (k, v)   => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  /* ===== 2) Helpers ===== */
  function onlyDigits(s) { return String(s || "").replace(/\D+/g, ""); }

  // WhatsApp opener
  function wa_open(phone, message) {
    const num = onlyDigits(phone || "");
    const msg = encodeURIComponent(String(message || ""));
    window.open(`https://wa.me/${num}?text=${msg}`, "_blank");
  }

  // Simpan/semak rujukan yang telah digunakan
  const used_refs_all = () => jget(LS_USED_REFS, []);
  const used_refs_has = (ref) => !!ref && used_refs_all().includes(ref);
  function used_refs_add(ref){
    if (!ref) return;
    const list = used_refs_all();
    if (!list.includes(ref)) { list.push(ref); jset(LS_USED_REFS, list); }
  }

  /* ===== 3) Session (client-side) ===== */
  const auth_get    = () => jget(LS_USER, null);
  const auth_set    = (u) => jset(LS_USER, u);
  const auth_clear  = () => localStorage.removeItem(LS_USER);
  const is_logged_in= () => !!auth_get();

  /* ===== 4D) ➕ PASTIKAN ADA SESI JWT SUPABASE ===== */
  async function ensureSupabaseSession(phone, password, allowSignup){
    try{
      if(!window.sb?.auth) return;

      // kalau tak pass password, cuba ambil dari sessionStorage (kalau wujud)
      if(!password){
        try { password = sessionStorage.getItem("ea_pw") || ""; } catch {}
      }

      if(!password || password.length < 6){
        console.warn("[auth_js] ensureSupabaseSession: password kosong/tak sah");
        return;
      }

      const d = onlyDigits(phone || "");
      if (!d) {
        console.warn("[auth_js] ensureSupabaseSession: phone kosong");
        return;
      }

      // kalau dah ada session, tak perlu buat apa2
      try{
        const cur = await window.sb.auth.getSession();
        if (cur?.data?.session){
          console.log("[auth_js] ensureSupabaseSession: session already exists ✅");
          return;
        }
      }catch{}

      // ===== bina candidate phone (0xxxxxxxxx & 60xxxxxxxxxx) =====
      const candidates = [];
      const add = (x) => {
        if (!x) return;
        const y = String(x);
        if (!candidates.includes(y)) candidates.push(y);
      };

      add(d);

      // kalau bermula 60 -> tambah versi 0xxxxxxxxx
      if (d.startsWith("60") && d.length >= 11){
        add("0" + d.slice(2));
      }

      // kalau bermula 0 -> tambah versi 60xxxxxxxxxx
      if (d.startsWith("0") && d.length >= 10){
        add("60" + d.slice(1));
      }

      // kalau user taip tanpa 0/60 (rare) -> tambah kedua-dua
      if (!d.startsWith("0") && !d.startsWith("60")){
        add("0" + d);
        add("60" + d);
      }

      const emails = candidates.map(x => `${x}@emasamir.app`);
      console.log("[auth_js] ensureSupabaseSession candidates =", { phone: d, emails });

      // ===== 1) cuba sign-in ikut semua email candidate =====
      let allInvalid = true;

      for (const email of emails){
        const { data, error } = await window.sb.auth.signInWithPassword({ email, password });

        if (!error && data?.session){
          console.log("[auth_js] ensureSupabaseSession OK (signin) =>", email);
          return;
        }

        if (error && /Invalid login credentials/i.test(error.message)){
          // salah password / email mismatch → cuba email lain
          continue;
        }

        // kalau error lain (rate limit, network, dsb), jangan terus buat signup
        allInvalid = false;
        if (error) throw error;
      }

      // ===== 2) kalau semua invalid creds =====
      if (allInvalid && !allowSignup){
        console.warn("[auth_js] ensureSupabaseSession fail: Invalid login credentials (no signup in LOGIN flow)");
        return;
      }

      // ===== 3) signup HANYA untuk flow REGISTER =====
      if (!allowSignup){
        return;
      }

      // Canonical: utamakan format 0xxxxxxxxx
      const canonicalPhone =
        (d.startsWith("60") && d.length >= 11) ? ("0" + d.slice(2)) :
        (d.startsWith("0")) ? d :
        ("0" + d);

      const canonicalEmail = `${canonicalPhone}@emasamir.app`;

      const su = await window.sb.auth.signUp({ email: canonicalEmail, password });
      if (su?.error){
        const msg = String(su.error.message || su.error);
        if (!/already registered|already exists|User already registered/i.test(msg)){
          throw su.error;
        }
      }

      const si = await window.sb.auth.signInWithPassword({ email: canonicalEmail, password });
      if (si?.error) throw si.error;

      const s = await window.sb.auth.getSession();
      if (!s?.data?.session) throw new Error("Supabase session missing");

      console.log("[auth_js] ensureSupabaseSession OK (signup/signin) =>", canonicalEmail);

    }catch(e){
      console.warn("[auth_js] ensureSupabaseSession fail:", e?.message||e);
    }
  }

  // ===== 4E) ⭐ BARU: Sync agent_slug selepas login/daftar TERUS ke jadual customers =====
  async function syncAgentAfterAuth(phone){
    try{
      if (!window.sb) return;

      // Ambil slug agen daripada agent-ref.js (localStorage)
      const slug = (window.EmasAmirAgent && typeof window.EmasAmirAgent.getRef === "function")
        ? window.EmasAmirAgent.getRef()
        : null;

      if (!slug) return; // tiada ref agen → abaikan

      const cleanPhone = onlyDigits(phone);
      if (!cleanPhone) return;

      console.log("[auth_js] syncAgentAfterAuth =>", { phone: cleanPhone, slug });

      // Update TERUS ke jadual customers
      // Hanya set kalau agent_slug masih NULL (lock bawah agen pertama sahaja)
      const { error } = await window.sb
        .from("customers")
        .update({ agent_slug: slug })
        .eq("phone", cleanPhone)
        .is("agent_slug", null);  // jangan override kalau dah ada

      if (error){
        console.warn("[auth_js] syncAgentAfterAuth error:", error.message || error);
      } else {
        console.log("[auth_js] syncAgentAfterAuth OK (customers.agent_slug dikemas kini)");
      }
    }catch(e){
      console.warn("[auth_js] syncAgentAfterAuth exception:", e);
    }
  }

  /* ===== 4) RPC helpers ===== */

  // 4A) Login menggunakan password
  async function login_password(phone, password) {
    if (!window.sb) return { ok:false, error:"Supabase tidak dikonfigurasi" };
    try {
      const { data, error } = await window.sb.rpc("login_password", {
        in_phone: phone,
        in_password: password
      });
      if (error) return { ok:false, error:error.message };

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { ok:false, error:"Login gagal" };

      auth_set({ id:row.id, name:row.name, phone:row.phone, ic:row.ic, alamat:row.alamat });
      try { sessionStorage.setItem("ea_pw", password); } catch {}

      // ➕ pastikan Supabase Auth ada sesi JWT (elak redirect bila tekan Beli)
      await ensureSupabaseSession(phone, password, false);
      await syncAgentAfterAuth(phone);

      return { ok:true, data:row };
    } catch (e) {
      return { ok:false, error:String(e) };
    }
  }

  // 4B) Daftar baharu + set password (OTP sebagai TEXT)
  async function register_finish({ phone, name, ic, alamat, otp, password }) {
    if (!window.sb) return { ok:false, error:"Supabase tidak dikonfigurasi" };

    try {
      const { data, error } = await window.sb.rpc("register_finish_v2", {
        in_phone:    phone,
        in_name:     name    || "",
        in_ic:       ic      || "",
        in_alamat:   alamat  || "",
        in_otp:      String(otp || ""),
        in_password: password
      });

      if (error) {
        console.log("[auth_js] register_finish_v2 error =", error);
        return { ok:false, error: error.message };
      }

      console.log("[auth_js] register_finish_v2 raw =", data);

      let row = null;

      // 1) Kalau SQL return array of record (TABLE customer_id, name, phone…)
      if (Array.isArray(data) && data.length) {
        row = data[0];
      }
      // 2) Kalau SQL return satu object
      else if (data && typeof data === "object") {
        row = data;
      }
      // 3) Kalau SQL return STRING uuid sahaja
      else if (typeof data === "string") {
        row = {
          id:     data,
          name:   name   || phone,
          phone:  phone,
          ic:     ic     || "",
          alamat: alamat || ""
        };
      }

      if (!row) {
        return { ok:false, error:"Daftar gagal (tiada data daripada SQL)." };
      }

      // ⚠️ NORMALIZE: guna customer_id kalau tiada id
      const finalId = row.id || row.customer_id;
      if (!finalId) {
        console.warn("[auth_js] register_finish_v2: tiada id / customer_id dalam row =", row);
        return { ok:false, error:"Daftar gagal (tiada ID pelanggan)." };
      }

      const finalUser = {
        id:     finalId,
        name:   row.name   || name   || phone,
        phone:  row.phone  || phone,
        ic:     row.ic     ?? ic,
        alamat: row.alamat ?? alamat
      };

      // Simpan session local
      auth_set(finalUser);
      try { sessionStorage.setItem("ea_pw", password); } catch {}

      // Wujudkan sesi Supabase Auth (JWT) — allowSignup=true untuk user baru
      await ensureSupabaseSession(phone, password, true);

      // Sync agent_slug jika ada ref /a/xxx
      await syncAgentAfterAuth(phone);

      return { ok:true, data: finalUser };
    } catch (e) {
      console.warn("[auth_js] register_finish exception =", e);
      return { ok:false, error: String(e) };
    }
  }

  /* ===== 5) Expose ke window ===== */
  window.onlyDigits      = onlyDigits;
  window.wa_open         = wa_open;
  window.used_refs_has   = used_refs_has;
  window.used_refs_add   = used_refs_add;

  window.auth_get        = auth_get;
  window.auth_set        = auth_set;
  window.auth_clear      = auth_clear;
  window.is_logged_in    = is_logged_in;

  window.sb_login_password = login_password;  // alias lama
  window.login_password    = login_password;  // alias mudah
  window.register_finish   = register_finish; // untuk halaman daftar

  // ➕ jika nak panggil dari page lain
  window.ensureSupabaseSession = ensureSupabaseSession;

  console.log("[auth_js] ready", { hasSB: !!window.sb });
})();