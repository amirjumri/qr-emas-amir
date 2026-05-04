// netlify/functions/chat-precheck.js
// Purpose:
// - Semak sebelum user mula LOCK: adakah customer wujud & alamat lengkap?
// - Return need_register=true jika:
//   (1) customer belum wujud, atau
//   (2) customer wujud tapi field wajib (alamat) tak lengkap
//
// ENV diperlukan:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
//
// Request body:
// { phone: "60xxxxxxxxxx" atau "016..." atau "+60...", thread_id: "..." (optional) }
//
// Response contoh:
// { ok:true, phone:"6016...", exists:true, need_register:false, customer:{name:"..."} }

const { createClient } = require("@supabase/supabase-js");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj),
  };
}

function safeStr(x) {
  return String(x || "").trim();
}

// Normalisasi phone ke digit e164 tanpa '+'
// - MY: 60 + (10/11 digit total) → contoh 60168055916
// - SG: 65 + 8 digit → contoh 6591234567
function normalizePhone(raw) {
  let d = safeStr(raw).replace(/\D+/g, "");
  if (!d) return { ok: false, error: "Nombor kosong" };

  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);

  // SG local 8 digit (8/9 start)
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;

  const isMY = d.startsWith("60") && (d.length === 11 || d.length === 12);
  const isSG = d.startsWith("65") && d.length === 10;

  if (!isMY && !isSG) {
    return { ok: false, error: "Nombor tak sah. MY: 01xxxxxxxx / +60..., SG: +65xxxxxxxx" };
  }

  return { ok: true, e164: d, country: isMY ? "MY" : "SG" };
}

// Tukar ikut schema Amir (kalau field nama lain, adjust sini sahaja)
function getRequiredFields(country) {
  // Wajib untuk POS (alamat lengkap)
  // NOTE: kalau pickup sahaja pun Amir tetap nak daftar dulu (supaya tak lari flow), jadi kita kekalkan wajib.
  if (country === "SG") {
    return ["name", "address1", "city", "postcode", "country"];
  }
  return ["name", "address1", "city", "state", "postcode", "country"];
}

// Ambil field dari row customer (tukar kalau schema Amir lain)
function pickCustomer(row) {
  if (!row) return null;
  return {
    id: row.id ?? null,
    phone: row.phone ?? row.e164 ?? null,
    name: row.name ?? row.full_name ?? row.customer_name ?? null,
    email: row.email ?? null,
    address1: row.address1 ?? row.address ?? row.addr1 ?? null,
    address2: row.address2 ?? row.addr2 ?? null,
    city: row.city ?? row.town ?? null,
    state: row.state ?? row.negeri ?? null,
    postcode: row.postcode ?? row.poscode ?? null,
    country: row.country ?? row.negara ?? null,
  };
}

function getMissingFields(customer, required) {
  const miss = [];
  for (const k of required) {
    const v = safeStr(customer?.[k]);
    if (!v) miss.push(k);
  }
  return miss;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Server env missing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    }

    const body = JSON.parse(event.body || "{}");
    const rawPhone = body.phone;
    const threadId = body.thread_id || null; // optional (tak wajib guna)

    const p = normalizePhone(rawPhone);
    if (!p.ok) return json(400, { ok: false, error: p.error });

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ✅ Cari customer by phone
    // Tukar column kalau schema Amir lain:
    // - jika guna "msisdn" atau "e164", ubah .eq("phone", ...)
    let q = await sb
      .from("customers")
      .select("*")
      .eq("phone", p.e164)
      .maybeSingle();

    // fallback: kalau column phone tak match, cuba e164 (optional)
    if (q.error && /column .* does not exist/i.test(String(q.error.message || ""))) {
      q = await sb
        .from("customers")
        .select("*")
        .eq("e164", p.e164)
        .maybeSingle();
    }

    if (q.error) {
      return json(500, { ok: false, error: q.error.message || "Supabase error" });
    }

    const row = q.data || null;

    // ❌ customer belum wujud → wajib daftar
    if (!row) {
      return json(200, {
        ok: true,
        phone: p.e164,
        country: p.country,
        thread_id: threadId,
        exists: false,
        need_register: true,
        missing_fields: ["customer"],
        reason: "CUSTOMER_NOT_FOUND",
      });
    }

    const cust = pickCustomer(row);

    // ✅ pastikan country ada (kalau kosong, guna dari phone)
    if (!safeStr(cust.country)) cust.country = p.country === "MY" ? "MY" : "SG";

    const required = getRequiredFields(p.country);
    const missing = getMissingFields(cust, required);

    // ❌ alamat tak lengkap → wajib daftar / update profil
    if (missing.length) {
      return json(200, {
        ok: true,
        phone: p.e164,
        country: p.country,
        thread_id: threadId,
        exists: true,
        need_register: true,
        missing_fields: missing,
        reason: "PROFILE_INCOMPLETE",
        customer: {
          name: cust.name || null,
        },
      });
    }

    // ✅ lulus
    return json(200, {
      ok: true,
      phone: p.e164,
      country: p.country,
      thread_id: threadId,
      exists: true,
      need_register: false,
      missing_fields: [],
      reason: "OK",
      customer: {
        name: cust.name || null,
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};