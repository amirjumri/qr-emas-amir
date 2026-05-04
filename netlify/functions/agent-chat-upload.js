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

function safeName(name) {
  return String(name || "file")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
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
    const fileName = String(body.file_name || "file").trim();
    const mime = String(body.mime || "application/octet-stream").trim();
    const contentBase64 = String(body.content_base64 || "").trim();

    if (!agentUserId || !agentSlug || !threadId || !contentBase64) {
      return json(400, { ok: false, error: "Maklumat upload tak lengkap." });
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
      .select("id,customer_phone")
      .eq("id", threadId)
      .single();

    if (threadQ.error) throw threadQ.error;

    const customerPhone = normalizePhone(threadQ.data?.customer_phone || "");
    if (!customerPhone) {
      return json(400, { ok: false, error: "customer_phone thread tidak sah." });
    }

    const custPack = await getCustomersUnderAgent(supabase, agentSlug);
    const allowedCustomer = custPack.byPhone[customerPhone] || null;

    if (!allowedCustomer) {
      return json(403, { ok: false, error: "Thread ini bukan customer bawah agen ini." });
    }

    const buffer = Buffer.from(contentBase64, "base64");
    const bucket = "chat-media";
    const path = `chat/agent/${agentSlug}/${customerPhone}/${threadId}/${Date.now()}_${safeName(fileName)}`;

    const up = await supabase.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType: mime,
        upsert: false
      });

    if (up.error) throw up.error;

    const pub = supabase.storage.from(bucket).getPublicUrl(path);
    const url = pub?.data?.publicUrl || "";

    if (!url) {
      throw new Error("Gagal dapat public URL.");
    }

    return json(200, {
      ok: true,
      url,
      name: fileName,
      mime
    });

  } catch (e) {
    console.error("agent-chat-upload error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};