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
    const threadIdIn = String(body.thread_id || "").trim();

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return json(400, { ok: false, error: "phone diperlukan." });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    let thread = null;

    if (threadIdIn) {
      const q = await supabase
        .from("chat_threads")
        .select("id,status,customer_phone,last_message_at,last_customer_seen_at,created_at,meta")
        .eq("id", threadIdIn)
        .eq("customer_phone", phone)
        .maybeSingle();

      if (q.error) throw q.error;
      thread = q.data || null;
    }

    if (!thread) {
      const q = await supabase
        .from("chat_threads")
        .select("id,status,customer_phone,last_message_at,last_customer_seen_at,created_at,meta")
        .eq("customer_phone", phone)
        .order("created_at", { ascending: false })
        .limit(1);

      if (q.error) throw q.error;
      thread = (q.data && q.data[0]) ? q.data[0] : null;
    }

    if (!thread) {
      return json(200, {
        ok: true,
        thread: null,
        messages: []
      });
    }

   const msgQ = await supabase
  .from("chat_messages")
  .select("id,thread_id,role,text,created_at,meta")
  .eq("thread_id", thread.id)
  .order("created_at", { ascending: false })
  .limit(80);

if (msgQ.error) throw msgQ.error;

const messages = Array.isArray(msgQ.data) ? msgQ.data.slice().reverse() : [];

    return json(200, {
      ok: true,
      thread: {
        id: thread.id,
        status: thread.status || "OPEN",
        customer_phone: thread.customer_phone || phone,
        last_message_at: thread.last_message_at || null,
        last_customer_seen_at: thread.last_customer_seen_at || null,
        created_at: thread.created_at || null,
        meta: thread.meta || {}
      },
      messages: messages.map(m => ({
        id: m.id,
        thread_id: m.thread_id,
        role: m.role,
        text: m.text || "",
        created_at: m.created_at,
        meta: m.meta || {}
      }))
    });

  } catch (e) {
    console.error("chat-thread error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};