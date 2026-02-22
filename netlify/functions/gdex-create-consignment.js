// netlify/functions/gdex-create-consignment.js

// ---------- Helper ----------
function mask(str) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= 4) return "****";
  return s.slice(0, 4) + "***";
}

exports.handler = async function (event, context) {
  // 1) Benarkan POST sahaja
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, message: "Method not allowed" }),
    };
  }

  // 2) ENV (LIVE dulu, kalau tiada baru fallback TEST)
  const ACCOUNT_NO =
    process.env.GDEX_ACCOUNT_NO ||
    process.env.GDEX_TEST_ACCOUNT_NO ||
    "";

  const SUB_PRIMARY =
    process.env.GDEX_SUBSCRIPTION_PRIMARY_KEY ||
    process.env.GDEX_TEST_SUBSCRIPTION_PRIMARY_KEY ||
    process.env.GDEX_TEST_SUBSCRIPTION_KEY ||
    "";

  const SUB_SECOND =
    process.env.GDEX_SUBSCRIPTION_SECONDARY_KEY ||
    process.env.GDEX_TEST_SUBSCRIPTION_SECONDARY_KEY ||
    "";

  const USER_TOKEN =
    process.env.GDEX_USER_TOKEN ||
    process.env.GDEX_TEST_USER_TOKEN ||
    "";

  // Tentukan guna demo atau live ikut env yang ada
  const IS_TEST =
    !process.env.GDEX_ACCOUNT_NO && !!process.env.GDEX_TEST_ACCOUNT_NO;

  const BASE_URL = IS_TEST
    ? "https://myopenapi.gdexpress.com/api/demo/prime"
    : "https://myopenapi.gdexpress.com/api/prime";

  console.log("ENV LOADING...", {
    MODE: IS_TEST ? "TEST" : "LIVE",
    ACCOUNT_NO,
    SUB_PRIMARY: mask(SUB_PRIMARY),
    SUB_SECOND: mask(SUB_SECOND),
    USER_TOKEN: mask(USER_TOKEN),
  });

  if (!ACCOUNT_NO || !SUB_PRIMARY || !USER_TOKEN) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        message:
          "GDEX env tidak lengkap. Pastikan GDEX_ACCOUNT_NO, GDEX_SUBSCRIPTION_PRIMARY_KEY dan GDEX_USER_TOKEN diisi (atau versi GDEX_TEST_* untuk sandbox).",
      }),
    };
  }

  // 3) Baca body dari frontend
  let incoming;
  try {
    incoming = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, message: "Body JSON tidak sah." }),
    };
  }

  console.log("INCOMING FROM FRONTEND:", incoming);

  const {
    orderCode,
    receiverName,
    receiverMobile,
    receiverEmail,
    receiverAddress1,
    receiverAddress2,
    receiverAddress3,
    receiverPostcode,
    receiverCity,
    receiverState,
    receiverCountry,
    shipmentContent,
    shipmentValue,
    shipmentWeight,
  } = incoming;

  // 4) Sediakan payload (MESTI array [ { ... } ])
  //    ➜ TIADA fallback alamat ujian; guna 100% data dari frontend.
  //    ➜ shipmentContent + note dibiarkan kosong.
  const payload = [
    {
      shipmentType: "Parcel",
      totalPiece: 1,
      shipmentContent: "",                             // kosong
      shipmentValue: Number(shipmentValue || 0),
      shipmentWeight: Number(shipmentWeight || 0.5),   // KG
      shipmentLength: 25,
      shipmentWidth: 20,
      shipmentHeight: 10,
      isDangerousGoods: false,

      // Nama besar di kotak RECEIVER — guna nama pelanggan
      companyName: receiverName || "Pelanggan Emas Amir",

      // Attention + contact
      receiverName: receiverName || "",
      receiverMobile: receiverMobile || "",
      receiverMobile2: "",
      receiverEmail: receiverEmail || "",

      // Alamat penuh ikut apa yang frontend hantar (tiada "Alamat ujian 1 / Kulim / Kedah")
      receiverAddress1: receiverAddress1 || "",
      receiverAddress2: receiverAddress2 || "",
      receiverAddress3: receiverAddress3 || "",
      receiverPostcode: receiverPostcode || "",
      receiverCity: receiverCity || "",
      receiverState: receiverState || "",
      receiverCountry: receiverCountry || "Malaysia",

      IsInsurance: false,
      note1: "",                        // kosong
      note2: "",                        // kosong
      orderID: orderCode || "",
      isCod: false,
      codAmount: 0,

      // Optional fields dari contoh GDEX – biar kosong
      doNumber1: "",
      doNumber2: "",
      doNumber3: "",
      doNumber4: "",
      doNumber5: "",
      doNumber6: "",
      doNumber7: "",
      doNumber8: "",
      doNumber9: "",
    },
  ];

  // 5) Endpoint ikut MODE (TEST / LIVE)
  const endpoint =
    BASE_URL +
    "/CreateConsignment" +
    `?accountNo=${encodeURIComponent(ACCOUNT_NO)}`;

  console.log("📡 Calling GDEX:", endpoint);
  console.log("📦 Body:", payload);

  let gdexRes, gdexText, gdexJson;

  try {
    gdexRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        ApiToken: USER_TOKEN,
        "Subscription-Key": SUB_PRIMARY,
        "Content-Type": "application/json-patch+json",
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify(payload),
    });

    gdexText = await gdexRes.text();
    try {
      gdexJson = JSON.parse(gdexText);
    } catch (e) {
      gdexJson = gdexText;
    }

    console.log("GDEX status:", gdexRes.status);
    console.log("GDEX raw:", gdexJson);
  } catch (e) {
    console.error("GDEX fetch error:", e);
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        message: "Gagal hubungi GDEX API: " + (e.message || e),
      }),
    };
  }

  // 6) Kalau bukan 2xx → pass error ke frontend
  if (!gdexRes.ok) {
    const msg =
      (gdexJson && gdexJson.message) ||
      (gdexJson && gdexJson.e) ||
      `HTTP ${gdexRes.status}`;

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: false,
        message: msg,
        raw: gdexJson,
      }),
    };
  }

  // 7) Success – cuba ambil cnNumber / CNxxx
  let awbNo = null;

  if (Array.isArray(gdexJson?.r)) {
    // Contoh: { s:'success', r:['CN3700...'], e:'' }
    if (typeof gdexJson.r[0] === "string") {
      awbNo = gdexJson.r[0];
    } else if (gdexJson.r[0]?.cnNumber) {
      awbNo = gdexJson.r[0].cnNumber;
    }
  } else if (Array.isArray(gdexJson) && gdexJson[0]?.cnNumber) {
    awbNo = gdexJson[0].cnNumber;
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok: true,
      awbNo,
      raw: gdexJson,
    }),
  };
};