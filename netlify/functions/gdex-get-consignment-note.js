// netlify/functions/gdex-get-consignment-note.js

function mask(str) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= 4) return "****";
  return s.slice(0, 4) + "***";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const SUBS_KEY   = process.env.GDEX_TEST_SUBSCRIPTION_KEY;
  const USER_TOKEN = process.env.GDEX_TEST_USER_TOKEN;
  const ACCOUNT_NO = process.env.GDEX_ACCOUNT_NO || "1303781";

  // ❗ WAJIB: set dalam Netlify → GDEX_TEST_NOTE_PATH
  // Contoh dari Request URL:
  //  POST https://myopenapi.gdexpress.com/api/demo/prime/GetConsignmentNote
  //  → PATH = "/api/demo/prime/GetConsignmentNote"
  const NOTE_PATH  = process.env.GDEX_TEST_NOTE_PATH;

  console.log("ENV NOTE...", {
    ACCOUNT_NO,
    SUBS_KEY: mask(SUBS_KEY),
    USER_TOKEN: mask(USER_TOKEN),
    NOTE_PATH,
  });

  if (!SUBS_KEY || !USER_TOKEN || !NOTE_PATH) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "Env GDEX_TEST_SUBSCRIPTION_KEY / GDEX_TEST_USER_TOKEN / GDEX_TEST_NOTE_PATH tak lengkap.",
      }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Body bukan JSON yang sah." }),
    };
  }

  const { cn_no } = body;
  if (!cn_no) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "cn_no (consignment number) wajib." }),
    };
  }

  // Biasanya request body simple – ikut docs GDEX
  const gdexPayload = {
    accountNo: ACCOUNT_NO,
    cnNumber: cn_no,
  };

  const url = "https://myopenapi.gdexpress.com" + NOTE_PATH;

  console.log("📡 GDEX NOTE URL:", url);
  console.log("📦 NOTE payload:", gdexPayload);

  try {
    const res = await fetch(url, {
      method: "POST", // kalau docs kata GET, tukar ke GET & buang body
      headers: {
        ApiToken: USER_TOKEN,
        "Subscription-Key": SUBS_KEY,
        "Content-Type": "application/json", // rujuk API Explorer, tukar kalau lain
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify(gdexPayload),
    });

    const buf = await res.arrayBuffer();
    const text = Buffer.from(buf).toString("utf8");

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // Kalau terus bagi PDF binary, bukan JSON
      json = null;
    }

    console.log("GDEX NOTE status:", res.status);

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GDEX Note API error",
          status: res.status,
          response: json || "non-JSON response",
        }),
      };
    }

    // 2 kemungkinan:
    //  a) Response JSON (cth: { s:'success', r:'base64-pdf', e:'' })
    //  b) Response terus PDF (Content-Type: application/pdf)
    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("application/pdf")) {
      // Terus proxy PDF ke browser
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${cn_no}.pdf"`,
        },
        body: Buffer.from(buf).toString("base64"),
        isBase64Encoded: true,
      };
    }

    // Kalau JSON → pulangkan JSON ke frontend
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        gdex_response: json,
      }),
    };
  } catch (e) {
    console.error("GDEX get note error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Ralat semasa panggil GDEX Note API.",
        message: e.message || String(e),
      }),
    };
  }
};