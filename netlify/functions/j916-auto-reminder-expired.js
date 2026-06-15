// netlify/functions/j916-auto-reminder-expired.js

const { createClient } = require("@supabase/supabase-js");

function corsHeaders(){
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Access-Control-Allow-Methods":"POST, OPTIONS"
  };
}

function json(statusCode, body){
  return {
    statusCode,
    headers:{
      ...corsHeaders(),
      "Content-Type":"application/json"
    },
    body: JSON.stringify(body)
  };
}

function isUUID(v){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "").trim()
  );
}

function normalizePhone(raw){
  let d = String(raw || "").replace(/\D/g,"");

  if (!d) return "";

  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);

  return d;
}

async function findOrCreateThreadByPhone(sb, phone){
  const customerPhone = normalizePhone(phone);

  if (!customerPhone) return null;

  const find = await sb
    .from("chat_threads")
    .select("id")
    .eq("customer_phone", customerPhone)
    .order("created_at",{ascending:false})
    .limit(1);

  if (!find.error && find.data?.[0]?.id){
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

function buildReminderMessage({
  orderCode,
  itemCode,
  amountRm
}){
  return [
    "Assalamualaikum cik 🌷",
    "",
    "Peringatan bayaran order.",
    "",
    `Order: ${orderCode || "-"}`,
    itemCode ? `Item: #${itemCode}` : null,
    amountRm ? `Jumlah: RM ${Number(amountRm).toFixed(2)}` : null,
    "",
    "Tempoh bayaran akan tamat dalam masa 15 minit lagi.",
    "",
    "Jika perlukan masa tambahan, sila balas chat ini atau hubungi admin dalam Ai-Dan.",
    "",
    "Jika tiada bayaran atau bukti bayaran diterima, order akan dibatalkan secara automatik apabila tempoh tamat."
  ]
  .filter(Boolean)
  .join("\n");
}

exports.handler = async function(event){

  try{

    if (event.httpMethod === "OPTIONS"){
      return json(200,{ok:true});
    }

    if (event.httpMethod !== "POST"){
      return json(405,{
        ok:false,
        error:"Method not allowed"
      });
    }

    const SUPABASE_URL =
      process.env.SUPABASE_URL;

    const SERVICE_ROLE =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SERVICE_ROLE){
      return json(500,{
        ok:false,
        error:"Missing Supabase env"
      });
    }

    const sb =
      createClient(
        SUPABASE_URL,
        SERVICE_ROLE
      );

    const now = new Date();

    const fifteenMinLater =
      new Date(
        now.getTime() + (15 * 60 * 1000)
      ).toISOString();

    const nowIso =
      now.toISOString();

    const { data: orders, error } =
      await sb
      .from("j916_orders")
      .select(`
        id,
        order_code,
        phone,
        code,
        amount_cents,
        grand_total_rm,
        checkout_group,
        payment_deadline_at,
        reminder_15m_sent_at,
        payment_timer_disabled,
        auto_cancelled_at
      `)
      .eq("status","PENDING")
      .eq("payment_timer_disabled",false)
      .is("auto_cancelled_at",null)
      .is("reminder_15m_sent_at",null)
      .not("payment_deadline_at","is",null)
      .gte("payment_deadline_at",nowIso)
      .lte("payment_deadline_at",fifteenMinLater)
      .limit(30);

    if (error) throw error;

    const results = [];

    for (const o of (orders || [])){

      const orderCode =
        String(o.order_code || "").trim();

      const amountRm =
        Number(o.grand_total_rm || 0) > 0
          ? Number(o.grand_total_rm)
          : (
              Number(o.amount_cents || 0) / 100
            );

      const msg =
        buildReminderMessage({
          orderCode,
          itemCode:o.code,
          amountRm
        });

      let threadId =
        String(
          o.checkout_group || ""
        ).trim();

      if (!threadId || !isUUID(threadId)){
        threadId =
          await findOrCreateThreadByPhone(
            sb,
            o.phone
          );
      }

      let chatOk = false;

      try{

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
            method:"POST",
            headers:{
              "Content-Type":"application/json"
            },
            body: JSON.stringify({
              admin_phone: adminPhone,
              thread_id: threadId,
              message: msg,
              meta:{
                source:"j916_auto_reminder",
                reminder_15m:true,
                order_code:orderCode
              }
            })
          }
        );

        const j =
          await res.json()
          .catch(()=>({}));

        chatOk =
          res.ok &&
          j.ok === true;

      }catch(err){

        console.error(
          "REMINDER ERROR:",
          err
        );

      }

      if (chatOk){

        await sb
          .from("j916_orders")
          .update({
            reminder_15m_sent_at:
              new Date().toISOString()
          })
          .eq("id", o.id);

      }

      results.push({
        orderCode,
        reminder_sent: chatOk
      });

    }

    return json(200,{
      ok:true,
      total:(orders || []).length,
      sent:
        results.filter(
          x => x.reminder_sent
        ).length,
      results
    });

  }catch(e){

    return json(500,{
      ok:false,
      error:e?.message || String(e)
    });

  }

};