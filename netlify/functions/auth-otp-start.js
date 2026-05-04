const {
  corsHeaders,
  json,
  normalizePhone,
  buildPhoneCandidates,
  getSupabaseAdmin,
  getOrCreateThread,
  insertAiMessage
} = require("./_auth-chat-helper");

const { createOtpRecord } = require("./_auth-otp-helper");

let _fetch = globalThis.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

async function sendWhatsappOtp(phone, otp) {
  const apiKey =
    process.env.ONSEND_API_KEY ||
    process.env.ONSEND_KEY ||
    process.env.ONSEND_TOKEN ||
    "";

  if (!apiKey) {
    throw new Error("ONSEND_API_KEY belum diset dalam environment.");
  }

  const baseUrl = String(process.env.ONSEND_BASE_URL || "https://onsend.io/api/v1").replace(/\/+$/, "");
  const url = `${baseUrl}/send`;

  const message =
    `Kod OTP reset password Emas Amir anda: ${otp}\n\n` +
    `Kod ini sah selama 5 minit.\n` +
    `Jangan kongsi kod ini dengan sesiapa.`;

  const resp = await _fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      phone_number: phone,
      message,
      type: "text"
    })
  });

  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!resp.ok) {
    throw new Error(data?.message || data?.error || `OnSend HTTP ${resp.status}`);
  }

  if (data && data.ok === false) {
    throw new Error(data?.message || data?.error || "OnSend gagal hantar WhatsApp OTP.");
  }

  return data;
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

    const purpose = String(body.purpose || "").trim().toLowerCase();
    const rawPhone = body.phone || body.customer_phone || "";
    const last4 = String(body.last4 || "").replace(/\D+/g, "");
    const threadIdIn = String(body.thread_id || "").trim();
    const name = String(body.name || "").trim();

    if (!["signup", "reset", "delete_account"].includes(purpose)) {
  return json(400, { ok: false, error: "purpose mesti signup, reset atau delete_account." });
}

    const phone = String(rawPhone || "").replace(/\D+/g, "").trim();
if (!phone) {
  return json(400, { ok: false, error: "Nombor telefon tak sah." });
}

    if (!/^\d{4}$/.test(last4)) {
      return json(400, { ok: false, error: "4 digit terakhir tak sah." });
    }

    if (!phone.endsWith(last4)) {
      return json(400, { ok: false, error: "4 digit terakhir tak padan." });
    }

    const supabase = getSupabaseAdmin();

   if (purpose === "reset" || purpose === "delete_account") {
  const phoneCandidates = buildPhoneCandidates(phone);
  const cq = await supabase
    .from("customers")
    .select("id,phone,name")
    .in("phone", phoneCandidates)
    .limit(1);

  if (cq.error) throw cq.error;

  if (!cq.data || !cq.data.length) {
    return json(404, { ok: false, error: "Akaun tidak dijumpai." });
  }
}

    const thread = await getOrCreateThread(supabase, {
      phone,
      threadId: threadIdIn || null,
      status: "OPEN",
      meta: {}
    });

    const otpChannel = (purpose === "reset" || purpose === "delete_account") ? "WHATSAPP" : "AI_DAN";

    const made = await createOtpRecord(supabase, {
      phone,
      purpose,
      threadId: thread.id,
      channel: otpChannel,
      ttlMinutes: 5,
      minRequestGapSeconds: 30,
      meta: {
        source: "login.html",
        name: name || null
      }
    });

    if (!made.ok) {
      return json(429, {
        ok: false,
        error: made.error || "Terlalu banyak permintaan OTP.",
        retry_after_seconds: made.retry_after_seconds || null
      });
    }

    const otp = made.otp;

    if (purpose === "signup") {
      const text =
        `OTP Daftar Akaun Emas Amir\n` +
        `Telefon: ${phone}\n` +
        `OTP: ${otp}\n\n` +
        `(OTP sah 5 minit)`;

      await insertAiMessage(supabase, {
        threadId: thread.id,
        text,
        meta: {
          auth_event: "OTP_REQUEST",
          purpose,
          channel: "AI_DAN",
          auth_otp_id: made.record.id
        }
      });

      return json(200, {
        ok: true,
        purpose,
        phone,
        thread_id: thread.id,
        otp,
        expires_at: made.record.expires_at,
        message: "OTP berjaya dijana."
      });
    }

    await sendWhatsappOtp(phone, otp);

    return json(200, {
  ok: true,
  purpose,
  phone,
  thread_id: thread.id,
  expires_at: made.record.expires_at,
  message: purpose === "delete_account"
    ? "OTP berjaya dihantar untuk padam akaun."
    : "OTP berjaya dihantar ke WhatsApp."
});
  } catch (e) {
    console.error("auth-otp-start error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};