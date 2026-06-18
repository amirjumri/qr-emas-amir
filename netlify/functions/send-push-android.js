const admin = require("firebase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function initFirebase() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Firebase JSON missing");

  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const token = String(body.deviceToken || "").trim();
   const title = body.title || "Emas Amir";
const message = body.body || "Ada mesej baru";
const url = String(body.url || body.deeplink || body.target_url || "/chat.html");

    if (!token) {
      return json(400, { success: false, error: "No token" });
    }

    const fb = initFirebase();

   const res = await fb.messaging().send({
  token,
  notification: {
    title,
    body: message,
  },
  data: {
    url,
    deeplink: url,
    target_url: url,
    source: "emasamir_chat",
  },
  android: {
    priority: "high",
    notification: {
      sound: "default",
    },
  },
});

    console.log("FCM SENT:", res);

    return json(200, { success: true, messageId: res });

  } catch (err) {
    console.error("FCM ERROR:", err);
    return json(500, { success: false, error: err.message });
  }
};