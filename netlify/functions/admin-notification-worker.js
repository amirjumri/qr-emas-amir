const { createClient } = require("@supabase/supabase-js");
const { schedule } = require("@netlify/functions");

function json(statusCode, body){
  return {
    statusCode,
    headers: {
      "Content-Type":"application/json",
      "Access-Control-Allow-Origin":"*"
    },
    body: JSON.stringify(body)
  };
}

function normalizePhone(raw){
  let d = String(raw || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;
  return d;
}

function personalizeMessage(template, customerName){
  const name = String(customerName || "Cik").trim() || "Cik";

  return String(template || "")
    .replaceAll("{{nama}}", name)
    .replaceAll("{{name}}", name)
    .replaceAll("{nama}", name)
    .replaceAll("{name}", name);
}

function cutText(s, n = 120){
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > n ? (t.slice(0, n - 3) + "...") : t;
}

async function sendIosPushSafe({ supabase, phone, title, body, url }){
  const p = normalizePhone(phone);
  if (!p) return;

  try{
    console.log("🍎 iOS PUSH CHECK:", p);

    const tokenQ = await supabase
      .from("chat_device_tokens")
      .select("id,customer_phone,device_token,platform,is_active,created_at,updated_at")
      .eq("customer_phone", p)
      .eq("is_active", true)
      .eq("platform", "ios")
      .order("updated_at", { ascending:false })
      .limit(20);

    if (tokenQ.error) throw tokenQ.error;

    const seenTokens = new Set();
    const rows = [];

    for (const row of (tokenQ.data || [])){
      const token = String(row.device_token || "").trim();
      if (!token) continue;
      if (seenTokens.has(token)) continue;
      seenTokens.add(token);
      rows.push(row);
    }

    console.log("🍎 iOS TOKEN COUNT:", rows.length);

    for (const row of rows){
      const deviceToken = String(row.device_token || "").trim();
      if (!deviceToken) continue;

      try{
        const res = await fetch("https://emasamir.app/.netlify/functions/send-push", {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify({
            deviceToken,
            title: title || "Emas Amir",
            body: cutText(body || "Notifikasi Emas Amir", 120),
            url: url || "/chat.html"
          })
        });

        const jsonRes = await res.json().catch(() => ({}));

        console.log("🍎 iOS PUSH RESULT:", {
          token_id: row.id,
          response: jsonRes
        });

        const failedCount = Array.isArray(jsonRes?.failed) ? jsonRes.failed.length : 0;
        const sentCount = Array.isArray(jsonRes?.sent) ? jsonRes.sent.length : 0;
        const reason = jsonRes?.failed?.[0]?.response?.reason || "";

        if (jsonRes?.success && sentCount > 0 && failedCount === 0){
          await supabase
            .from("chat_device_tokens")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", row.id);
        } else {
          console.error("🍎 iOS PUSH FAIL:", {
            token_id: row.id,
            reason,
            response: jsonRes
          });

          if (reason === "BadDeviceToken" || reason === "Unregistered"){
            await supabase
              .from("chat_device_tokens")
              .update({
                is_active: false,
                updated_at: new Date().toISOString()
              })
              .eq("id", row.id);
          }
        }

      }catch(err){
        console.error("🍎 iOS PUSH ERROR ONE:", {
          token_id: row.id,
          error: err?.message || String(err)
        });
      }
    }

  }catch(e){
    console.error("❌ iOS PUSH BLOCK ERROR:", {
      phone: p,
      error: e.message || String(e)
    });
  }
}

async function sendAndroidPushSafe({ supabase, phone, title, body, url }){
  const p = normalizePhone(phone);
  if (!p) return;

  try{
    console.log("🤖 ANDROID PUSH CHECK:", p);

    const { data, error } = await supabase
      .from("chat_device_tokens")
      .select("id, device_token")
      .eq("customer_phone", p)
      .eq("is_active", true)
      .eq("platform", "android")
      .limit(5);

    if (error) throw error;

    console.log("🤖 ANDROID TOKEN COUNT:", data?.length || 0);

    for (const row of (data || [])){
      const deviceToken = String(row.device_token || "").trim();
      if (!deviceToken) continue;

      const pushRes = await fetch("https://earnest-bombolone-4d2e8a.netlify.app/.netlify/functions/send-push-android", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          deviceToken,
          platform: "fcm",
          token_type: "fcm",
          title: title || "Emas Amir",
          body: cutText(body || "", 120),
          url: url || "/chat.html"
        })
      });

      const pushJson = await pushRes.json().catch(() => ({}));

      console.log("🤖 ANDROID PUSH RESULT:", {
        token_id: row.id,
        status: pushRes.status,
        response: pushJson
      });

      if (pushJson?.success){
        await supabase
          .from("chat_device_tokens")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }

  }catch(e){
    console.error("❌ ANDROID PUSH ERROR:", e.message || String(e));
  }
}

async function updateCampaignCounter(supabase, campaignId){
  const { data, error } = await supabase
    .from("notification_campaign_recipients")
    .select("status")
    .eq("campaign_id", campaignId);

  if (error) throw error;

  let sent = 0;
  let failed = 0;
  let pending = 0;
  let processing = 0;

  for (const r of (data || [])){
    const s = String(r.status || "").toUpperCase();

    if (s === "SENT") sent++;
    else if (s === "FAILED") failed++;
    else if (s === "PROCESSING") processing++;
    else pending++;
  }

  const done = pending === 0 && processing === 0;

  const payload = {
    total_sent: sent,
    total_failed: failed,
    status: done ? "DONE" : "SENDING"
  };

  if (done){
    payload.sent_at = new Date().toISOString();
  }

  const { error: updateErr } = await supabase
    .from("notification_campaigns")
    .update(payload)
    .eq("id", campaignId);

  if (updateErr) throw updateErr;

  console.log("📊 CAMPAIGN COUNTER:", {
    campaignId,
    sent,
    failed,
    pending,
    processing,
    done
  });

  return { sent, failed, pending, processing, done };
}

const realHandler = async (event) => {
  const startedAt = new Date().toISOString();

  try{
    console.log("🔥 WORKER TRIGGERED:", startedAt);
    console.log("🔥 METHOD:", event.httpMethod);
    console.log("🔥 PATH:", event.path || "");
    console.log("🔥 USER_AGENT:", event.headers?.["user-agent"] || event.headers?.["User-Agent"] || "");

    const body = event.httpMethod === "POST"
      ? JSON.parse(event.body || "{}")
      : {};

    const limit = Math.min(Number(body.limit || 20), 50);

    console.log("⚙️ WORKER LIMIT:", limit);

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY){
      return json(500, {
        ok:false,
        error:"Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"
      });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: campaigns, error: campErr } = await supabase
      .from("notification_campaigns")
      .select("*")
      .eq("status", "SENDING")
      .order("created_at", { ascending:true })
      .limit(1);

    if (campErr) throw campErr;

    console.log("📣 SENDING CAMPAIGN COUNT:", campaigns?.length || 0);

    const campaign = campaigns && campaigns[0];

    if (!campaign){
      return json(200, {
        ok:true,
        message:"No SENDING campaign",
        processed:0
      });
    }

    console.log("📣 ACTIVE CAMPAIGN:", {
      id: campaign.id,
      title: campaign.title,
      status: campaign.status,
      total_target: campaign.total_target,
      total_sent: campaign.total_sent,
      total_failed: campaign.total_failed
    });

    const { data: recipients, error: recErr } = await supabase
      .from("notification_campaign_recipients")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("status", "PENDING")
      .order("created_at", { ascending:true })
      .limit(limit);

    if (recErr) throw recErr;

    console.log("📥 PENDING RECIPIENTS PICKED:", recipients?.length || 0);

    if (!recipients || !recipients.length){
      const summary = await updateCampaignCounter(supabase, campaign.id);

      return json(200, {
        ok:true,
        campaign_id:campaign.id,
        message:"No pending recipients",
        processed:0,
        summary
      });
    }

    const ids = recipients.map(r => r.id).filter(Boolean);

    const { error: processingErr } = await supabase
      .from("notification_campaign_recipients")
      .update({ status:"PROCESSING" })
      .in("id", ids);

    if (processingErr) throw processingErr;

    let success = 0;
    let failed = 0;

    for (const r of recipients){
      try{
        const now = new Date().toISOString();

        const customerName = String(
          r.meta?.customer_name ||
          r.customer_name ||
          "Cik"
        ).trim() || "Cik";

        const finalMessage = personalizeMessage(
          campaign.body,
          customerName
        );

        console.log("✉️ SEND RECIPIENT:", {
          recipient_id: r.id,
          thread_id: r.thread_id,
          phone: r.customer_phone,
          name: customerName
        });

        const { error: msgErr } = await supabase
          .from("chat_messages")
          .insert({
            thread_id: r.thread_id,
            role: "notification",
            text: finalMessage,
            meta: {
              notification: true,
              campaign_id: campaign.id,
              campaign_type: campaign.meta?.campaign_type || "",
              title: campaign.title || "",
              target_url: campaign.target_url || "",
              customer_name: customerName,
              customer_id: r.meta?.customer_id || null,
              worker_sent_at: now
            }
          });

        if (msgErr) throw msgErr;

        const { error: threadErr } = await supabase
          .from("chat_threads")
          .update({
            last_message_at: now
          })
          .eq("id", r.thread_id);

        if (threadErr) throw threadErr;

        const { error: sentErr } = await supabase
          .from("notification_campaign_recipients")
          .update({
            status: "SENT",
            sent_at: now,
            error_message: null
          })
          .eq("id", r.id);

        if (sentErr) throw sentErr;

        await sendIosPushSafe({
          supabase,
          phone: r.customer_phone,
          title: campaign.title || "Emas Amir",
          body: finalMessage,
          url: campaign.target_url || "/chat.html"
        });

        await sendAndroidPushSafe({
          supabase,
          phone: r.customer_phone,
          title: campaign.title || "Emas Amir",
          body: finalMessage,
          url: campaign.target_url || "/chat.html"
        });

        success++;

      }catch(e){
        failed++;

        console.error("❌ RECIPIENT FAILED:", {
          recipient_id: r.id,
          thread_id: r.thread_id,
          phone: r.customer_phone,
          error: e.message || String(e)
        });

        await supabase
          .from("notification_campaign_recipients")
          .update({
            status: "FAILED",
            error_message: e.message || String(e)
          })
          .eq("id", r.id);
      }
    }

    const summary = await updateCampaignCounter(supabase, campaign.id);

    console.log("✅ WORKER DONE:", {
      campaign_id: campaign.id,
      processed: recipients.length,
      success,
      failed,
      summary
    });

    return json(200, {
      ok:true,
      campaign_id:campaign.id,
      processed:recipients.length,
      success,
      failed,
      summary
    });

  }catch(e){
    console.error("💥 WORKER FATAL ERROR:", e.message || String(e));

    return json(500, {
      ok:false,
      error:e.message || String(e)
    });
  }
};

exports.handler = schedule("* * * * *", realHandler);