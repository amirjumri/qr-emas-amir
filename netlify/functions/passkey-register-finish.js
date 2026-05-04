const {
  json,
  normalizePhone,
  finishRegistrationForPhone
} = require("./_passkey-helper");

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
    const credential = body.credential || null;

    if (!phone) {
      return json(400, { ok: false, error: "Nombor telefon tak sah." });
    }

    if (!credential || !credential.id || !credential.response) {
      return json(400, { ok: false, error: "Credential passkey tak sah." });
    }

    const done = await finishRegistrationForPhone({ phone, credential });

    return json(200, {
      ok: true,
      phone,
      user: {
        id: done.customer.id,
        name: done.customer.name || phone,
        phone: done.customer.phone || phone,
        ic: done.customer.ic || "",
        alamat: done.customer.alamat || "",
        email: done.customer.email || ""
      },
      credential_id: done.credential_id,
      message: "Face ID berjaya diaktifkan."
    });
  } catch (e) {
    console.error("passkey-register-finish error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};