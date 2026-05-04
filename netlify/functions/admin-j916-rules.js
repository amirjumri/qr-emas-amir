const { createClient } = require("@supabase/supabase-js");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ea-admin-phone, x-admin-phone",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function corsOk() {
  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ea-admin-phone, x-admin-phone",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: ""
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

  return d;
}

function getAdminPhoneFromEvent(event) {
  const h = event.headers || {};
  return (
    h["x-ea-admin-phone"] ||
    h["X-EA-ADMIN-PHONE"] ||
    h["x-admin-phone"] ||
    h["X-Admin-Phone"] ||
    ""
  );
}

function validateRow(row) {
  if (!row || typeof row !== "object") return "Payload row tak sah.";

  const id = Number(row.id || 0);
  const postage = Number(row.postage_discount_rm);
  const cashback = Number(row.cashback_percent);
  const roundMode = String(row.cashback_round_mode || "FLOOR").trim().toUpperCase();

  if (id !== 1) return "ID mesti 1.";
  if (!isFinite(postage) || postage < 0) return "Diskaun pos mesti >= 0.";
  if (!isFinite(cashback) || cashback < 0 || cashback > 20) return "Cashback % mesti antara 0 hingga 20.";
  if (roundMode !== "FLOOR") return "Round mode mesti FLOOR.";

  return "";
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") return corsOk();
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Body JSON tak sah." });
    }

    const action = String(body.action || "").trim().toLowerCase();
    if (!action) {
      return json(400, { ok: false, error: "Action diperlukan." });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const rawAdminPhone = body.admin_phone || getAdminPhoneFromEvent(event) || "";
    const adminPhone = normalizePhone(rawAdminPhone);

    // Optional whitelist kalau nak ketat nanti
    // const ALLOW = ["60123456789"];
    // if (adminPhone && !ALLOW.includes(adminPhone)) {
    //   return json(403, { ok:false, error:"Akses ditolak." });
    // }

    if (action === "get") {
      const { data, error } = await supabase
        .from("j916_payment_rules")
        .select("id, postage_discount_rm, cashback_percent, cashback_round_mode, updated_at")
        .eq("id", 1)
        .maybeSingle();

      if (error) return json(500, { ok: false, error: error.message });

      return json(200, {
        ok: true,
        row: data || null
      });
    }

    if (action === "save") {
      const row = body.row || {};
      const errMsg = validateRow(row);
      if (errMsg) return json(400, { ok: false, error: errMsg });

      const payload = {
        id: 1,
        postage_discount_rm: Number(row.postage_discount_rm || 0),
        cashback_percent: Number(row.cashback_percent || 0),
        cashback_round_mode: "FLOOR"
      };

      const { error } = await supabase
        .from("j916_payment_rules")
        .upsert(payload, { onConflict: "id" });

      if (error) return json(500, { ok: false, error: error.message });

      const { data: latest, error: latestErr } = await supabase
        .from("j916_payment_rules")
        .select("id, postage_discount_rm, cashback_percent, cashback_round_mode, updated_at")
        .eq("id", 1)
        .maybeSingle();

      if (latestErr) {
        return json(200, { ok: true, mode: "save", row: null });
      }

      return json(200, {
        ok: true,
        mode: "save",
        row: latest || null
      });
    }

    return json(400, { ok: false, error: "Action tak dikenali." });
  } catch (err) {
    return json(500, { ok: false, error: String(err?.message || err) });
  }
};