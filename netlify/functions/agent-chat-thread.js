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

function sanitizeTextForAgent(text) {
  let out = String(text || "");

  out = out.replace(/\b(?:\+?60|0)\d{8,10}\b/g, "[Nombor telefon disembunyikan]");
  out = out.replace(/\b65\d{8}\b/g, "[Nombor telefon disembunyikan]");

  if (/otp|verification code|reset password|kod pengesahan/i.test(out)) {
    return "[Maklumat sensitif disembunyikan]";
  }

  out = out.replace(/alamat/gi, "[Alamat disembunyikan]");
  out = out.replace(/postcode/gi, "[Alamat disembunyikan]");
  out = out.replace(/poskod/gi, "[Alamat disembunyikan]");

  return out;
}

function sanitizeMetaForAgent(meta) {
  const m = (meta && typeof meta === "object")
    ? JSON.parse(JSON.stringify(meta))
    : {};

  delete m.admin_comment;
  delete m.admin_reactions;
  delete m.internal_note;
  delete m.staff_note;
  delete m.customer_phone;
  delete m.address;
  delete m.full_address;
  delete m.email;
  delete m.ic;
  delete m.identity_no;
  delete m.payment_reference;
  delete m.bank_ref;
  delete m.secret;
  delete m.otp_code;
  delete m.admin_only;
  delete m.flags;
  delete m.manual_status;
  delete m.paid_chat_order_refs;

  if (m.reply_preview && typeof m.reply_preview === "object") {
    m.reply_preview = {
      ...m.reply_preview,
      text: sanitizeTextForAgent(m.reply_preview.text || "")
    };
  }

  if (m.attachment && typeof m.attachment === "object") {
    m.attachment = {
      url: String(m.attachment.url || ""),
      name: String(m.attachment.name || "Fail"),
      mime: String(m.attachment.mime || "")
    };
  }

  return m;
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

    if (!agentUserId || !agentSlug || !threadId) {
      return json(400, { ok: false, error: "agent_user_id, agent_slug, thread_id diperlukan." });
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
      .select("id,status,customer_phone,last_message_at,created_at,meta,last_admin_message_at,last_customer_message_at,last_customer_seen_at")
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

    const custPack = await getCustomersUnderAgent(supabase, agentSlug);
    const phoneKey = normalizePhone(thread.customer_phone || "");
    const allowedCustomer = custPack.byPhone[phoneKey] || null;

    if (!allowedCustomer) {
      return json(403, { ok: false, error: "Thread ini bukan customer bawah agen ini." });
    }

    let customer = {
      id: allowedCustomer.id || "",
      name: allowedCustomer.name || "Customer"
    };

    const variants = phoneVariants(thread.customer_phone);
    if (variants.length) {
      const cQ = await supabase
        .from("customers")
        .select("id,name,customer_name,phone")
        .in("phone", variants)
        .limit(1)
        .maybeSingle();

      if (cQ.error) throw cQ.error;

      if (cQ.data) {
        customer = {
          id: String(cQ.data.id || ""),
          name: String(cQ.data.customer_name || cQ.data.name || "Customer").trim() || "Customer"
        };
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
            text: sanitizeTextForAgent(x.text || ""),
            created_at: x.created_at,
            meta: sanitizeMetaForAgent((x.meta && typeof x.meta === "object") ? x.meta : {})
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
        text: sanitizeTextForAgent(m.text || ""),
        created_at: m.created_at,
        meta: sanitizeMetaForAgent({
          ...meta,
          reply_preview: replyToId ? (replyMap[replyToId] || null) : null
        })
      };
    });

    return json(200, {
      ok: true,
      thread: {
        id: thread.id,
        status: thread.status || "OPEN",
        customer_phone: "",
        last_message_at: thread.last_message_at || null,
        created_at: thread.created_at || null,
        last_admin_message_at: thread.last_admin_message_at || null,
        last_customer_message_at: thread.last_customer_message_at || null,
        last_customer_seen_at: thread.last_customer_seen_at || null,
        meta: {}
      },
      customer,
      messages
    });

  } catch (e) {
    console.error("agent-chat-thread error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};