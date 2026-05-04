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
    const messageId = String(body.message_id || "").trim();
    const reaction = String(body.reaction || "").trim();
    const comment = body.comment != null ? String(body.comment).trim() : null;

    if (!threadId || !messageId) {
      return json(400, { ok: false, error: "thread_id & message_id diperlukan." });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    // ✅ verify admin
    const isAdmin = await verifyAdmin(supabase, adminPhone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    // ✅ ambil message sedia ada
    const msgQ = await supabase
      .from("chat_messages")
      .select("id,meta")
      .eq("id", messageId)
      .eq("thread_id", threadId)
      .single();

    if (msgQ.error) throw msgQ.error;

    const existingMeta = msgQ.data?.meta || {};

    let newMeta = { ...existingMeta };

    // =========================
    // REACTION
    // =========================
    if (reaction) {
      let arr = Array.isArray(newMeta.admin_reactions)
        ? newMeta.admin_reactions.slice()
        : [];

      if (arr.includes(reaction)) {
        // toggle off (remove)
        arr = arr.filter(x => x !== reaction);
      } else {
        arr.push(reaction);
      }

      newMeta.admin_reactions = arr;
    }

    // =========================
    // COMMENT
    // =========================
    if (comment !== null) {
      newMeta.admin_comment = comment;
    }

    // =========================
    // UPDATE
    // =========================
    const up = await supabase
      .from("chat_messages")
      .update({
        meta: newMeta
      })
      .eq("id", messageId)
      .eq("thread_id", threadId);

    if (up.error) throw up.error;

    return json(200, {
      ok: true,
      meta: newMeta
    });

  } catch (e) {
    console.error("admin-chat-message-react error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};