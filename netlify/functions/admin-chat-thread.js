const { createClient } = require("@supabase/supabase-js");

const MESSAGE_LIMIT = 120;

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

    const isAdmin = await verifyAdmin(supabase, adminPhone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    const threadQ = await supabase
      .from("chat_threads")
      .select("id,status,customer_phone,last_message_at,created_at,meta")
      .eq("id", threadId)
      .maybeSingle();

    if (threadQ.error) throw threadQ.error;
    if (!threadQ.data) {
      return json(404, { ok: false, error: "Thread tak dijumpai." });
    }

    const thread = {
      ...threadQ.data,
      meta: (threadQ.data.meta && typeof threadQ.data.meta === "object") ? threadQ.data.meta : {}
    };

    let customer = null;
    const variants = phoneVariants(thread.customer_phone);

    if (variants.length) {
      const cQ = await supabase
        .from("customers")
        .select("id,name,phone,alamat,postcode,city,state")
        .in("phone", variants)
        .limit(1)
        .maybeSingle();

      if (cQ.error) throw cQ.error;

      if (cQ.data) {
        customer = cQ.data;
      }
    }

    const msgQ = await supabase
      .from("chat_messages")
      .select("id,thread_id,role,text,created_at,meta")
      .eq("thread_id", threadId)
      .order("created_at", { ascending: false })
      .limit(MESSAGE_LIMIT);

    if (msgQ.error) throw msgQ.error;

    const rawMessages = Array.isArray(msgQ.data) ? msgQ.data.slice().reverse() : [];

    const replyIds = Array.from(
      new Set(
        rawMessages
          .map(m => String(m?.meta?.reply_to || "").trim())
          .filter(Boolean)
      )
    );

    let replyMap = {};

    if (replyIds.length) {
      const replyQ = await supabase
        .from("chat_messages")
        .select("id,thread_id,role,text,created_at,meta")
        .in("id", replyIds);

      if (replyQ.error) throw replyQ.error;

      replyMap = Object.fromEntries(
        (replyQ.data || []).map(x => [
          x.id,
          {
            id: x.id,
            thread_id: x.thread_id,
            role: x.role,
            text: x.text || "",
            created_at: x.created_at,
            meta: (x.meta && typeof x.meta === "object") ? x.meta : {}
          }
        ])
      );
    }

    const messages = rawMessages.map(m => {
      const meta = (m.meta && typeof m.meta === "object") ? m.meta : {};
      const replyToId = String(meta.reply_to || "").trim();

      return {
        id: m.id,
        thread_id: m.thread_id,
        role: m.role,
        text: m.text || "",
        created_at: m.created_at,
        meta: {
          ...meta,
          reply_preview: replyToId ? (replyMap[replyToId] || null) : null
        }
      };
    });

    return json(200, {
      ok: true,
      thread,
      customer,
      messages
    });

  } catch (e) {
    console.error("admin-chat-thread error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};