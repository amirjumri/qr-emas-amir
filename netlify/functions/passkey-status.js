const {
  json,
  normalizePhone,
  passkeyStatus
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
    if (!phone) {
      return json(400, { ok: false, error: "Nombor telefon tak sah." });
    }

    const stat = await passkeyStatus(phone);

    return json(200, {
      ok: true,
      phone,
      registered: !!stat.registered,
      count: Number(stat.count || 0)
    });
  } catch (e) {
    console.error("passkey-status error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};