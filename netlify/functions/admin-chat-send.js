const { createClient } = require("@supabase/supabase-js");
const webpush = require("web-push");

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

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;
  return d;
}

function phoneVariants(e164) {
  const d = normalizePhone(e164);
  if (!d) return [];
  const out = new Set([d, "+" + d]);
  if (d.startsWith("60")) out.add("0" + d.slice(2));
  return Array.from(out);
}

async function verifyAdmin(supabase, adminPhone) {
  const p = normalizePhone(adminPhone);
  if (!p) return false;

  const variants = phoneVariants(p);

  const q = await supabase
    .from("admin_users")
    .select("phone,is_active")
    .in("phone", variants)
    .eq("is_active", true)
    .limit(1);

  return !q.error && Array.isArray(q.data) && q.data.length > 0;
}

function cutText(s, n = 120) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > n ? (t.slice(0, n - 3) + "...") : t;
}

async function sendPushToOne(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (e) {
    const code = Number(e?.statusCode || 0);

    if (code === 404 || code === 410) {
      return { ok: false, expired: true, error: e?.message || String(e) };
    }

    return { ok: false, expired: false, error: e?.message || String(e) };
  }
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

   const adminPhone = body.admin_phone || "";
const threadId = String(body.thread_id || "").trim();
const message = String(body.message || "").trim();
const attachment = body.attachment || null;
const replyToMessageId = String(body.reply_to_message_id || "").trim();

    if (!threadId) {
      return json(400, { ok: false, error: "thread_id diperlukan." });
    }

    if (!message && !(attachment && attachment.url)) {
      return json(400, { ok: false, error: "Mesej atau attachment diperlukan." });
    }

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
    const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
    const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || "mailto:support@emasamir.app").trim();

    if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(
        VAPID_SUBJECT,
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
      );
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const isAdmin = await verifyAdmin(supabase, adminPhone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    const threadQ = await supabase
      .from("chat_threads")
      .select("id,customer_phone,meta")
      .eq("id", threadId)
      .single();

    if (threadQ.error) throw threadQ.error;

    const customerPhone = normalizePhone(threadQ.data?.customer_phone || "");
    const metaNow = threadQ.data?.meta || {};
    const wasAdminMode = metaNow.admin_mode === true;

let replyPreview = null;

if (replyToMessageId) {
  const replyQ = await supabase
    .from("chat_messages")
    .select("id,role,text,meta")
    .eq("thread_id", threadId)
    .eq("id", replyToMessageId)
    .maybeSingle();

  if (replyQ.error) throw replyQ.error;

  if (replyQ.data) {
    const src = replyQ.data;
    const srcMeta = src.meta || {};

    let roleLabel = "Mesej";
    if (String(src.role || "").toLowerCase() === "customer") {
      roleLabel = "Customer";
    } else if (srcMeta.admin_reply === true || String(src.role || "").toLowerCase() === "admin") {
      roleLabel = "Admin";
    } else if (String(src.role || "").toLowerCase() === "system") {
      roleLabel = "System";
    } else {
      roleLabel = "AI";
    }

    replyPreview = {
      id: src.id,
      role: src.role || "",
      role_label: roleLabel,
      text: String(src.text || "").trim() || "(lampiran)"
    };
  }
}

   const insertPayload = {
  thread_id: threadId,
  role: "ai",
  text: message || "(lampiran)",
  meta: {
    admin_reply: true,
    sent_by_admin_phone: normalizePhone(adminPhone),
    reply_to: replyToMessageId || null,
    reply_preview: replyPreview,
    attachment: attachment && attachment.url ? {
      url: attachment.url || "",
      name: attachment.name || "",
      mime: attachment.mime || ""
    } : null
  }
};

    const ins = await supabase
      .from("chat_messages")
      .insert(insertPayload)
      .select("id,thread_id,role,text,created_at,meta")
      .single();

    if (ins.error) throw ins.error;

    if (!wasAdminMode) {
      const sysIns = await supabase
        .from("chat_messages")
        .insert({
          thread_id: threadId,
          role: "system",
          text: "🟠 MODE: ADMIN MANUAL\nAdmin sedang balas chat ini.",
          meta: {
            system: "admin_mode_on"
          }
        });

      if (sysIns.error) throw sysIns.error;
    }

    const adminSentAt = ins.data?.created_at || new Date().toISOString();

    const up = await supabase
      .from("chat_threads")
      .update({
        last_message_at: adminSentAt,
        last_admin_message_at: adminSentAt,
        meta: {
          ...metaNow,
          admin_mode: true
        }
      })
      .eq("id", threadId);

    if (up.error) throw up.error;

    // =========================
    // PUSH NOTIFICATION KE CUSTOMER
    // =========================
    let pushAttempted = false;
    let pushSent = 0;
    let pushExpired = 0;
    let pushFailed = 0;

    if (customerPhone && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
      const subQ = await supabase
        .from("chat_push_subscriptions")
        .select("id,customer_phone,thread_id,endpoint,p256dh,auth,is_active,created_at")
        .eq("customer_phone", customerPhone)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(20);

      if (subQ.error) throw subQ.error;

      if (Array.isArray(subQ.data) && subQ.data.length) {
        pushAttempted = true;

        const seenEndpoints = new Set();
        const subs = [];

        for (const row of subQ.data) {
          const endpoint = String(row.endpoint || "").trim();
          if (!endpoint) continue;
          if (seenEndpoints.has(endpoint)) continue;

          seenEndpoints.add(endpoint);
          subs.push(row);
        }

        const bodyText = message
          ? cutText(message, 120)
          : (attachment?.name ? `Admin hantar fail: ${attachment.name}` : "Admin balas chat anda");

        const payload = {
          title: "Emas Amir",
          body: bodyText || "Admin balas chat anda",
          url: `/chat.html?phone=${encodeURIComponent(customerPhone)}&thread=${encodeURIComponent(threadId)}`,
          tag: `ea-chat-${threadId}`,
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png"
        };

        for (const row of subs) {
          const subscription = {
            endpoint: String(row.endpoint || ""),
            keys: {
              p256dh: String(row.p256dh || ""),
              auth: String(row.auth || "")
            }
          };

          const result = await sendPushToOne(subscription, payload);

          if (result.ok) {
            pushSent += 1;
          } else if (result.expired) {
            pushExpired += 1;

            try {
              const deact = await supabase
                .from("chat_push_subscriptions")
                .update({
                  is_active: false,
                  updated_at: new Date().toISOString()
                })
                .eq("id", row.id);

              if (deact.error) {
                console.error("deactivate expired push sub error:", deact.error);
              }
            } catch (_) {}
          } else {
            pushFailed += 1;
            console.error("push send fail:", row.id, result.error);
          }
        }
      }
    }

// =========================
// 🔥 PUSH iPHONE (APNs)
// =========================
let iosPushSent = 0;
let iosPushFailed = 0;

try {
  const tokenQ = await supabase
    .from("chat_device_tokens")
    .select("id,customer_phone,device_token,platform,is_active,created_at,updated_at")
    .eq("customer_phone", customerPhone)
    .eq("is_active", true)
    .eq("platform", "ios")
    .order("updated_at", { ascending: false })
    .limit(20);

  if (tokenQ.error) throw tokenQ.error;

  if (Array.isArray(tokenQ.data) && tokenQ.data.length) {
    const bodyText = message
      ? cutText(message, 120)
      : (attachment?.name ? `Admin hantar fail: ${attachment.name}` : "Admin balas chat anda");

    const seenTokens = new Set();
    const rows = [];

    for (const row of tokenQ.data) {
      const token = String(row.device_token || "").trim();
      if (!token) continue;
      if (seenTokens.has(token)) continue;

      seenTokens.add(token);
      rows.push(row);
    }

    console.log("iOS tokens found:", rows.map(r => ({
      id: r.id,
      token: r.device_token,
      created_at: r.created_at,
      updated_at: r.updated_at
    })));

    for (const row of rows) {
      const deviceToken = String(row.device_token || "").trim();
      if (!deviceToken) continue;

      try {
        const res = await fetch("https://emasamir.app/.netlify/functions/send-push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceToken,
            title: "Emas Amir",
            body: bodyText
          })
        });

        const jsonRes = await res.json().catch(() => ({}));

        console.log("iOS push result:", {
          token_id: row.id,
          device_token: deviceToken,
          response: jsonRes
        });

        const failedCount = Array.isArray(jsonRes?.failed) ? jsonRes.failed.length : 0;
        const sentCount = Array.isArray(jsonRes?.sent) ? jsonRes.sent.length : 0;
        const reason = jsonRes?.failed?.[0]?.response?.reason || "";

        if (jsonRes?.success && sentCount > 0 && failedCount === 0) {
          iosPushSent += 1;

          try {
            const touchOk = await supabase
              .from("chat_device_tokens")
              .update({ updated_at: new Date().toISOString() })
              .eq("id", row.id);

            if (touchOk.error) {
              console.error("Update iOS token updated_at error:", touchOk.error);
            }
          } catch (touchErr) {
            console.error("Update iOS token updated_at catch:", touchErr);
          }
        } else {
          iosPushFailed += 1;
          console.error("iOS push fail:", {
            token_id: row.id,
            device_token: deviceToken,
            reason,
            response: jsonRes
          });

          if (reason === "BadDeviceToken" || reason === "Unregistered") {
            try {
              const deact = await supabase
                .from("chat_device_tokens")
                .update({
                  is_active: false,
                  updated_at: new Date().toISOString()
                })
                .eq("id", row.id);

              if (deact.error) {
                console.error("Deactivate bad iOS token error:", deact.error);
              } else {
                console.log("Deactivated bad iOS token:", row.id, reason);
              }
            } catch (deactErr) {
              console.error("Deactivate bad iOS token catch:", deactErr);
            }
          }
        }
      } catch (err) {
        iosPushFailed += 1;
        console.error("iOS push error:", {
          token_id: row.id,
          device_token: deviceToken,
          error: err?.message || String(err)
        });
      }
    }
  }
} catch (err) {
  console.error("iOS push block error:", err);
}

// =========================
// 🔥 PUSH ANDROID (FCM)
// =========================
let androidPushSent = 0;
let androidPushFailed = 0;

try {
  const tokenQ = await supabase
    .from("chat_device_tokens")
    .select("id,customer_phone,device_token,platform,token_type,is_active,created_at,updated_at")
    .eq("customer_phone", customerPhone)
    .eq("is_active", true)
    .eq("platform", "android")
    .order("updated_at", { ascending: false })
    .limit(20);

  if (tokenQ.error) throw tokenQ.error;

  if (Array.isArray(tokenQ.data) && tokenQ.data.length) {
    const bodyText = message
      ? cutText(message, 120)
      : (attachment?.name ? `Admin hantar fail: ${attachment.name}` : "Admin balas chat anda");

    const seenTokens = new Set();
    const rows = [];

    for (const row of tokenQ.data) {
      const token = String(row.device_token || "").trim();
      if (!token) continue;
      if (seenTokens.has(token)) continue;

      seenTokens.add(token);
      rows.push(row);
    }

    console.log("Android tokens found:", rows.map(r => ({
      id: r.id,
      token_type: r.token_type,
      token: r.device_token,
      updated_at: r.updated_at
    })));

    for (const row of rows) {
      const deviceToken = String(row.device_token || "").trim();
      if (!deviceToken) continue;

      try {
        const res = await fetch("https://earnest-bombolone-4d2e8a.netlify.app/.netlify/functions/send-push-android", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deviceToken,
            platform: "fcm",
            token_type: "fcm",
            title: "Emas Amir",
            body: bodyText,
            url: "/chat.html"
          })
        });

        const jsonRes = await res.json().catch(() => ({}));

        console.log("Android push result:", {
          token_id: row.id,
          response: jsonRes
        });

        if (jsonRes?.success) {
          androidPushSent += 1;

          await supabase
            .from("chat_device_tokens")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", row.id);
        } else {
          androidPushFailed += 1;
          console.error("Android push fail:", {
            token_id: row.id,
            response: jsonRes
          });
        }
      } catch (err) {
        androidPushFailed += 1;
        console.error("Android push error:", {
          token_id: row.id,
          error: err?.message || String(err)
        });
      }
    }
  }
} catch (err) {
  console.error("Android push block error:", err);
}

return json(200, {
  ok: true,
  message: ins.data,
  push: {
    attempted: pushAttempted,
    sent: pushSent,
    expired_removed: pushExpired,
    failed: pushFailed
  },
  ios: {
    sent: iosPushSent,
    failed: iosPushFailed
  },
  android: {
    sent: androidPushSent,
    failed: androidPushFailed
  }
});



  } catch (e) {
    console.error("admin-chat-send error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};