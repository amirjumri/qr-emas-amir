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

function isValidSubscription(sub) {
  if (!sub || typeof sub !== "object") return false;
  if (!sub.endpoint || typeof sub.endpoint !== "string") return false;
  if (!sub.keys || typeof sub.keys !== "object") return false;
  if (!sub.keys.p256dh || !sub.keys.auth) return false;
  return true;
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

    const rawPhone = body.phone || "";
    const threadId = String(body.thread_id || "").trim() || null;
    const subscription = body.subscription || null;
    const userAgent = String(body.user_agent || "").trim() || null;

    const phone = normalizePhone(rawPhone);

    if (!phone) {
      return json(400, { ok: false, error: "phone diperlukan" });
    }

    if (!isValidSubscription(subscription)) {
      return json(400, { ok: false, error: "subscription tak sah" });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const payload = {
      customer_phone: phone,
      thread_id: threadId,
      endpoint: String(subscription.endpoint || ""),
      p256dh: String(subscription.keys?.p256dh || ""),
      auth: String(subscription.keys?.auth || ""),
      user_agent: userAgent,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    // cuba update dulu kalau endpoint dah wujud
    const existingQ = await supabase
      .from("chat_push_subscriptions")
      .select("id")
      .eq("endpoint", payload.endpoint)
      .limit(1)
      .maybeSingle();

    if (existingQ.error) throw existingQ.error;

    if (existingQ.data?.id) {
      const up = await supabase
        .from("chat_push_subscriptions")
        .update(payload)
        .eq("id", existingQ.data.id)
        .select("id")
        .single();

      if (up.error) throw up.error;

      return json(200, {
        ok: true,
        mode: "updated",
        id: up.data.id
      });
    }

    const ins = await supabase
      .from("chat_push_subscriptions")
      .insert({
        ...payload,
        created_at: new Date().toISOString()
      })
      .select("id")
      .single();

    if (ins.error) throw ins.error;

    return json(200, {
      ok: true,
      mode: "inserted",
      id: ins.data.id
    });

  } catch (e) {
    console.error("chat-push-subscribe error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};