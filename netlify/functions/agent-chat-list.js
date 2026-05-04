const { createClient } = require("@supabase/supabase-js");

const THREAD_LIMIT = 120;
const LATEST_MSG_LIMIT = 800;

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

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function toTs(v) {
  const t = new Date(v || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function emptyCounts() {
  return {
    total: 0,
    unread: 0,
    read: 0,
    waiting_customer: 0
  };
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

  out = out.trim();
  if (!out) out = "(tiada mesej)";
  return out;
}

function sanitizeSnippet(text) {
  const clean = sanitizeTextForAgent(text);
  return clean.length > 140 ? (clean.slice(0, 137) + "...") : clean;
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
  const phones = [];

  for (const row of rows) {
    const p = normalizePhone(row?.phone || "");
    if (!p) continue;

    phones.push(p);

    if (!byPhone[p]) {
      byPhone[p] = {
        id: row?.id ? String(row.id) : "",
        name: String(row?.customer_name || row?.name || "Customer").trim() || "Customer",
        created_at: row?.created_at || null
      };
    }
  }

  return {
    rows,
    phones: uniq(phones),
    byPhone
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

    if (!agentUserId || !agentSlug) {
      return json(400, { ok: false, error: "agent_user_id dan agent_slug diperlukan." });
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

    const custPack = await getCustomersUnderAgent(supabase, agentSlug);
    const allowedPhones = custPack.phones || [];

    if (!allowedPhones.length) {
      return json(200, {
        ok: true,
        rows: [],
        counts: emptyCounts()
      });
    }

    const allCustomerVariants = new Set();
    for (const p of allowedPhones) {
      const vars = phoneVariants(p);
      vars.forEach(v => allCustomerVariants.add(v));
    }

    const customerPhoneVariants = Array.from(allCustomerVariants);

    const tQ = await supabase
      .from("chat_threads")
      .select(`
        id,
        status,
        customer_phone,
        last_message_at,
        created_at,
        meta,
        last_admin_message_at,
        last_customer_message_at,
        last_customer_seen_at
      `)
      .in("customer_phone", customerPhoneVariants)
      .order("last_message_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(THREAD_LIMIT);

    if (tQ.error) throw tQ.error;

    const rawThreads = Array.isArray(tQ.data) ? tQ.data : [];
    if (!rawThreads.length) {
      return json(200, {
        ok: true,
        rows: [],
        counts: emptyCounts()
      });
    }

    // dedupe ikut phone, ambil thread paling latest sahaja untuk setiap customer
    const latestThreadByPhone = {};
    for (const th of rawThreads) {
      const key = normalizePhone(th.customer_phone);
      if (!key) continue;
      if (!latestThreadByPhone[key]) {
        latestThreadByPhone[key] = th;
      }
    }

    const threads = Object.values(latestThreadByPhone);
    if (!threads.length) {
      return json(200, {
        ok: true,
        rows: [],
        counts: emptyCounts()
      });
    }

    const threadIds = threads.map(x => x.id).filter(Boolean);

    const latestMsgQ = await supabase
      .from("chat_messages")
      .select("id,thread_id,role,text,created_at,meta")
      .in("thread_id", threadIds)
      .order("created_at", { ascending: false })
      .limit(LATEST_MSG_LIMIT);

    if (latestMsgQ.error) throw latestMsgQ.error;

    const latestByThread = {};
    for (const m of (latestMsgQ.data || [])) {
      if (!latestByThread[m.thread_id]) {
        latestByThread[m.thread_id] = m;
      }
    }

    const rows = threads.map(th => {
      const phoneKey = normalizePhone(th.customer_phone);
      const cust = custPack.byPhone[phoneKey] || null;
      const last = latestByThread[th.id] || null;

      const meta = (th.meta && typeof th.meta === "object") ? th.meta : {};
      const manualStatus = String(meta.admin_manual_status || "").toUpperCase();

      const lastAdminMessageAt = th.last_admin_message_at || null;
      const lastCustomerMessageAt = th.last_customer_message_at || null;
      const lastCustomerSeenAt = th.last_customer_seen_at || null;

      const adminTs = toTs(lastAdminMessageAt);
      const customerMsgTs = toTs(lastCustomerMessageAt);
      const seenTs = toTs(lastCustomerSeenAt);

      const hasAdminReply = adminTs > 0;
      const hasCustomerSeen = seenTs > 0;
      const hasCustomerMessage = customerMsgTs > 0;

      const autoWaiting =
        manualStatus === "WAITING";

      const autoUnread =
        hasAdminReply &&
        adminTs > customerMsgTs &&
        (
          !hasCustomerSeen ||
          seenTs < adminTs
        );

      const autoRead =
        hasAdminReply &&
        adminTs > customerMsgTs &&
        hasCustomerSeen &&
        seenTs >= adminTs;

      let finalUnread = false;
      let finalRead = false;
      let finalWaiting = false;

      if (autoWaiting) {
        finalWaiting = true;
      } else if (autoUnread) {
        finalUnread = true;
      } else if (autoRead) {
        finalRead = true;
      }

      let sortTs = 0;
      if (finalWaiting) {
        sortTs = toTs(th.last_message_at || last?.created_at || th.created_at || 0);
      } else if (finalUnread) {
        sortTs = adminTs;
      } else {
        sortTs = toTs(th.last_message_at || last?.created_at || th.created_at || 0);
      }

      return {
        thread_id: th.id,
        status: th.status || "OPEN",
        created_at: th.created_at || null,
        last_message_at: th.last_message_at || last?.created_at || th.created_at || null,

        last_admin_message_at: lastAdminMessageAt,
        last_customer_message_at: lastCustomerMessageAt,
        last_customer_seen_at: lastCustomerSeenAt,

        customer_name: cust?.name || "Customer",
        last_message_role: last?.role || "",
        last_message_text: sanitizeSnippet(last?.text || ""),

        meta,

        unread: finalUnread,
        read: finalRead,
        waiting_customer: finalWaiting,
        unread_sort_ts: sortTs
      };
    });

    rows.sort((a, b) => {
      const pa =
        a.waiting_customer ? 3 :
        a.unread ? 2 :
        a.read ? 1 : 0;

      const pb =
        b.waiting_customer ? 3 :
        b.unread ? 2 :
        b.read ? 1 : 0;

      if (pb !== pa) return pb - pa;

      const ta = Number(a.unread_sort_ts || 0);
      const tb = Number(b.unread_sort_ts || 0);
      if (tb !== ta) return tb - ta;

      const xa = toTs(a.last_message_at || a.created_at || 0);
      const xb = toTs(b.last_message_at || b.created_at || 0);
      return xb - xa;
    });

    const counts = {
      total: rows.length,
      unread: rows.filter(x => x.unread).length,
      read: rows.filter(x => x.read).length,
      waiting_customer: rows.filter(x => x.waiting_customer).length
    };

    return json(200, { ok: true, rows, counts });

  } catch (e) {
    console.error("agent-chat-list error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};