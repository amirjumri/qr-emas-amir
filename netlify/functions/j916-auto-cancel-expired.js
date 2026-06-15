// netlify/functions/j916-auto-cancel-expired.js
const { createClient } = require("@supabase/supabase-js");

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(statusCode, body){
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type":"application/json" },
    body: JSON.stringify(body)
  };
}

function isUUID(v){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || "").trim());
}

function normalizePhone(raw){
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);
  return d;
}

function getPaidChat(meta, orderCode){
  const refs = Array.isArray(meta?.paid_chat_order_refs)
    ? meta.paid_chat_order_refs.map(x => String(x || "").trim()).filter(Boolean)
    : [];

  const oc = String(orderCode || "").trim();
  return !!oc && refs.includes(oc);
}

function buildCancelMessage({ orderCode, itemCode, amountRm }){
  return [
    "Assalamualaikum cik 🌷",
    "",
    "Tempoh bayaran untuk order ini telah tamat.",
    "",
    `Order: ${orderCode || "-"}`,
    itemCode ? `Item: #${itemCode}` : null,
    amountRm ? `Jumlah: RM ${Number(amountRm).toFixed(2)}` : null,
    "",
    "Order ini telah dibatalkan secara automatik kerana tiada bayaran / bukti bayaran diterima dalam masa yang ditetapkan.",
    "",
    "Jika cik masih berminat, cik boleh lock semula item semasa live nanti 😊"
  ].filter(Boolean).join("\n");
}

async function findOrCreateThreadByPhone(sb, phone){
  const customerPhone = normalizePhone(phone);
  if (!customerPhone) return null;

  const find = await sb
    .from("chat_threads")
    .select("id,customer_phone")
    .eq("customer_phone", customerPhone)
    .order("created_at", { ascending:false })
    .limit(1);

  if (!find.error && find.data && find.data[0]?.id){
    return find.data[0].id;
  }

  const ins = await sb
    .from("chat_threads")
    .insert({
      customer_phone: customerPhone,
      status: "OPEN",
      last_message_at: new Date().toISOString()
    })
    .select("id")
    .single();

  if (ins.error) return null;
  return ins.data?.id || null;
}

async function insertAutoCancelChat(sb, { threadId, phone, message, orderCode }){
  let tid = threadId && isUUID(threadId) ? threadId : null;

  if (!tid){
    tid = await findOrCreateThreadByPhone(sb, phone);
  }

  if (!tid){
    return { ok:false, reason:"no thread" };
  }

  const nowIso = new Date().toISOString();

  const ins = await sb
    .from("chat_messages")
    .insert({
      thread_id: tid,
      role: "ai",
      text: message,
      meta: {
        source: "j916_auto_cancel_expired",
        type: "auto_cancel_payment_timeout",
        order_code: orderCode || null,
        direct_insert: true
      }
    });

  if (ins.error){
    return { ok:false, error:ins.error.message };
  }

  await sb
    .from("chat_threads")
    .update({
      last_message_at: nowIso
    })
    .eq("id", tid);

  return { ok:true, thread_id:tid };
}

exports.handler = async function(event){
  try{
    if (event.httpMethod === "OPTIONS") return json(200, { ok:true });
    if (event.httpMethod !== "POST") return json(405, { ok:false, error:"Method not allowed" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SERVICE_ROLE){
      return json(500, { ok:false, error:"Missing Supabase env" });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

    const body = JSON.parse(event.body || "{}");
    const limit = Math.min(Math.max(Number(body.limit || 10), 1), 30);
    const nowIso = new Date().toISOString();

    const { data: orders, error } = await sb
      .from("j916_orders")
      .select(`
        id,
        order_code,
        status,
        phone,
        customer_name,
        code,
        amount_cents,
        grand_total_rm,
        checkout_group,
        payment_deadline_at,
        payment_timer_disabled,
        auto_cancelled_at
      `)
      .eq("status", "PENDING")
      .eq("payment_timer_disabled", false)
      .is("auto_cancelled_at", null)
      .not("payment_deadline_at", "is", null)
      .lte("payment_deadline_at", nowIso)
      .order("payment_deadline_at", { ascending:true })
      .limit(limit);

    if (error) throw error;

    const list = Array.isArray(orders) ? orders : [];
    const results = [];

    for (const o of list){
      const orderId = String(o.id || "").trim();
      const orderCode = String(o.order_code || "").trim();
      const threadId = String(o.checkout_group || "").trim();

      if (!isUUID(orderId)){
        results.push({ orderCode, skipped:true, reason:"order id invalid" });
        continue;
      }

      const { data: slips, error: slipErr } = await sb
        .from("customer_slips")
        .select("id,status,created_at")
        .eq("order_code", orderId)
        .limit(1);

      if (slipErr) throw slipErr;

      if (Array.isArray(slips) && slips.length){
        results.push({ orderCode, skipped:true, reason:"resit sudah dihantar" });
        continue;
      }

      if (threadId && isUUID(threadId)){
        const { data: th, error: thErr } = await sb
          .from("chat_threads")
          .select("id,meta")
          .eq("id", threadId)
          .maybeSingle();

        if (thErr) throw thErr;

        const meta = th && typeof th.meta === "object" ? th.meta : {};
        if (getPaidChat(meta, orderCode)){
          results.push({ orderCode, skipped:true, reason:"paid chat" });
          continue;
        }
      }

      const amountRm =
        Number(o.grand_total_rm || 0) > 0
          ? Number(o.grand_total_rm || 0)
          : (Number(o.amount_cents || 0) > 0 ? Number(o.amount_cents || 0) / 100 : 0);

      const msg = buildCancelMessage({
        orderCode,
        itemCode: o.code,
        amountRm
      });

      const cancel = await sb.rpc("j916_admin_order_cancel_v1", {
        p_reference: orderId
      });

      if (cancel.error){
        results.push({ orderCode, cancelled:false, error:cancel.error.message });
        continue;
      }

      await sb
        .from("j916_orders")
        .update({
          auto_cancelled_at: new Date().toISOString(),
          payment_timer_note: "Auto cancel: tamat masa bayaran"
        })
        .eq("id", orderId);

     let chat = { ok:false };

try {

  let tid = threadId;

  if (!tid || !isUUID(tid)) {
    tid = await findOrCreateThreadByPhone(sb, o.phone);
  }

  const adminPhone =
    process.env.CHAT_ADMIN_PHONE ||
    process.env.ADMIN_PHONE ||
    "0134456002";

  const baseUrl =
    process.env.SITE_PUBLIC_URL ||
    process.env.URL ||
    "https://emasamir.app";

  const res = await fetch(
    `${baseUrl}/.netlify/functions/admin-chat-send`,
    {
      method: "POST",
      headers: {
        "Content-Type":"application/json"
      },
      body: JSON.stringify({
        admin_phone: adminPhone,
        thread_id: tid,
        message: msg,
        meta: {
          source: "j916_auto_cancel_expired",
          auto_cancel: true,
          order_code: orderCode
        }
      })
    }
  );

  chat = await res.json().catch(()=>({}));

} catch(err){

  console.error(
    "AUTO CANCEL NOTIFICATION ERROR:",
    err
  );

}

      results.push({
        orderCode,
        cancelled:true,
        chat_sent: !!chat.ok,
        chat_result: chat
      });
    }

    return json(200, {
      ok:true,
      checked:list.length,
      cancelled:results.filter(x => x.cancelled).length,
      skipped:results.filter(x => x.skipped).length,
      results
    });

  }catch(e){
    return json(500, {
      ok:false,
      error:e?.message || String(e)
    });
  }
};