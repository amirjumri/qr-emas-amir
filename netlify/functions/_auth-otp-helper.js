const crypto = require("crypto");

function otpPepper() {
  return process.env.AUTH_OTP_PEPPER || process.env.OTP_PEPPER || "emasamir-otp";
}

function hashOtp({ phone, purpose, otp }) {
  const raw = `${otpPepper()}|${String(phone || "")}|${String(purpose || "")}|${String(otp || "")}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function secondsBetween(a, b) {
  const ms = new Date(a).getTime() - new Date(b).getTime();
  return Math.max(0, Math.ceil(ms / 1000));
}

async function createOtpRecord(supabase, {
  phone,
  purpose,
  threadId = null,
  channel = "AI_DAN",
  ttlMinutes = 5,
  minRequestGapSeconds = 30,
  meta = {}
}) {
  const now = new Date();
  const nowIso = now.toISOString();

  const latestQ = await supabase
    .from("auth_otps")
    .select("id,created_at,used_at,expires_at")
    .eq("phone", phone)
    .eq("purpose", purpose)
    .order("created_at", { ascending: false })
    .limit(1);

  if (latestQ.error) throw latestQ.error;

  const latest = latestQ.data && latestQ.data[0] ? latestQ.data[0] : null;
  if (latest && latest.created_at) {
    const passed = secondsBetween(nowIso, latest.created_at);
    if (passed < minRequestGapSeconds) {
      return {
        ok: false,
        error: `Terlalu cepat. Cuba lagi dalam ${minRequestGapSeconds - passed} saat.`,
        retry_after_seconds: minRequestGapSeconds - passed
      };
    }
  }

  await supabase
    .from("auth_otps")
    .update({ used_at: nowIso })
    .eq("phone", phone)
    .eq("purpose", purpose)
    .is("used_at", null);

  const otp = generateOtp();
  const otp_hash = hashOtp({ phone, purpose, otp });
  const expires_at = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  const ins = await supabase
    .from("auth_otps")
    .insert({
      phone,
      purpose,
      otp_hash,
      channel,
      thread_id: threadId,
      expires_at,
      meta: meta || {}
    })
    .select("id,phone,purpose,thread_id,expires_at,attempt_count,max_attempts,created_at,channel,meta")
    .single();

  if (ins.error) throw ins.error;

  return {
    ok: true,
    otp,
    record: ins.data
  };
}

async function verifyOtpInput(supabase, { phone, purpose, otp }) {
  const nowIso = new Date().toISOString();

  const q = await supabase
    .from("auth_otps")
    .select("id,phone,purpose,otp_hash,expires_at,used_at,attempt_count,max_attempts,thread_id,created_at,channel,meta")
    .eq("phone", phone)
    .eq("purpose", purpose)
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1);

  if (q.error) throw q.error;

  const row = q.data && q.data[0] ? q.data[0] : null;
  if (!row) {
    return { ok: false, error: "OTP tiada atau sudah tamat tempoh." };
  }

  const attempts = Number(row.attempt_count || 0);
  const maxAttempts = Number(row.max_attempts || 5);

  if (attempts >= maxAttempts) {
    await supabase
      .from("auth_otps")
      .update({ used_at: nowIso })
      .eq("id", row.id);

    return { ok: false, error: "OTP sudah melebihi cubaan maksimum." };
  }

  const incomingHash = hashOtp({ phone, purpose, otp });
  if (incomingHash !== row.otp_hash) {
    const nextAttempts = attempts + 1;
    const patch = { attempt_count: nextAttempts };
    if (nextAttempts >= maxAttempts) patch.used_at = nowIso;

    await supabase
      .from("auth_otps")
      .update(patch)
      .eq("id", row.id);

    return { ok: false, error: "OTP salah." };
  }

  return { ok: true, record: row };
}

async function consumeOtp(supabase, otpId) {
  const nowIso = new Date().toISOString();

  const up = await supabase
    .from("auth_otps")
    .update({ used_at: nowIso })
    .eq("id", otpId)
    .is("used_at", null);

  if (up.error) throw up.error;
  return true;
}

module.exports = {
  generateOtp,
  hashOtp,
  createOtpRecord,
  verifyOtpInput,
  consumeOtp
};