const webpush = require("web-push");
const { createClient } = require("@supabase/supabase-js");

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
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(obj)
  };
}

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;
  return d;
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Body JSON tak sah" });
    }

    const threadId = String(body.thread_id || "").trim() || null;
    const rawPhone = String(body.customer_phone || "").trim();
    const customerPhone = normalizePhone(rawPhone);

    const title = String(body.title || "Emas Amir").trim() || "Emas Amir";
    const msgBody = String(body.body || "Anda ada mesej baru.").trim() || "Anda ada mesej baru.";
    const url = String(body.url || "/chat.html").trim() || "/chat.html";
    const tag = String(body.tag || "ea-chat-notify").trim() || "ea-chat-notify";

    if (!threadId && !customerPhone) {
      return json(400, {
        ok: false,
        error: "thread_id atau customer_phone diperlukan."
      });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const vapidPublicKey = String(process.env.VAPID_PUBLIC_KEY || "").trim();
    const vapidPrivateKey = String(process.env.VAPID_PRIVATE_KEY || "").trim();
    const vapidSubject = String(process.env.VAPID_SUBJECT || "").trim();

    if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
      return json(500, {
        ok: false,
        error: "VAPID env belum lengkap."
      });
    }

    webpush.setVapidDetails(
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey
    );

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    let q = supabase
      .from("chat_push_subscriptions")
      .select("id,customer_phone,thread_id,endpoint,p256dh,auth,is_active")
      .eq("is_active", true);

    if (threadId) {
      q = q.eq("thread_id", threadId);
    } else {
      q = q.eq("customer_phone", customerPhone);
    }

    const subQ = await q;
    if (subQ.error) throw subQ.error;

    const rows = Array.isArray(subQ.data) ? subQ.data : [];
    if (!rows.length) {
      return json(200, {
        ok: true,
        sent: 0,
        failed: 0,
        message: "Tiada subscription aktif dijumpai."
      });
    }

    const payload = JSON.stringify({
      title,
      body: msgBody,
      url,
      tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png"
    });

    let sent = 0;
    let failed = 0;

    for (const row of rows) {
      const subscription = {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth
        }
      };

      try {
        await webpush.sendNotification(subscription, payload);
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error("push send fail:", row.id, err?.statusCode, err?.body || err?.message || err);

        const statusCode = Number(err?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await supabase
            .from("chat_push_subscriptions")
            .update({
              is_active: false,
              updated_at: new Date().toISOString()
            })
            .eq("id", row.id);
        }
      }
    }

    return json(200, {
      ok: true,
      sent,
      failed
    });

  } catch (e) {
    console.error("chat-push-send error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};