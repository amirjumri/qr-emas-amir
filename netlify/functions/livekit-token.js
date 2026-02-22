const crypto = require("crypto");

function base64url(obj) {
  const json = typeof obj === "string" ? obj : JSON.stringify(obj);
  return Buffer.from(json)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = base64url(header);
  const p = base64url(payload);
  const data = `${h}.${p}`;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${sig}`;
}

exports.handler = async (event) => {
  // CORS basic
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "Method Not Allowed",
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const role = body.role === "host" ? "host" : "viewer";
    const room = String(body.room || "").trim() || "emasamir-room";
    const identity =
      String(body.identity || "").trim() ||
      (role === "host" ? "host-1" : "viewer-" + Date.now());

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !livekitUrl) {
      console.error("LiveKit env missing");
      return {
        statusCode: 500,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "LiveKit env not configured" }),
      };
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = now + 60 * 60; // token sah 1 jam

    const videoGrant =
      role === "host"
        ? {
            room,
            roomJoin: true,
            roomAdmin: true,
            canPublish: true,
            canSubscribe: true,
          }
        : {
            room,
            roomJoin: true,
            roomAdmin: false,
            canPublish: false,
            canSubscribe: true,
          };

    const payload = {
      iss: apiKey,
      sub: identity,
      iat: now,
      exp,
      video: videoGrant,
    };

    const token = signJwt(payload, apiSecret);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        token,
        url: livekitUrl,
        role,
        room,
        identity,
      }),
    };
  } catch (e) {
    console.error("livekit-token error", e);
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Token error", detail: String(e.message || e) }),
    };
  }
};