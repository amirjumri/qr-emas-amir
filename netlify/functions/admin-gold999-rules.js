const { createClient } = require("@supabase/supabase-js");

function json(statusCode, body){
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function corsOk(){
  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;
  return d;
}

function getAdminPhoneFromEvent(event){
  const h = event.headers || {};
  return (
    h["x-ea-admin-phone"] ||
    h["X-EA-ADMIN-PHONE"] ||
    h["x-admin-phone"] ||
    h["X-Admin-Phone"] ||
    ""
  );
}

function validateRow(row){
  if (!row || typeof row !== "object") return "Payload row tak sah.";

  const source = String(row.source || "").trim().toUpperCase();
  const kind = String(row.kind || "").trim().toLowerCase();
  const discount_type = String(row.discount_type || "").trim().toUpperCase();

  const weight_g = Number(row.weight_g);
  const discount_value = Number(row.discount_value);
  const priority = Number(row.priority);

  if (!source) return "Source wajib diisi.";
  if (!["coin","dinar","bar"].includes(kind)) return "Jenis tak sah.";
  if (!isFinite(weight_g) || weight_g <= 0) return "Berat mesti > 0.";
  if (!["AMOUNT","PERCENT"].includes(discount_type)) return "Mode diskaun tak sah.";
  if (!isFinite(discount_value) || discount_value < 0) return "Nilai diskaun mesti >= 0.";
  if (discount_type === "PERCENT" && discount_value > 100) return "PERCENT tak boleh lebih 100.";
  if (!isFinite(priority) || priority < 0) return "Priority mesti >= 0.";

  return "";
}

exports.handler = async function handler(event){
  try{
    if (event.httpMethod === "OPTIONS") return corsOk();
    if (event.httpMethod !== "POST") return json(405, { ok:false, error:"Method not allowed" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { ok:false, error:"Supabase env belum lengkap." });
    }

    let body = {};
    try{
      body = JSON.parse(event.body || "{}");
    }catch{
      return json(400, { ok:false, error:"Body JSON tak sah." });
    }

    const action = String(body.action || "").trim().toLowerCase();
    if (!action) return json(400, { ok:false, error:"Action diperlukan." });

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // OPTIONAL: check admin dari header / body
    // kalau tak ada apa-apa pun, function masih jalan.
    // kalau nak ketat, boleh tambah whitelist sini.
    const rawAdminPhone = body.admin_phone || getAdminPhoneFromEvent(event) || "";
    const adminPhone = normalizePhone(rawAdminPhone);

    // contoh guard optional:
    // const ALLOW = ["601113230198"];
    // if (adminPhone && !ALLOW.includes(adminPhone)) {
    //   return json(403, { ok:false, error:"Akses ditolak." });
    // }

    if (action === "list") {
      const { data, error } = await supabase
        .from("gold999_discount_rules")
        .select("id, source, kind, weight_g, discount_type, discount_value, label, priority, is_active, updated_at")
        .order("priority", { ascending: true })
        .order("kind", { ascending: true })
        .order("weight_g", { ascending: true });

      if (error) return json(500, { ok:false, error:error.message });
      return json(200, { ok:true, rows: data || [] });
    }

    if (action === "save") {
      const row = body.row || {};
      const errMsg = validateRow(row);
      if (errMsg) return json(400, { ok:false, error: errMsg });

      const rawKind = String(row.kind || "").trim().toLowerCase();
const normalizedKind = (rawKind === "goldbar") ? "bar" : rawKind;

const payload = {
  source: String(row.source || "").trim().toUpperCase(),
  kind: normalizedKind,
  weight_g: Number(row.weight_g),
  discount_type: String(row.discount_type || "").trim().toUpperCase(),
  discount_value: Number(row.discount_value),
  label: row.label ? String(row.label).trim() : null,
  priority: Number(row.priority || 0),
  is_active: row.is_active === true
};

      if (row.id) {
        const { error } = await supabase
          .from("gold999_discount_rules")
          .update(payload)
          .eq("id", Number(row.id));

        if (error) return json(500, { ok:false, error:error.message });
        return json(200, { ok:true, mode:"update" });
      }

      const { error } = await supabase
        .from("gold999_discount_rules")
        .insert(payload);

      if (error) return json(500, { ok:false, error:error.message });
      return json(200, { ok:true, mode:"insert" });
    }

    if (action === "delete") {
      const id = Number(body.id || 0);
      if (!id) return json(400, { ok:false, error:"ID tak sah." });

      const { error } = await supabase
        .from("gold999_discount_rules")
        .delete()
        .eq("id", id);

      if (error) return json(500, { ok:false, error:error.message });
      return json(200, { ok:true });
    }

    return json(400, { ok:false, error:"Action tak dikenali." });
  }catch(err){
    return json(500, { ok:false, error:String(err?.message || err) });
  }
};