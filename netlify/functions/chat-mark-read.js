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

    const rawPhone = body.phone || body.customer_phone || "";
    const threadId = String(body.thread_id || "").trim();
    const source = String(body.source || "open").trim();

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return json(400, { ok: false, error: "phone diperlukan." });
    }

    if (!threadId) {
      return json(400, { ok: false, error: "thread_id diperlukan." });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const thQ = await supabase
      .from("chat_threads")
      .select("id,customer_phone,meta")
      .eq("id", threadId)
      .maybeSingle();

    if (thQ.error) throw thQ.error;

    if (!thQ.data) {
      return json(404, { ok: false, error: "Thread tak jumpa." });
    }

    const ownerPhone = normalizePhone(thQ.data.customer_phone || "");
    if (!ownerPhone || ownerPhone !== phone) {
      return json(403, { ok: false, error: "Akses thread ditolak." });
    }

    const nowIso = new Date().toISOString();
    const metaNow = thQ.data.meta || {};

    const nextMeta = {
      ...metaNow,
      customer_last_read_at: nowIso,
      customer_last_read_source: source || "open"
    };

   const up = await supabase
  .from("chat_threads")
  .update({
    last_customer_seen_at: nowIso,
    meta: nextMeta
  })
  .eq("id", threadId)
  .select("id,meta,last_customer_seen_at")
  .single();

    if (up.error) throw up.error;

    return json(200, {
  ok: true,
  thread_id: threadId,
  last_customer_seen_at: nowIso,
  source: source || "open"
});
  } catch (e) {
    console.error("chat-mark-read error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};