import { createClient } from "@supabase/supabase-js";

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

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const body = JSON.parse(event.body || "{}");
    const thread_id = body.thread_id || null;

    if (!thread_id) {
      return json(400, { ok: false, error: "thread_id required" });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || "";
    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const q = await supabase
      .from("chat_messages")
      .select("id, role, text, created_at, meta")
      .eq("thread_id", thread_id)
      .order("created_at", { ascending: true })
      .limit(200);

    if (q.error) throw q.error;

    return json(200, { ok: true, messages: q.data || [] });
  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}