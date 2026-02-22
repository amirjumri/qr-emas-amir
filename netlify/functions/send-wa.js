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

    // ✅ sokong lampiran (kita embed sebagai link dalam text)
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

    // ✅ message boleh kosong jika ada file_url
    if (!phone_number || (!message && !file_url)) {
      return json(400, {
        ok: false,
        error: "phone_number required, and either message or file_url"
      });
    }

    const base = process.env.ONSEND_BASE || "https://onsend.io/api/v1";

    let finalMessage = message || "Lampiran";
    if (file_url) {
      finalMessage += `\n\n📎 ${file_name ? file_name + "\n" : ""}${file_url}`;
    }

    const r = await fetch(base + "/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.ONSEND_TOKEN
      },
      body: JSON.stringify({
        phone_number,
        message: finalMessage,
        type: "text"
      })
    });

    const j = await r.json().catch(() => ({}));
    return json(r.ok ? 200 : r.status, { ok: r.ok, data: j });

  } catch (e) {
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