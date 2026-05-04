const {
  json,
  normalizePhone,
  buildRegistrationOptionsForPhone
} = require("./_passkey-helper");

function bytesToBase64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "POST, OPTIONS"
        },
        body: ""
      };
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

    const phone = normalizePhone(body.phone || body.customer_phone || "");
    if (!phone) {
      return json(400, { ok: false, error: "Nombor telefon tak sah." });
    }

    const { options } = await buildRegistrationOptionsForPhone(phone);

    return json(200, {
      ok: true,
      challenge: options.challenge,
      rp: options.rp,
      user: {
        ...options.user,
        id: bytesToBase64url(options.user.id)
      },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation,
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: options.excludeCredentials || []
    });
  } catch (e) {
    console.error("passkey-register-start error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};