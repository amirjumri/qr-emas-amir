const { createClient } = require("@supabase/supabase-js");

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

async function sendAndroidPushSafe({ supabase, phone, title, body, url }){
  const p = normalizePhone(phone);
  if (!p) return;

  try{
    const tokenQ = await supabase
      .from("chat_device_tokens")
      .select("id, device_token, platform, token_type, is_active, updated_at")
      .eq("customer_phone", p)
      .eq("is_active", true)
      .eq("platform", "android")
      .order("updated_at", { ascending:false })
      .limit(10);

    if (tokenQ.error) throw tokenQ.error;

    const rows = Array.isArray(tokenQ.data) ? tokenQ.data : [];
    const seenTokens = new Set();

    for (const row of rows){
      const deviceToken = String(row.device_token || "").trim();

      if (!deviceToken || seenTokens.has(deviceToken)) continue;
      seenTokens.add(deviceToken);

      const pushRes = await fetch("https://earnest-bombolone-4d2e8a.netlify.app/.netlify/functions/send-push-android", {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          deviceToken,
          platform: "fcm",
          token_type: "fcm",
          title: title || "Emas Amir",
          body: body || "",
          url: url || "/chat.html"
        })
      });

      const pushJson = await pushRes.json().catch(() => ({}));

      console.log("Notification worker Android push result:", {
        phone: p,
        token_id: row.id,
        response: pushJson
      });

      if (pushJson?.success){
        await supabase
          .from("chat_device_tokens")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }

  }catch(pushErr){
    console.error("Notification worker push error:", {
      phone: p,
      error: pushErr?.message || String(pushErr)
    });
  }
}

async function updateCampaignCounter(supabase, campaignId){
  const { data: rows, error } = await supabase
    .from("notification_campaign_recipients")
    .select("status")
    .eq("campaign_id", campaignId);

  if (error) throw error;

  let sent = 0;
  let failed = 0;
  let pending = 0;
  let processing = 0;

  for (const r of (rows || [])){
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

  await supabase
    .from("notification_campaigns")
    .update(payload)
    .eq("id", campaignId);

  return {
    sent,
    failed,
    pending,
    processing,
    done
  };
}

exports.handler = async (event) => {
  try{
    const body = JSON.parse(event.body || "{}");

    const limit = Math.min(Number(body.limit || 20), 50);

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

    const campaign = campaigns && campaigns[0];

    if (!campaign){
      return json(200, {
        ok: true,
        message: "No SENDING campaign.",
        processed: 0
      });
    }

    const { data: pendingRows, error: pendingErr } = await supabase
      .from("notification_campaign_recipients")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("status", "PENDING")
      .order("created_at", { ascending:true })
      .limit(limit);

    if (pendingErr) throw pendingErr;

    const recipients = pendingRows || [];

    if (!recipients.length){
      const summary = await updateCampaignCounter(supabase, campaign.id);

      return json(200, {
        ok: true,
        campaign_id: campaign.id,
        message: "No pending recipients.",
        processed: 0,
        summary
      });
    }

    const recipientIds = recipients.map(r => r.id).filter(Boolean);

    if (recipientIds.length){
      await supabase
        .from("notification_campaign_recipients")
        .update({ status:"PROCESSING" })
        .in("id", recipientIds);
    }

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

        const finalMessage = personalizeMessage(campaign.body, customerName);

        const ins = await supabase
          .from("chat_messages")
          .insert({
            thread_id: r.thread_id,
            role: "notification",
            text: finalMessage,
            meta: {
              notification: true,
              campaign_id: campaign.id,
              campaign_type: campaign.meta?.campaign_type || "",
              target_url: campaign.target_url || "",
              title: campaign.title || "",
              customer_name: customerName,
              customer_id: r.meta?.customer_id || null
            }
          });

        if (ins.error) throw ins.error;

        const up = await supabase
          .from("chat_threads")
          .update({
            last_message_at: now
          })
          .eq("id", r.thread_id);

        if (up.error) throw up.error;

        const rec = await supabase
          .from("notification_campaign_recipients")
          .update({
            status: "SENT",
            sent_at: now,
            error_message: null
          })
          .eq("id", r.id);

        if (rec.error) throw rec.error;

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

    return json(200, {
      ok: true,
      campaign_id: campaign.id,
      processed: recipients.length,
      success,
      failed,
      summary
    });

  }catch(e){
    return json(500, {
      ok:false,
      error:e.message || String(e)
    });
  }
};