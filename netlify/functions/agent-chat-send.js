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

async function getAgentStrict(supabase, agentUserId, agentSlug) {
  const { data, error } = await supabase
    .from("agents")
    .select("id,user_id,slug,status,agent_code,name")
    .eq("user_id", String(agentUserId || ""))
    .eq("slug", String(agentSlug || ""))
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getCustomersUnderAgent(supabase, agentSlug) {
  const { data, error } = await supabase
    .from("customers")
    .select("id,name,customer_name,phone,agent_slug,ref_agent_slug,created_at")
    .or(`agent_slug.eq.${agentSlug},ref_agent_slug.eq.${agentSlug}`)
    .limit(1000);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const byPhone = {};

  for (const row of rows) {
    const p = normalizePhone(row?.phone || "");
    if (!p) continue;

    if (!byPhone[p]) {
      byPhone[p] = {
        id: row?.id ? String(row.id) : "",
        name: String(row?.customer_name || row?.name || "Customer").trim() || "Customer",
        created_at: row?.created_at || null
      };
    }
  }

  return { byPhone };
}

function sanitizeAttachment(att) {
  if (!att || typeof att !== "object") return null;

  const url = String(att.url || "").trim();
  if (!url) return null;

  return {
    url,
    name: String(att.name || "Fail").trim() || "Fail",
    mime: String(att.mime || "application/octet-stream").trim() || "application/octet-stream"
  };
}

async function buildReplyPreview(supabase, threadId, replyToMessageId) {
  if (!replyToMessageId) return null;

  const replyQ = await supabase
    .from("chat_messages")
    .select("id,role,text,meta")
    .eq("thread_id", threadId)
    .eq("id", replyToMessageId)
    .maybeSingle();

  if (replyQ.error) throw replyQ.error;
  if (!replyQ.data) return null;

  const src = replyQ.data;
  const srcMeta = src.meta || {};

  let roleLabel = "Mesej";
  if (String(src.role || "").toLowerCase() === "customer") {
    roleLabel = "Customer";
  } else if (String(src.role || "").toLowerCase() === "agent") {
    roleLabel = "Agen";
  } else if (srcMeta.admin_reply === true || String(src.role || "").toLowerCase() === "admin") {
    roleLabel = "Admin";
  } else if (String(src.role || "").toLowerCase() === "system") {
    roleLabel = "System";
  } else {
    roleLabel = "AI";
  }

  return {
    id: src.id,
    role: src.role || "",
    role_label: roleLabel,
    text: String(src.text || "").trim() || "(lampiran)"
  };
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

    const agentUserId = String(body.agent_user_id || "").trim();
    const agentSlug = String(body.agent_slug || "").trim();
    const threadId = String(body.thread_id || "").trim();
    const message = String(body.message || "").trim();
    const attachment = sanitizeAttachment(body.attachment || null);
    const replyToMessageId = String(body.reply_to_message_id || "").trim();

    if (!agentUserId || !agentSlug || !threadId) {
      return json(400, { ok: false, error: "agent_user_id, agent_slug, thread_id diperlukan." });
    }

    if (!message && !attachment) {
      return json(400, { ok: false, error: "Mesej atau attachment diperlukan." });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const agent = await getAgentStrict(supabase, agentUserId, agentSlug);
    if (!agent) {
      return json(403, { ok: false, error: "Akses agen ditolak." });
    }

    const threadQ = await supabase
      .from("chat_threads")
      .select("id,customer_phone,meta")
      .eq("id", threadId)
      .single();

    if (threadQ.error) throw threadQ.error;

    const customerPhone = normalizePhone(threadQ.data?.customer_phone || "");
    const metaNow = (threadQ.data?.meta && typeof threadQ.data.meta === "object")
      ? threadQ.data.meta
      : {};

    const custPack = await getCustomersUnderAgent(supabase, agentSlug);
    const allowedCustomer = custPack.byPhone[customerPhone] || null;

    if (!allowedCustomer) {
      return json(403, { ok: false, error: "Thread ini bukan customer bawah agen ini." });
    }

    let replyPreview = null;

    if (replyToMessageId) {
      replyPreview = await buildReplyPreview(supabase, threadId, replyToMessageId);
    }

    const insertPayload = {
      thread_id: threadId,
      role: "agent",
      text: message || "(lampiran)",
      meta: {
        agent_reply: true,
        sent_by_agent_user_id: agentUserId,
        sent_by_agent_slug: agentSlug,
        sent_by_agent_id: agent.id,
        sent_by_agent_name: agent.name || agent.agent_code || "Agen",
        reply_to: replyToMessageId || null,
        reply_preview: replyPreview,
        attachment: attachment ? {
          url: attachment.url || "",
          name: attachment.name || "",
          mime: attachment.mime || ""
        } : null
      }
    };

    const ins = await supabase
      .from("chat_messages")
      .insert(insertPayload)
      .select("id,thread_id,role,text,created_at,meta")
      .single();

    if (ins.error) throw ins.error;

    const agentSentAt = ins.data?.created_at || new Date().toISOString();

    const nextMeta = {
      ...metaNow,
      last_agent_reply_at: agentSentAt,
      last_agent_slug: agent.slug,
      last_agent_id: agent.id
    };

    const up = await supabase
      .from("chat_threads")
      .update({
        last_message_at: agentSentAt,
        meta: nextMeta
      })
      .eq("id", threadId);

    if (up.error) throw up.error;

    return json(200, {
      ok: true,
      message: ins.data
    });

  } catch (e) {
    console.error("agent-chat-send error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};