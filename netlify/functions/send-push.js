const apn = require("apn");
const admin = require("firebase-admin");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function getEnv(name) {
  return String(process.env[name] || "").trim();
}

function initFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const projectId = getEnv("FIREBASE_PROJECT_ID");
  const clientEmail = getEnv("FIREBASE_CLIENT_EMAIL");
  const privateKey = getEnv("FIREBASE_PRIVATE_KEY").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase env missing");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    }),
  });

  return admin;
}
function getPrivateKey() {
  const raw = String(process.env.APNS_PRIVATE_KEY || "").trim();

  if (!raw) {
    throw new Error("APNS_PRIVATE_KEY tiada dalam environment variable");
  }

  const normalized = raw
    .replace(/^"(.*)"$/s, "$1")
    .replace(/^'(.*)'$/s, "$1")
    .replace(/\\n/g, "\n")
    .trim();

  if (
    !normalized.includes("-----BEGIN PRIVATE KEY-----") ||
    !normalized.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error(
      "APNS_PRIVATE_KEY tidak sah. Pastikan isi penuh fail .p8 dimasukkan ke environment variable."
    );
  }

  return normalized;
}

function createProvider() {
  const key = getPrivateKey();
  const keyId = getEnv("APNS_KEY_ID");
  const teamId = getEnv("APNS_TEAM_ID");

  if (!keyId) {
    throw new Error("APNS_KEY_ID tiada dalam environment variable");
  }

  if (!teamId) {
    throw new Error("APNS_TEAM_ID tiada dalam environment variable");
  }

  return new apn.Provider({
    token: {
      key,
      keyId,
      teamId,
    },
    production: true,
  });
}

exports.handler = async (event) => {
  let provider;

  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
        },
        body: "",
      };
    }

    if (event.httpMethod && event.httpMethod !== "POST") {
      return json(405, {
        success: false,
        error: "Method not allowed",
      });
    }

    let payload = {};

    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, {
        success: false,
        error: "Body JSON tidak sah",
      });
    }

    const deviceToken = String(payload.deviceToken || payload.token || "").trim();
    const platform = String(payload.platform || payload.token_type || "").trim().toLowerCase();

    const title = String(payload.title || "Emas Amir").trim();
    const body = String(payload.body || "Anda ada mesej baru").trim();

    const isProbablyFcm = deviceToken.includes(":") || deviceToken.length > 120;
const isAndroid = platform === "android" || platform === "fcm" || isProbablyFcm;

    if (!deviceToken) {
      return json(400, {
        success: false,
        error: "deviceToken diperlukan",
      });
    }

    // ===== ANDROID FCM — TAMBAHAN BARU, TAK KACAU APNS IPHONE =====
    if (isAndroid) {
      const fb = initFirebaseAdmin();

      const message = {
        token: deviceToken,
        notification: {
          title,
          body,
        },
        data: {
          url: String(payload.url || "/chat.html"),
          source: "emasamir_chat",
        },
        android: {
          priority: "high",
          notification: {
            sound: "default",
            channelId: "default",
          },
        },
      };

      const fcmResult = await fb.messaging().send(message);

      console.log("=== FCM ANDROID DEBUG START ===");
      console.log("DEVICE TOKEN:", deviceToken);
      console.log("FCM RESULT:", fcmResult);
      console.log("=== FCM ANDROID DEBUG END ===");

      return json(200, {
        success: true,
        platform: "android",
        sent: [{ device: deviceToken, messageId: fcmResult }],
        failed: [],
      });
    }

    // ===== IPHONE APNS — FLOW ASAL KEKAL =====
    const topic = getEnv("APNS_BUNDLE_ID");

    if (!topic) {
      throw new Error("APNS_BUNDLE_ID tiada dalam environment variable");
    }

    provider = createProvider();

    const note = new apn.Notification();
    note.alert = { title, body };
    note.sound = "default";
    note.topic = topic;

    const result = await provider.send(note, deviceToken);

    console.log("=== APNS DEBUG START ===");
    console.log("TOPIC:", topic);
    console.log("DEVICE TOKEN:", deviceToken);
    console.log("APNS RESULT:", JSON.stringify(result, null, 2));
    console.log("=== APNS DEBUG END ===");

    return json(200, {
      success: true,
      sent: result.sent || [],
      failed: result.failed || [],
    });
  } catch (err) {
    console.error("send-push error:", err);

    return json(500, {
      success: false,
      error: err.message || "Unknown error",
    });
  } finally {
    if (provider) {
      provider.shutdown();
    }
  }
};