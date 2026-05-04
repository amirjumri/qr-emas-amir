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

function phoneVariants(raw) {
  const d = normalizePhone(raw);
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
    const customerPhoneRaw = body.customer_phone || "";
    const message = String(body.message || "").trim();

    if (!customerPhoneRaw) {
      return json(400, { ok: false, error: "customer_phone diperlukan." });
    }

    if (!message) {
      return json(400, { ok: false, error: "message diperlukan." });
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

    const customerPhone = normalizePhone(customerPhoneRaw);
    const variants = phoneVariants(customerPhone);

    if (!variants.length) {
      return json(400, { ok: false, error: "customer_phone tak sah." });
    }

    // Cari thread paling latest ikut struktur sebenar chat_threads
    const threadQ = await supabase
      .from("chat_threads")
      .select("id,customer_phone,status,last_message_at,created_at,meta,last_admin_message_at,last_admin_reply_at")
      .in("customer_phone", variants)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (threadQ.error) {
      throw threadQ.error;
    }

    if (!threadQ.data?.id) {
      return json(404, {
        ok: false,
        error: "Thread AI-DAN tak dijumpai untuk nombor ini."
      });
    }

    const thread = threadQ.data;
    const metaNow = (thread.meta && typeof thread.meta === "object") ? thread.meta : {};
    const nowIso = new Date().toISOString();

    // Insert mesej ikut gaya admin thread supaya masuk dalam thread sebenar
    const ins = await supabase
      .from("chat_messages")
      .insert({
        thread_id: thread.id,
        role: "ai",
        text: message,
        created_at: nowIso,
        meta: {
          admin_reply: true,
          sent_by_admin_phone: normalizePhone(adminPhone),
          redeem_auto_notice: true,
          source: "POINT_REDEEM_APPROVED",
          attachment: null
        }
      })
      .select("id,thread_id,role,text,created_at,meta")
      .single();

    if (ins.error) {
      throw ins.error;
    }

    // Update thread timestamp supaya terus naik dalam admin / customer
    const up = await supabase
      .from("chat_threads")
      .update({
        last_message_at: nowIso,
        last_admin_message_at: nowIso,
        last_admin_reply_at: nowIso,
        meta: {
          ...metaNow,
          redeem_auto_notice_at: nowIso,
          redeem_auto_notice_by: normalizePhone(adminPhone)
        }
      })
      .eq("id", thread.id);

    if (up.error) {
      throw up.error;
    }

    // =========================
    // WEB PUSH KE CUSTOMER
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

        const payload = {
          title: "Emas Amir",
          body: cutText(message, 120) || "Ada mesej baru untuk anda",
          url: `/chat.html?phone=${encodeURIComponent(customerPhone)}&thread=${encodeURIComponent(thread.id)}`,
          tag: `ea-chat-${thread.id}`,
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
              await supabase
                .from("chat_push_subscriptions")
                .update({
                  is_active: false,
                  updated_at: new Date().toISOString()
                })
                .eq("id", row.id);
            } catch (_) {}
          } else {
            pushFailed += 1;
            console.error("web push fail:", row.id, result.error);
          }
        }
      }
    }

    // =========================
    // iPHONE PUSH (APNs)
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
        const seenTokens = new Set();
        const rows = [];

        for (const row of tokenQ.data) {
          const token = String(row.device_token || "").trim();
          if (!token) continue;
          if (seenTokens.has(token)) continue;

          seenTokens.add(token);
          rows.push(row);
        }

        for (const row of rows) {
          const deviceToken = String(row.device_token || "").trim();
          if (!deviceToken) continue;

          try {
            const res = await fetch("https://emasamir.app/.netlify/functions/send-push", {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify({
                deviceToken,
                title: "Emas Amir",
                body: cutText(message, 120) || "Ada mesej baru untuk anda"
              })
            });

            const jsonRes = await res.json().catch(() => ({}));

            const failedCount = Array.isArray(jsonRes?.failed) ? jsonRes.failed.length : 0;
            const sentCount = Array.isArray(jsonRes?.sent) ? jsonRes.sent.length : 0;
            const reason = jsonRes?.failed?.[0]?.response?.reason || "";

            if (jsonRes?.success && sentCount > 0 && failedCount === 0) {
              iosPushSent += 1;

              try {
                await supabase
                  .from("chat_device_tokens")
                  .update({
                    updated_at: new Date().toISOString()
                  })
                  .eq("id", row.id);
              } catch (_) {}
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
                  await supabase
                    .from("chat_device_tokens")
                    .update({
                      is_active: false,
                      updated_at: new Date().toISOString()
                    })
                    .eq("id", row.id);
                } catch (_) {}
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

    return json(200, {
      ok: true,
      thread_id: thread.id,
      customer_phone: customerPhone,
      message_id: ins.data?.id || null,
      push: {
        attempted: pushAttempted,
        sent: pushSent,
        expired_removed: pushExpired,
        failed: pushFailed
      },
      ios: {
        sent: iosPushSent,
        failed: iosPushFailed
      }
    });

  } catch (e) {
    console.error("admin-redeem-send-chat error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};