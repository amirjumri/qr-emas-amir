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

function safeName(name) {
  return String(name || "file")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
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
    const customerPhone = normalizePhone(body.customer_phone || "");
    const fileName = String(body.file_name || "file").trim();
    const mime = String(body.mime || "application/octet-stream").trim();
    const contentBase64 = String(body.content_base64 || "").trim();

    if (!threadId || !customerPhone || !contentBase64) {
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

    const isAdmin = await verifyAdmin(supabase, adminPhone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    const buffer = Buffer.from(contentBase64, "base64");
    const bucket = "chat-media";
    const path = `chat/admin/${customerPhone}/${threadId}/${Date.now()}_${safeName(fileName)}`;

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
    console.error("admin-chat-upload error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};