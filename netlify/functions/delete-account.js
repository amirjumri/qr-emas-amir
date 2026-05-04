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

function phoneVariants(raw) {
  const p60 = normalizePhone(raw);
  const p0 = p60.startsWith("60") ? "0" + p60.slice(2) : p60;
  return Array.from(new Set([raw, p60, p0].filter(Boolean)));
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SERVICE_ROLE;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { ok: false, error: "Supabase env tak cukup" });
    }

    const body = JSON.parse(event.body || "{}");
    const phone = normalizePhone(body.phone || "");

    if (!phone) {
      return json(400, { ok: false, error: "Phone diperlukan" });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
    const vars = phoneVariants(phone);

    const { data: customer, error: custErr } = await sb
      .from("customers")
      .select("id, phone, auth_user_id")
      .in("phone", vars)
      .maybeSingle();

    if (custErr) throw custErr;
    if (!customer) {
      return json(404, { ok: false, error: "Pelanggan tidak dijumpai" });
    }

    await sb.from("tabung_txn").delete().in("phone", vars);
    await sb.from("goldbar_order").delete().in("customer_phone", vars);
    await sb.from("j916_orders").delete().in("customer_phone", vars);
    await sb.from("customers").delete().eq("id", customer.id);

    if (customer.auth_user_id) {
      const del = await sb.auth.admin.deleteUser(customer.auth_user_id);
      if (del.error) throw del.error;
    }

    return json(200, { ok: true });
  } catch (e) {
    return json(500, { ok: false, error: e.message || String(e) });
  }
};