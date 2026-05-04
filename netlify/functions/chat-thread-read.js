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
      "Content-Type": "application/json; charset=utf-8"
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

    const phone = normalizePhone(body.phone || "");
    const threadId = String(body.thread_id || "").trim();

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

    const threadQ = await supabase
      .from("chat_threads")
      .select("id,status,customer_phone,last_message_at,created_at,meta")
      .eq("id", threadId)
      .single();

    if (threadQ.error || !threadQ.data) {
      return json(404, { ok: false, error: "Thread tak dijumpai." });
    }

    const thread = threadQ.data;
    const allowedPhones = phoneVariants(thread.customer_phone);

    if (!allowedPhones.includes(phone) && !allowedPhones.includes("+" + phone)) {
      return json(403, { ok: false, error: "Thread ini bukan milik nombor ini." });
    }

    const msgQ = await supabase
      .from("chat_messages")
      .select("id,thread_id,role,text,created_at,meta")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true })
      .limit(1000);

    if (msgQ.error) {
      throw msgQ.error;
    }

    const messages = (msgQ.data || []).map(m => ({
      id: m.id,
      thread_id: m.thread_id,
      role: m.role,
      text: m.text || "",
      created_at: m.created_at,
      meta: m.meta || {}
    }));

    return json(200, {
      ok: true,
      thread,
      messages
    });
  } catch (e) {
    console.error("chat-thread-read error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};