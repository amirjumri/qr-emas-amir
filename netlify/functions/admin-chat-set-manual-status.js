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
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json"
    },
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
    const manualStatusRaw = String(body.manual_status || "").trim().toUpperCase();

    if (!threadId) {
      return json(400, { ok: false, error: "thread_id diperlukan." });
    }

    const allowed = ["", "NONE", "WAITING"];
    if (!allowed.includes(manualStatusRaw)) {
      return json(400, {
        ok: false,
        error: "manual_status tak sah. Guna WAITING atau NONE."
      });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const isAdmin = await verifyAdmin(supabase, adminPhone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    const thQ = await supabase
      .from("chat_threads")
      .select("id,meta")
      .eq("id", threadId)
      .single();

    if (thQ.error) throw thQ.error;

    const metaNow = (thQ.data && typeof thQ.data.meta === "object" && thQ.data.meta)
      ? thQ.data.meta
      : {};

    const nextMeta = { ...metaNow };

    if (manualStatusRaw === "WAITING") {
      nextMeta.admin_manual_status = "WAITING";
      nextMeta.admin_manual_status_at = new Date().toISOString();
      nextMeta.admin_manual_status_by = normalizePhone(adminPhone) || "";
    } else {
      delete nextMeta.admin_manual_status;
      delete nextMeta.admin_manual_status_at;
      delete nextMeta.admin_manual_status_by;
    }

    const up = await supabase
      .from("chat_threads")
      .update({
        meta: nextMeta
      })
      .eq("id", threadId)
      .select("id,meta")
      .single();

    if (up.error) throw up.error;

    return json(200, {
      ok: true,
      thread_id: threadId,
      manual_status: manualStatusRaw === "WAITING" ? "WAITING" : null,
      meta: up.data?.meta || {}
    });

  } catch (e) {
    console.error("admin-chat-set-manual-status error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};