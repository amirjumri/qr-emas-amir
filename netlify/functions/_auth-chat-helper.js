const { createClient } = require("@supabase/supabase-js");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) {
    d = "65" + d;
  }

  const isMY = d.startsWith("60") && (d.length === 11 || d.length === 12);
  const isSG = d.startsWith("65") && d.length === 10;

  if (!isMY && !isSG) return "";
  return d;
}

function buildPhoneCandidates(raw) {
  const norm = normalizePhone(raw);
  if (!norm) return [];

  const out = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };

  add(norm);

  if (norm.startsWith("60") && norm.length >= 11) {
    add("0" + norm.slice(2));
  }

  if (norm.startsWith("0") && norm.length >= 10) {
    add("60" + norm.slice(1));
  }

  return out;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    "";

  if (!url || !key) {
    throw new Error("Supabase env belum lengkap (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }

  return createClient(url, key);
}

async function getOrCreateThread(supabase, { phone, threadId = null, status = "OPEN", meta = {} }) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) throw new Error("Phone tidak sah.");

  let thread = null;

  if (threadId) {
    const q = await supabase
      .from("chat_threads")
      .select("id,status,customer_phone,meta,created_at,last_message_at,last_customer_seen_at")
      .eq("id", threadId)
      .eq("customer_phone", cleanPhone)
      .maybeSingle();

    if (q.error) throw q.error;
    thread = q.data || null;
  }

  if (!thread) {
    const q = await supabase
      .from("chat_threads")
      .select("id,status,customer_phone,meta,created_at,last_message_at,last_customer_seen_at")
      .eq("customer_phone", cleanPhone)
      .order("created_at", { ascending: false })
      .limit(1);

    if (q.error) throw q.error;
    thread = (q.data && q.data[0]) ? q.data[0] : null;
  }

  if (!thread) {
    const ins = await supabase
      .from("chat_threads")
      .insert({
        customer_phone: cleanPhone,
        status: status || "OPEN",
        meta: meta || {}
      })
      .select("id,status,customer_phone,meta,created_at,last_message_at,last_customer_seen_at")
      .single();

    if (ins.error) throw ins.error;
    thread = ins.data;
  }

  return thread;
}

async function insertAiMessage(supabase, { threadId, text, meta = {} }) {
  const cleanText = String(text || "").trim();
  if (!threadId) throw new Error("threadId diperlukan.");
  if (!cleanText) throw new Error("text kosong.");

  const ins = await supabase
    .from("chat_messages")
    .insert({
      thread_id: threadId,
      role: "ai",
      text: cleanText,
      meta: meta || {}
    })
    .select("id,thread_id,role,text,created_at,meta")
    .single();

  if (ins.error) throw ins.error;

  await supabase
    .from("chat_threads")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", threadId);

  return ins.data;
}

module.exports = {
  corsHeaders,
  json,
  normalizePhone,
  buildPhoneCandidates,
  getSupabaseAdmin,
  getOrCreateThread,
  insertAiMessage
};