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
    const phone = normalizePhone(body.phone || "");
    const platform = String(body.platform || "").trim().toLowerCase();
    const threadId = String(body.thread_id || "").trim();

    if (!phone || !platform) {
      return json(400, { ok: false, error: "phone and platform required" });
    }

    let query = sb
      .from("chat_device_tokens")
      .select("id", { count: "exact", head: false })
      .eq("customer_phone", phone)
      .eq("platform", platform)
      .eq("is_active", true)
      .limit(1);

    if (threadId) {
      query = query.eq("thread_id", threadId);
    }

    const { data, error } = await query;

    if (error) {
      return json(500, { ok: false, error: error.message || "query failed" });
    }

    return json(200, {
      ok: true,
      active: Array.isArray(data) && data.length > 0
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || String(e) });
  }
};