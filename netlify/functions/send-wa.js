// netlify/functions/send-wa.js
export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: ""
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const body = JSON.parse(event.body || "{}");
    const phone_number = body.phone_number;
    const message = String(body.message || "").trim();

    const file_url =
      body.file_url ||
      body.attachment_url ||
      body.url ||
      (body.attachment && body.attachment.url) ||
      "";

    const file_name =
      body.file_name ||
      (body.attachment && body.attachment.name) ||
      "";

    if (!phone_number || (!message && !file_url)) {
      return json(400, {
        ok: false,
        error: "phone_number required, and either message or file_url"
      });
    }

    const base = "https://onsend.io/api/v1";

    // TEST SAHAJA — lepas confirm jalan, padam balik
    const token = "";

    let finalMessage = message || "Lampiran";
    if (file_url) {
      finalMessage += `\n\n📎 ${file_name ? file_name + "\n" : ""}${file_url}`;
    }

    console.log("DEBUG send-wa has token:", !!token);
    console.log("DEBUG send-wa phone_number:", phone_number);
    console.log("DEBUG send-wa message length:", finalMessage.length);

    const r = await fetch(base + "/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({
        phone_number,
        message: finalMessage,
        type: "text"
      })
    });

    const raw = await r.text().catch(() => "");
    console.log("DEBUG send-wa status:", r.status);
    console.log("DEBUG send-wa raw response:", raw);

    let j = {};
    try {
      j = raw ? JSON.parse(raw) : {};
    } catch (_) {
      j = { raw };
    }

    return json(r.ok ? 200 : r.status, {
      ok: r.ok,
      data: j,
      debug: {
        has_token: !!token,
        status: r.status
      }
    });

  } catch (e) {
    console.log("DEBUG send-wa error:", e?.message || e);
    return json(500, { ok: false, error: e.message });
  }
}

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