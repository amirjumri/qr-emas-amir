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

async function verifyAdmin(supabase, adminPhone) {
  const p = normalizePhone(adminPhone);
  if (!p) return false;

  const q = await supabase
    .from("admin_users")
    .select("phone,is_active")
    .eq("phone", p)
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

    const { admin_phone, thread_id, manual_state } = body;

    if (!thread_id) {
      return json(400, { ok: false, error: "thread_id diperlukan" });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    // ✅ verify admin
    const isAdmin = await verifyAdmin(supabase, admin_phone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    // ✅ ambil thread
    const th = await supabase
      .from("chat_threads")
      .select("id,meta")
      .eq("id", thread_id)
      .single();

    if (th.error) throw th.error;

    const metaNow = th.data?.meta || {};

    // ✅ update manual status
    let newMeta = { ...metaNow };

    if (!manual_state) {
      // clear override
      delete newMeta.admin_manual_status;
    } else {
      newMeta.admin_manual_status = manual_state;
    }

    const up = await supabase
      .from("chat_threads")
      .update({ meta: newMeta })
      .eq("id", thread_id);

    if (up.error) throw up.error;

    // ✅ optional system message (nice UX)
    let systemText = "";

    if (manual_state === "WAITING") {
      systemText = "🟡 ADMIN SET: WAITING (manual)";
    } else if (!manual_state) {
      systemText = "⚪ ADMIN CLEAR: kembali auto status";
    }

    if (systemText) {
      await supabase
        .from("chat_messages")
        .insert({
          thread_id,
          role: "system",
          text: systemText,
          meta: { system: "manual_status" }
        });
    }

    // ✅ update last_message_at supaya list refresh
    await supabase
      .from("chat_threads")
      .update({
        last_message_at: new Date().toISOString()
      })
      .eq("id", thread_id);

    return json(200, {
      ok: true,
      manual_state: manual_state || null
    });

  } catch (e) {
    console.error("admin-chat-set-status error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};