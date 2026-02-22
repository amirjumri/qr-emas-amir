export async function handler(event) {
  try {
    const { phone_number, message } = JSON.parse(event.body || "{}");
    if (!phone_number || !message) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error:"phone_number & message required" }) };
    }

    const r = await fetch(process.env.ONSEND_BASE + "/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.ONSEND_TOKEN
      },
      body: JSON.stringify({
        phone_number,
        message,
        type: "text"
      })
    });

    const j = await r.json().catch(()=> ({}));
    return { statusCode: r.ok ? 200 : r.status, body: JSON.stringify({ ok: r.ok, data: j }) };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: e.message }) };
  }
}