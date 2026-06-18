const { createClient } = require("@supabase/supabase-js");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(body)
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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type"
        },
        body: ""
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Supabase env missing" });
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const body = JSON.parse(event.body || "{}");
    const token = String(body.token || "").trim();

    let platform = String(body.platform || "").trim().toLowerCase();
    if (platform === "web") platform = "pwa";
    if (platform === "ios") platform = "ios";
    if (platform === "android") platform = "android";

    const token_type = platform === "android" ? "fcm" : "apns";

    const phone = normalizePhone(body.phone || "");
    const thread_id = body.thread_id || null;
    const user_agent = String(body.user_agent || "").trim();

    if (!token) {
      return json(400, { ok: false, error: "token required" });
    }

    if (!platform) {
      return json(400, { ok: false, error: "platform required" });
    }

    const payload = {
      device_token: token,
      platform,
      token_type,
      user_agent,
      is_active: true,
      updated_at: new Date().toISOString()
    };

    if (phone) {
      payload.customer_phone = phone;
    }

    if (thread_id) {
      payload.thread_id = thread_id;
    }

    const { error } = await sb
      .from("chat_device_tokens")
      .upsert(payload, {
        onConflict: "device_token"
      });

    if (error) {
      return json(500, { ok: false, error: error.message || "save failed" });
    }

    return json(200, {
      ok: true,
      anonymous: !phone,
      attached_phone: !!phone,
      attached_thread: !!thread_id
    });

  } catch (e) {
    return json(500, { ok: false, error: e.message || String(e) });
  }
};