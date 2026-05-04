const {
  corsHeaders,
  json,
  getSupabaseAdmin,
  getOrCreateThread,
  insertAiMessage
} = require("./_auth-chat-helper");
const { verifyOtpInput, consumeOtp } = require("./_auth-otp-helper");

let _fetch = globalThis.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

function buildPhoneCandidates(phone) {
  const out = [];
  const add = (v) => {
    const s = String(v || "").replace(/\D+/g, "").trim();
    if (s && !out.includes(s)) out.push(s);
  };

  add(phone);

  if (phone.startsWith("60") && phone.length >= 11) {
    add("0" + phone.slice(2));
  } else if (phone.startsWith("0") && phone.length >= 10) {
    add("60" + phone.slice(1));
  } else {
    add("0" + phone);
    add("60" + phone.replace(/^0+/, ""));
  }

  return out;
}

function buildAuthEmailCandidates(phone) {
  const out = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };

  if (phone.startsWith("60") && phone.length >= 11) {
    add(`${phone}@emasamir.app`);
    add(`${"0" + phone.slice(2)}@emasamir.app`);
  } else if (phone.startsWith("0")) {
    add(`${phone}@emasamir.app`);
    add(`${"60" + phone.slice(1)}@emasamir.app`);
  } else {
    add(`${phone}@emasamir.app`);
  }

  return out;
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function findAuthUserByEmails(supabaseUrl, serviceRole, emailCandidates) {
  const targets = (emailCandidates || []).map(x => String(x).toLowerCase());

  for (let page = 1; page <= 10; page++) {
    const url = `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`;
    const res = await _fetch(url, {
      method: "GET",
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        "Content-Type": "application/json"
      }
    });

    const data = await safeJson(res);
    if (!res.ok) {
      throw new Error(`List users failed: ${res.status}`);
    }

    const users = Array.isArray(data?.users) ? data.users : [];
    const found = users.find(u => targets.includes(String(u?.email || "").toLowerCase()));
    if (found?.id) return found;

    if (users.length < 1000) break;
  }

  return null;
}

async function syncSupabaseAuthPassword(phone, newPassword) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.URL || "";
  const serviceRole =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE ||
    "";

  if (!supabaseUrl || !serviceRole) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const emails = buildAuthEmailCandidates(phone);
  const found = await findAuthUserByEmails(supabaseUrl, serviceRole, emails);

  const canonicalEmail =
    phone.startsWith("60") && phone.length >= 11
      ? `${"0" + phone.slice(2)}@emasamir.app`
      : `${phone}@emasamir.app`;

  if (!found?.id) {
    const createUrl = `${supabaseUrl}/auth/v1/admin/users`;
    const createRes = await _fetch(createUrl, {
      method: "POST",
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: canonicalEmail,
        password: newPassword,
        email_confirm: true,
        user_metadata: { phone }
      })
    });

    const createJson = await safeJson(createRes);
    if (!createRes.ok) {
      throw new Error(createJson?.msg || createJson?.error_description || `Create user failed: ${createRes.status}`);
    }

    return { ok: true, mode: "created", email: canonicalEmail };
  }

  const updateUrl = `${supabaseUrl}/auth/v1/admin/users/${found.id}`;
  const updRes = await _fetch(updateUrl, {
    method: "PUT",
    headers: {
      apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ password: newPassword })
  });

  const updJson = await safeJson(updRes);
  if (!updRes.ok) {
    throw new Error(updJson?.msg || updJson?.error_description || `Update user failed: ${updRes.status}`);
  }

  return { ok: true, mode: "updated", email: found.email || canonicalEmail };
}

async function findCustomerByPhoneCandidates(supabase, phone) {
  const candidates = buildPhoneCandidates(phone);

  const q = await supabase
    .from("customers")
    .select("id,name,phone,ic,alamat")
    .in("phone", candidates)
    .limit(10);

  if (q.error) throw q.error;

  const rows = q.data || [];
  if (!rows.length) return null;

  const exact = rows.find(r => String(r.phone || "").replace(/\D+/g, "") === phone);
  if (exact) return exact;

  const local = candidates.find(x => x.startsWith("0"));
  if (local) {
    const row = rows.find(r => String(r.phone || "").replace(/\D+/g, "") === local);
    if (row) return row;
  }

  return rows[0];
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

    const rawPhone = body.phone || body.customer_phone || "";
const phone = String(rawPhone || "").replace(/\D+/g, "").trim();
const last4 = String(body.last4 || "").replace(/\D+/g, "");
const otp = String(body.otp || "").replace(/\D+/g, "");
const newPassword = String(body.new_password || body.password || "");
const threadIdIn = String(body.thread_id || "").trim();

    if (!phone) return json(400, { ok: false, error: "Nombor telefon tak sah." });
    if (!/^\d{4}$/.test(last4)) return json(400, { ok: false, error: "4 digit terakhir tak sah." });
    if (!phone.endsWith(last4)) return json(400, { ok: false, error: "4 digit terakhir tak padan." });
    if (!/^\d{6}$/.test(otp)) return json(400, { ok: false, error: "OTP mesti 6 digit." });
    if (newPassword.length < 6) return json(400, { ok: false, error: "Password minima 6 aksara." });

    const supabase = getSupabaseAdmin();

    const checked = await verifyOtpInput(supabase, {
      phone,
      purpose: "reset",
      otp
    });

    if (!checked.ok) {
      return json(400, { ok: false, error: checked.error || "OTP tidak sah." });
    }

    const otpChannel = String(
      checked?.record?.channel ||
      checked?.record?.delivery_channel ||
      checked?.record?.meta?.channel ||
      ""
    ).toUpperCase();

    if (otpChannel !== "WHATSAPP") {
      return json(400, {
        ok: false,
        error: "OTP reset mesti daripada WhatsApp."
      });
    }

    const customer = await findCustomerByPhoneCandidates(supabase, phone);
    if (!customer) {
      return json(400, { ok: false, error: "Customer tidak jumpa." });
    }

    const dbPhone = String(customer.phone || "").replace(/\D+/g, "");
    if (!dbPhone) {
      return json(400, { ok: false, error: "Phone customer tidak sah dalam DB." });
    }

    const r1 = await supabase.rpc("reset_password", {
      in_phone: dbPhone,
      in_password: newPassword
    });

    if (r1.error) {
      console.error("reset_password error:", r1.error);
      return json(400, { ok: false, error: r1.error.message || "Reset password gagal." });
    }

    await syncSupabaseAuthPassword(dbPhone, newPassword);
    await consumeOtp(supabase, checked.record.id);

    const thread = await getOrCreateThread(supabase, {
      phone,
      threadId: threadIdIn || checked.record.thread_id || null,
      status: "OPEN",
      meta: {}
    });

    await insertAiMessage(supabase, {
      threadId: thread.id,
      text:
        `Password berjaya ditukar ✅\n` +
        `Telefon: ${dbPhone}\n` +
        `Sekarang cik boleh log masuk guna password baharu.`,
      meta: {
        auth_event: "RESET_SUCCESS",
        purpose: "reset",
        customer_id: customer.id || null
      }
    });

    return json(200, {
      ok: true,
      user: {
        id: customer.id,
        name: customer.name || dbPhone,
        phone: customer.phone || dbPhone,
        ic: customer.ic || "",
        alamat: customer.alamat || ""
      },
      thread_id: thread.id,
      message: "Password berjaya ditukar."
    });
  } catch (e) {
    console.error("auth-reset-finish error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};