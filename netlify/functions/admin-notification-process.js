const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const body = JSON.parse(event.body || "{}");

    const campaignId = String(body.campaign_id || "").trim();
    const limit = Math.min(Number(body.limit || 50), 100);

    if (!campaignId) {
      return json(400, { ok: false, error: "campaign_id kosong" });
    }

    const { data: campaign, error: cErr } = await supabase
      .from("notification_campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();

    if (cErr) throw cErr;
    if (!campaign) {
      return json(404, { ok: false, error: "Campaign tidak jumpa" });
    }

    const { data: jobs, error: jErr } = await supabase
      .from("notification_jobs")
      .select("*")
      .eq("campaign_id", campaignId)
      .eq("status", "PENDING")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (jErr) throw jErr;

    if (!jobs || !jobs.length) {
      await finishCampaignIfDone(campaignId);

      return json(200, {
        ok: true,
        sent: 0,
        failed: 0,
        pending: 0,
        done: true
      });
    }

    let sent = 0;
    let failed = 0;

    for (const job of jobs) {
      try {
        const now = new Date().toISOString();
        const finalMessage = applyPersonalization(campaign.message, job);

        const meta = {
          notification: true,
          campaign_id: campaignId,
          notification_job_id: job.id,
          campaign_type: campaign.segment_type || "",
          target_url: campaign.target_url || "",
          title: campaign.title || "",
          type: "admin_notification",
          customer_name: job.customer_name || "Cik"
        };

        const ins = await supabase
          .from("chat_messages")
          .insert({
            thread_id: job.thread_id,
            role: "notification",
            text: finalMessage,
            meta
          });

        if (ins.error) throw ins.error;

        const up = await supabase
          .from("chat_threads")
          .update({
            last_message_at: now
          })
          .eq("id", job.thread_id);

        if (up.error) throw up.error;

        await supabase
          .from("notification_jobs")
          .update({
            status: "SENT",
            sent_at: now,
            error: null
          })
          .eq("id", job.id);

        try {
          await supabase
            .from("notification_campaign_recipients")
            .insert({
              campaign_id: campaignId,
              thread_id: job.thread_id,
              customer_phone: job.customer_phone,
              status: "SENT",
              sent_at: now
            });
        } catch {}

        await sendAndroidPush(job, campaign, finalMessage);

        sent++;

      } catch (e) {
        failed++;

        await supabase
          .from("notification_jobs")
          .update({
            status: "FAILED",
            error: e.message || String(e)
          })
          .eq("id", job.id);

        try {
          await supabase
            .from("notification_campaign_recipients")
            .insert({
              campaign_id: campaignId,
              thread_id: job.thread_id,
              customer_phone: job.customer_phone,
              status: "FAILED",
              error_message: e.message || String(e)
            });
        } catch {}
      }
    }

    const { count: pendingCount, error: pErr } = await supabase
      .from("notification_jobs")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "PENDING");

    if (pErr) throw pErr;

    const { count: sentCount } = await supabase
      .from("notification_jobs")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "SENT");

    const { count: failedCount } = await supabase
      .from("notification_jobs")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "FAILED");

    const done = Number(pendingCount || 0) <= 0;

    await supabase
      .from("notification_campaigns")
      .update({
        sent: Number(sentCount || 0),
        failed: Number(failedCount || 0),
        status: done ? "DONE" : "PROCESSING",
        updated_at: new Date().toISOString()
      })
      .eq("id", campaignId);

    return json(200, {
      ok: true,
      sent,
      failed,
      pending: Number(pendingCount || 0),
      done
    });

  } catch (e) {
    return json(500, {
      ok: false,
      error: e.message || String(e)
    });
  }
};

function applyPersonalization(message, job) {
  const name = String(job.customer_name || "").trim() || "Cik";

  return String(message || "")
    .replaceAll("{{nama}}", name)
    .replaceAll("{{name}}", name)
    .replaceAll("{nama}", name)
    .replaceAll("{name}", name)
    .replaceAll("{{phone}}", job.customer_phone || "");
}

async function sendAndroidPush(job, campaign, finalMessage) {
  try {
    const p = String(job.customer_phone || "").replace(/\D+/g, "");
    if (!p) return;

    const tokenQ = await supabase
      .from("chat_device_tokens")
      .select("id,device_token,platform,token_type,is_active,updated_at")
      .eq("customer_phone", p)
      .eq("is_active", true)
      .eq("platform", "android")
      .order("updated_at", { ascending:false })
      .limit(10);

    if (tokenQ.error || !Array.isArray(tokenQ.data)) return;

    const seenTokens = new Set();

    for (const row of tokenQ.data) {
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
          title: campaign.title || "Emas Amir",
          body: finalMessage,
          url: campaign.target_url || "/chat.html"
        })
      });

      const pushJson = await pushRes.json().catch(() => ({}));

      if (pushJson && pushJson.success) {
        await supabase
          .from("chat_device_tokens")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    }

  } catch {}
}

async function finishCampaignIfDone(campaignId) {
  const { count: sentCount } = await supabase
    .from("notification_jobs")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "SENT");

  const { count: failedCount } = await supabase
    .from("notification_jobs")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "FAILED");

  await supabase
    .from("notification_campaigns")
    .update({
      sent: Number(sentCount || 0),
      failed: Number(failedCount || 0),
      status: "DONE",
      updated_at: new Date().toISOString()
    })
    .eq("id", campaignId);
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}