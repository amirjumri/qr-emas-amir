// netlify/functions/gdex-create-awb.js

// Netlify (Node 18+) dah ada fetch global

function mask(str) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= 4) return "****";
  return s.slice(0, 4) + "***";
}

exports.handler = async (event) => {
  // Hanya benarkan POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  // --- ENV VARS ---
  const SUBS_KEY   = process.env.GDEX_TEST_SUBSCRIPTION_KEY;
  const USER_TOKEN = process.env.GDEX_TEST_USER_TOKEN;
  const ACCOUNT_NO = process.env.GDEX_ACCOUNT_NO || "1303781";

  console.log("ENV LOADING...", {
    ACCOUNT_NO,
    SUBS_KEY: mask(SUBS_KEY),
    USER_TOKEN: mask(USER_TOKEN),
  });

  if (!SUBS_KEY || !USER_TOKEN) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "GDEX_TEST_SUBSCRIPTION_KEY / GDEX_TEST_USER_TOKEN tiada dalam environment."
      })
    };
  }

  // --- Baca body dari frontend ---
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Body bukan JSON yang sah." })
    };
  }

  const {
    order_code,
    mode = "test",
    receiver = {},
    parcel = {}
  } = payload || {};

  if (!order_code) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "order_code wajib dihantar." })
    };
  }

  if (
    !receiver.name ||
    !receiver.address1 ||
    !receiver.postcode ||
    !receiver.city ||
    !receiver.phone
  ) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error:
          "Receiver info tak lengkap. name, address1, postcode, city, phone wajib."
      })
    };
  }

  // ====== BODY REQUEST UNTUK GDEX (ikut CreateConsignment) ======
  const shipment = {
    shipmentType: "Parcel",
    totalPiece: parcel.pieces || 1,
    shipmentContent: parcel.content || "Gold jewellery 916",
    shipmentValue: Number(parcel.valueRm || 0),
    shipmentWeight: Number(parcel.weightKg || 0.5),
    shipmentLength: parcel.length || 25,
    shipmentWidth: parcel.width || 20,
    shipmentHeight: parcel.height || 10,
    isDangerousGoods: false,

    companyName: "EMAS AMIR SDN BHD",

    receiverName: receiver.name,
    receiverMobile: receiver.phone,
    receiverMobile2: "",
    receiverEmail: receiver.email || "",
    receiverAddress1: receiver.address1,
    receiverAddress2: receiver.address2 || "",
    receiverAddress3: receiver.address3 || "",
    receiverPostcode: receiver.postcode,
    receiverCity: receiver.city,
    receiverState: receiver.state || "",
    receiverCountry: receiver.country || "Malaysia",

    IsInsurance: false,
    note1: parcel.note1 || parcel.content || "Gold jewellery 916",
    note2: order_code,
    orderID: order_code,
    isCod: !!parcel.isCod,
    codAmount: Number(parcel.codAmount || 0),

    doNumber1: "",
    doNumber2: "",
    doNumber3: "",
    doNumber4: "",
    doNumber5: "",
    doNumber6: "",
    doNumber7: "",
    doNumber8: "",
    doNumber9: ""
  };

  const gdexPayload = [shipment]; // MESTI ARRAY

  // ====== ENDPOINT myGDEX Prime TESTING (ikut API Explorer) ======
  const url =
    "https://myopenapi.gdexpress.com/api/demo/prime/CreateConsignment" +
    `?accountNo=${encodeURIComponent(ACCOUNT_NO)}`;

  console.log("📡 Calling GDEX:", url);
  console.log("📦 Body:", gdexPayload);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ApiToken: USER_TOKEN,               // Sandbox User Token
        "Subscription-Key": SUBS_KEY,       // Subscription key (Testing)
        "Content-Type": "application/json-patch+json",
        "Cache-Control": "no-cache"
      },
      body: JSON.stringify(gdexPayload)
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    console.log("GDEX status:", res.status);
    console.log("GDEX raw:", json);

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GDEX API error",
          status: res.status,
          response: json
        })
      };
    }

    // ====== EXTRACT AWB / CN ======
    let awbNo = null;

    // Format baru: { s: 'success', r: ['CNxxxx'], e: '' }
    if (Array.isArray(json?.r) && typeof json.r[0] === "string") {
      awbNo = json.r[0];

    // Format lama: { r: [ { cnNumber: 'CNxxxx' } ] }
    } else if (Array.isArray(json?.r) && json.r[0]?.cnNumber) {
      awbNo = json.r[0].cnNumber;

    // Fallback lain-lain
    } else if (typeof json?.cnNumber === "string") {
      awbNo = json.cnNumber;
    } else if (json?.data?.cnNumber) {
      awbNo = json.data.cnNumber;
    }

    console.log("AWB extracted:", awbNo);

    if (!awbNo) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "GDEX response tiada field nombor AWB. Sila semak mapping.",
          response: json
        })
      };
    }

    // HANTAR KEDUA-DUA: awbNo (camelCase) & awb_no (snake_case) untuk selamat
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        awbNo,          // frontend boleh baca data.awbNo
        awb_no: awbNo,  // kalau ada code lama yang guna awb_no
        gdex_response: json
      })
    };
  } catch (e) {
    console.error("GDEX create AWB error:", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Ralat semasa call GDEX API.",
        message: e.message || String(e)
      })
    };
  }
};