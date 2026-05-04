// netlify/functions/gdex-track.js

function mask(str) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= 4) return "****";
  return s.slice(0, 4) + "***";
}

exports.handler = async function(event){
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok:false, message:"Method not allowed" })
    };
  }

  const SUB_PRIMARY =
    process.env.GDEX_SUBSCRIPTION_PRIMARY_KEY ||
    process.env.GDEX_TEST_SUBSCRIPTION_PRIMARY_KEY ||
    process.env.GDEX_TEST_SUBSCRIPTION_KEY ||
    "";

  const USER_TOKEN =
    process.env.GDEX_USER_TOKEN ||
    process.env.GDEX_TEST_USER_TOKEN ||
    "";

  const IS_TEST =
    !process.env.GDEX_ACCOUNT_NO && !!process.env.GDEX_TEST_ACCOUNT_NO;

  const BASE_URL = IS_TEST
    ? "https://myopenapi.gdexpress.com/api/demo/prime"
    : "https://myopenapi.gdexpress.com/api/prime";

  console.log("GDEX TRACK ENV:", {
    MODE: IS_TEST ? "TEST" : "LIVE",
    SUB_PRIMARY: mask(SUB_PRIMARY),
    USER_TOKEN: mask(USER_TOKEN)
  });

  if (!SUB_PRIMARY || !USER_TOKEN) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok:false,
        message:"GDEX env tidak lengkap. Pastikan GDEX_SUBSCRIPTION_PRIMARY_KEY dan GDEX_USER_TOKEN diisi."
      })
    };
  }

  const qs = event.queryStringParameters || {};
  const consignmentNumber = String(qs.consignmentNumber || qs.cn || "").trim();
  const orderID = String(qs.orderID || "").trim();

  if (!consignmentNumber && !orderID) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok:false,
        message:"consignmentNumber atau orderID diperlukan."
      })
    };
  }

  const url = new URL(BASE_URL + "/GetShipmentStatusDetail");

  if (consignmentNumber) {
    url.searchParams.set("consignmentNumber", consignmentNumber);
  }

  if (orderID) {
    url.searchParams.set("orderID", orderID);
  }

  let gdexRes, gdexText, gdexJson;

  try {
    gdexRes = await fetch(url.toString(), {
      method: "GET",
      headers: {
        ApiToken: USER_TOKEN,
        "Subscription-Key": SUB_PRIMARY,
        "Accept": "application/json",
        "Cache-Control": "no-cache"
      }
    });

    gdexText = await gdexRes.text();

    try {
      gdexJson = JSON.parse(gdexText);
    } catch (_) {
      gdexJson = { raw: gdexText };
    }

    console.log("GDEX TRACK status:", gdexRes.status);
    console.log("GDEX TRACK raw:", gdexJson);

  } catch (e) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok:false,
        message:"Gagal hubungi GDEX API: " + (e.message || e)
      })
    };
  }

  if (!gdexRes.ok || gdexJson.s === "fail") {
    return {
      statusCode: gdexRes.status || 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok:false,
        message: gdexJson.e || "GDEX tracking gagal.",
        raw: gdexJson
      })
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ok:true,
      data: gdexJson.r || null,
      raw: gdexJson
    })
  };
};