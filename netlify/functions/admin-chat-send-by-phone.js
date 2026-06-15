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

  if (d.startsWith("60")) {
    out.add("0" + d.slice(2));
  }

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

async function findCustomerByPhone(supabase, phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;

  const q = await supabase
    .from("customers")
    .select("id,name,customer_name,phone")
    .in("phone", variants)
    .limit(1)
    .maybeSingle();

  if (q.error) throw q.error;
  return q.data || null;
}

async function findLatestThreadByPhone(supabase, phone) {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;

  const q = await supabase
    .from("chat_threads")
    .select("id,status,customer_phone,last_message_at,created_at,meta")
    .in("customer_phone", variants)
    .order("last_message_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (q.error) throw q.error;
  return q.data || null;
}

async function createThreadByPhone(supabase, phone, customer) {
  const cleanPhone = normalizePhone(phone);
  const now = new Date().toISOString();

  const payload = {
    customer_phone: cleanPhone,
    status: "OPEN",
    last_message_at: now,
    meta: {
      created_by: "admin_chat_send_by_phone",
      customer_id: customer?.id || null,
      customer_name: customer?.customer_name || customer?.name || null,
      admin_mode: true
    }
  };

  const q = await supabase
    .from("chat_threads")
    .insert(payload)
    .select("id,status,customer_phone,last_message_at,created_at,meta")
    .single();

  if (q.error) throw q.error;
  return q.data;
}

async function getOrCreateThread(supabase, phone) {
  const cleanPhone = normalizePhone(phone);

  if (!cleanPhone) {
    throw new Error("customer_phone tidak sah.");
  }

  const existing = await findLatestThreadByPhone(supabase, cleanPhone);
  if (existing?.id) return existing;

  const customer = await findCustomerByPhone(supabase, cleanPhone);
  return await createThreadByPhone(supabase, cleanPhone, customer);
}

function getBaseUrl(event) {
  const envUrl =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.SITE_URL ||
    "";

  if (envUrl) return String(envUrl).replace(/\/+$/, "");

  const host = event?.headers?.host || event?.headers?.Host || "";
  if (host) {
    return `https://${host}`;
  }

  return "https://emasamir.app";
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: ""
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, {
        ok: false,
        error: "Method not allowed"
      });
    }

    let body = {};

    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, {
        ok: false,
        error: "Body JSON tak sah"
      });
    }

    const adminPhone = body.admin_phone || "";
    const customerPhone = body.customer_phone || body.phone || "";
    const message = String(body.message || "").trim();
    const attachment = body.attachment || null;
    const replyToMessageId = String(body.reply_to_message_id || "").trim();
    const metaExtra =
      body.meta && typeof body.meta === "object"
        ? body.meta
        : {};

    if (!customerPhone) {
      return json(400, {
        ok: false,
        error: "customer_phone diperlukan."
      });
    }

    if (!message && !(attachment && attachment.url)) {
      return json(400, {
        ok: false,
        error: "Mesej atau attachment diperlukan."
      });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, {
        ok: false,
        error: "Supabase env belum lengkap."
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      serviceKey
    );

    const isAdmin = await verifyAdmin(supabase, adminPhone);

    if (!isAdmin) {
      return json(403, {
        ok: false,
        error: "Akses admin ditolak."
      });
    }

    const thread = await getOrCreateThread(supabase, customerPhone);
    const cleanCustomerPhone = normalizePhone(thread.customer_phone || customerPhone);

    const baseUrl = getBaseUrl(event);

    const relay = await fetch(`${baseUrl}/.netlify/functions/admin-chat-send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        admin_phone: adminPhone,
        thread_id: thread.id,
        message,
        attachment,
        reply_to_message_id: replyToMessageId || null,
        meta: {
          ...metaExtra,
          relayed_by: "admin_chat_send_by_phone"
        }
      })
    });

    const relayJson = await relay.json().catch(() => ({}));

    if (!relay.ok || relayJson.ok !== true) {
      return json(500, {
        ok: false,
        error: relayJson?.error || "Relay admin-chat-send gagal",
        relay_status: relay.status,
        thread_id: thread.id,
        customer_phone: cleanCustomerPhone,
        relay: relayJson
      });
    }

    return json(200, {
      ok: true,
      thread_id: thread.id,
      customer_phone: cleanCustomerPhone,
      relay: relayJson
    });

  } catch (e) {
    console.error("admin-chat-send-by-phone error:", e);

    return json(500, {
      ok: false,
      error: e?.message || String(e),
      detail: e?.details || null,
      hint: e?.hint || null,
      code: e?.code || null
    });
  }
};