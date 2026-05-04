const {
  corsHeaders,
  json,
  normalizePhone,
  buildPhoneCandidates,
  getSupabaseAdmin
} = require("./_auth-chat-helper");

const { verifyOtpInput, consumeOtp } = require("./_auth-otp-helper");

async function findCustomerByPhone(supabase, phone) {
  const candidates = buildPhoneCandidates(phone);

  const q = await supabase
    .from("customers")
    .select("id,name,phone")
    .in("phone", candidates)
    .limit(1);

  if (q.error) throw q.error;
  return q.data && q.data[0] ? q.data[0] : null;
}

async function findAuthUserByEmailCandidates(supabase, emails) {
  let page = 1;
  const perPage = 200;
  const wanted = (emails || []).map(x => String(x || "").toLowerCase()).filter(Boolean);

  while (true) {
    const res = await supabase.auth.admin.listUsers({ page, perPage });
    if (res.error) throw res.error;

    const users = res.data?.users || [];
    const found = users.find(u => wanted.includes(String(u.email || "").toLowerCase()));
    if (found) return found;

    if (users.length < perPage) break;
    page += 1;
  }

  return null;
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
    const reason = String(body.reason || "").trim();

    if (!phone) {
      return json(400, { ok: false, error: "Nombor telefon tak sah." });
    }

    if (!/^\d{4}$/.test(last4)) {
      return json(400, { ok: false, error: "4 digit terakhir tak sah." });
    }

    if (!phone.endsWith(last4)) {
      return json(400, { ok: false, error: "4 digit terakhir tak padan." });
    }

    if (!/^\d{6}$/.test(otp)) {
      return json(400, { ok: false, error: "OTP mesti 6 digit." });
    }

    const supabase = getSupabaseAdmin();

    const checked = await verifyOtpInput(supabase, {
      phone,
      purpose: "delete_account",
      otp
    });

    if (!checked.ok) {
      return json(400, { ok: false, error: checked.error || "OTP tidak sah." });
    }

    const customer = await findCustomerByPhone(supabase, phone);
    if (!customer) {
      return json(404, { ok: false, error: "Akaun pelanggan tidak dijumpai." });
    }

    const dbPhone = String(customer.phone || phone).replace(/\D+/g, "");
    const localPhone = dbPhone.startsWith("60") ? ("0" + dbPhone.slice(2)) : dbPhone;
    const intlPhone = dbPhone.startsWith("0") ? ("60" + dbPhone.slice(1)) : dbPhone;

    let authUid = null;

    const mapQ = await supabase
      .from("auth_customer_map")
      .select("auth_uid")
      .eq("customer_id", customer.id)
      .maybeSingle();

    if (mapQ.error) throw mapQ.error;
    if (mapQ.data?.auth_uid) {
      authUid = mapQ.data.auth_uid;
    }

    if (!authUid) {
      const foundAuth = await findAuthUserByEmailCandidates(supabase, [
        `${localPhone}@emasamir.app`,
        `${intlPhone}@emasamir.app`
      ]);
      if (foundAuth?.id) authUid = foundAuth.id;
    }

    const delMap = await supabase
      .from("auth_customer_map")
      .delete()
      .eq("customer_id", customer.id);

    if (delMap.error) throw delMap.error;

    if (authUid) {
      const delAuth = await supabase.auth.admin.deleteUser(authUid);
      if (delAuth.error) throw delAuth.error;
    }

    const delCustomer = await supabase
      .from("customers")
      .delete()
      .eq("id", customer.id);

    if (delCustomer.error) throw delCustomer.error;

    await consumeOtp(supabase, checked.record.id);

    return json(200, {
      ok: true,
      message: "Akaun berjaya dipadam.",
      deleted_customer_id: customer.id,
      deleted_auth_uid: authUid || null,
      reason: reason || null
    });
  } catch (e) {
    console.error("auth-delete-finish error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};