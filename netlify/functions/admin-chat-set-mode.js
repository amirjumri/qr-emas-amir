const { createClient } = require("@supabase/supabase-js");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;
  return d;
}

function phoneVariants(e164) {
  const d = normalizePhone(e164);
  if (!d) return [];
  const out = new Set([d, "+" + d]);
  if (d.startsWith("60")) out.add("0" + d.slice(2));
  return Array.from(out);
}

async function verifyAdmin(supabase, adminPhone) {
  const p = normalizePhone(adminPhone);
  if (!p) return false;

  const variants = phoneVariants(p);

  const q = await supabase
    .from("admin_users")
    .select("phone,is_active")
    .in("phone", variants)
    .eq("is_active", true)
    .limit(1);

  return !q.error && Array.isArray(q.data) && q.data.length > 0;
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Body JSON tak sah" });
    }

    const adminPhone = body.admin_phone || "";
    const threadId = String(body.thread_id || "").trim();
    const targetMode = body.admin_mode === true;

    if (!threadId) {
      return json(400, { ok: false, error: "thread_id diperlukan" });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      serviceKey
    );

    const isAdmin = await verifyAdmin(supabase, adminPhone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    // ambil thread + meta lama
    const th = await supabase
      .from("chat_threads")
      .select("id,meta")
      .eq("id", threadId)
      .single();

    if (th.error) throw th.error;

    const metaNow = (th.data?.meta && typeof th.data.meta === "object")
      ? th.data.meta
      : {};

    const oldMode = metaNow.admin_mode === true;

    // kalau mode sama, tak perlu spam system message
    if (oldMode === targetMode) {
      return json(200, {
        ok: true,
        admin_mode: targetMode,
        unchanged: true
      });
    }

    const nextMeta = {
      ...metaNow,
      admin_mode: targetMode,
      admin_mode_changed_at: new Date().toISOString(),
      admin_mode_changed_by: normalizePhone(adminPhone) || null
    };

    // bila kembali AI, buang manual waiting supaya status auto jalan semula
    if (!targetMode && nextMeta.admin_manual_status) {
      delete nextMeta.admin_manual_status;
      delete nextMeta.admin_manual_status_at;
      delete nextMeta.admin_manual_status_by;
    }

    const up = await supabase
      .from("chat_threads")
      .update({
        meta: nextMeta,
        last_message_at: new Date().toISOString()
      })
      .eq("id", threadId);

    if (up.error) throw up.error;

    const systemText = targetMode
      ? "🟠 MODE: ADMIN MANUAL\nAdmin sedang balas chat ini."
      : "🟢 MODE: KEMBALI AI\nAI sudah aktif semula.";

    const systemKey = targetMode ? "admin_mode_on" : "admin_mode_off";

    const ins = await supabase
      .from("chat_messages")
      .insert({
        thread_id: threadId,
        role: "system",
        text: systemText,
        meta: {
          system: systemKey,
          changed_by_admin_phone: normalizePhone(adminPhone) || null
        }
      });

    if (ins.error) throw ins.error;

    return json(200, {
      ok: true,
      admin_mode: targetMode
    });

  } catch (e) {
    console.error("admin-chat-set-mode error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};