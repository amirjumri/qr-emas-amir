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

function phoneVariants(phone){
  const p = normalizePhone(phone);
  if (!p) return [];

  const out = new Set([p, "+" + p]);

  if (p.startsWith("60")){
    out.add("0" + p.slice(2));
  }

  return Array.from(out);
}

function cleanIc(raw){
  return String(raw || "").replace(/\D+/g, "");
}

function todayMY(offsetDays){
  const now = new Date();
  const my = new Date(now.toLocaleString("en-US", { timeZone:"Asia/Kuala_Lumpur" }));
  my.setDate(my.getDate() + Number(offsetDays || 0));

  const mm = String(my.getMonth() + 1).padStart(2, "0");
  const dd = String(my.getDate()).padStart(2, "0");
  return mm + dd;
}

async function attachCustomerNamesByPhone(supabase, threads){
  const normalizedPhones = Array.from(
    new Set(
      (threads || [])
        .map(t => normalizePhone(t.customer_phone))
        .filter(Boolean)
    )
  );

  if (!normalizedPhones.length) return threads || [];

  const variants = [];

  for (const p of normalizedPhones){
    phoneVariants(p).forEach(v => variants.push(v));
  }

  const { data: customers, error } = await supabase
    .from("customers")
    .select("id, name, customer_name, phone")
    .in("phone", Array.from(new Set(variants)));

  if (error) throw error;

  const byPhone = {};

  for (const c of (customers || [])){
    const p = normalizePhone(c.phone);
    if (!p) continue;

    byPhone[p] = {
      customer_id: c.id || "",
      customer_name: String(c.customer_name || c.name || "Cik").trim() || "Cik"
    };
  }

  return (threads || []).map(t => {
    const p = normalizePhone(t.customer_phone);

    return {
      ...t,
      customer_id: byPhone[p]?.customer_id || t.customer_id || "",
      customer_name: byPhone[p]?.customer_name || t.customer_name || "Cik"
    };
  });
}

async function getBirthdayThreads(supabase, segment){
  const targetMMDD = segment === "BIRTHDAY_TOMORROW"
    ? todayMY(1)
    : todayMY(0);

  const { data: customers, error: custErr } = await supabase
    .from("customers")
    .select("id, name, customer_name, phone, ic")
    .not("ic", "is", null)
    .limit(10000);

  if (custErr) throw custErr;

  const birthdayPhones = [];
  const birthdayMap = {};

  for (const c of (customers || [])){
    const ic = cleanIc(c.ic);
    if (ic.length < 6) continue;

    const mmdd = ic.slice(2, 6);
    if (mmdd !== targetMMDD) continue;

    const p = normalizePhone(c.phone);
    if (!p) continue;

    birthdayPhones.push(p);

    birthdayMap[p] = {
      customer_id: c.id || "",
      customer_name: String(c.customer_name || c.name || "Cik").trim() || "Cik",
      ic: c.ic || ""
    };
  }

  if (!birthdayPhones.length) return [];

  const threadPhoneVariants = [];

  Array.from(new Set(birthdayPhones)).forEach(p => {
    phoneVariants(p).forEach(v => threadPhoneVariants.push(v));
  });

  const { data, error } = await supabase
    .from("chat_threads")
    .select("*")
    .in("customer_phone", Array.from(new Set(threadPhoneVariants)))
    .order("last_message_at", { ascending:false });

  if (error) throw error;

  return (data || []).map(t => {
    const p = normalizePhone(t.customer_phone);

    return {
      ...t,
      customer_name: birthdayMap[p]?.customer_name || "Cik",
      customer_id: birthdayMap[p]?.customer_id || "",
      ic: birthdayMap[p]?.ic || ""
    };
  });
}

async function getSegmentThreads(supabase, segment, phonesInput){
  if (segment === "MANUAL"){
    const phones = phonesInput.map(normalizePhone).filter(Boolean);

    const variants = [];

    for (const p of phones){
      phoneVariants(p).forEach(v => variants.push(v));
    }

    const { data, error } = await supabase
      .from("chat_threads")
      .select("*")
      .in("customer_phone", Array.from(new Set(variants)));

    if (error) throw error;

    return await attachCustomerNamesByPhone(supabase, data || []);
  }

  if (segment === "BIRTHDAY_TOMORROW" || segment === "BIRTHDAY_TODAY"){
    return await getBirthdayThreads(supabase, segment);
  }

  let days = 0;

  if (segment === "7D") days = 7;
  if (segment === "14D") days = 14;
  if (segment === "30D") days = 30;

  let query = supabase
    .from("chat_threads")
    .select("*");

  if (days > 0){
    const date = new Date();
    date.setDate(date.getDate() - days);
    query = query.gte("last_message_at", date.toISOString());
  }

  const { data, error } = await query;

  if (error) throw error;

  return await attachCustomerNamesByPhone(supabase, data || []);
}

exports.handler = async (event) => {
  try{
    const body = JSON.parse(event.body || "{}");

    const segment = body.segment_type || "ALL";
    const message = String(body.message || "").trim();
    const title = String(body.title || "").trim();
    const target_url = String(body.target_url || "").trim();
    const phonesInput = Array.isArray(body.phones) ? body.phones : [];

    if (!message){
      return json(400, { ok:false, error:"message required" });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const threads = await getSegmentThreads(supabase, segment, phonesInput);

    const map = {};

    for (const t of threads){
      const p = normalizePhone(t.customer_phone);
      if (!p) continue;

      if (!map[p] || new Date(t.last_message_at || 0) > new Date(map[p].last_message_at || 0)){
        map[p] = t;
      }
    }

    const finalList = Object.values(map);

    const campaignType =
      segment === "BIRTHDAY_TOMORROW" ? "BIRTHDAY_TOMORROW" :
      segment === "BIRTHDAY_TODAY" ? "BIRTHDAY_TODAY" :
      String(body.campaign_type || "");

    const { data: campaign, error: campaignErr } = await supabase
      .from("notification_campaigns")
      .insert({
        title,
        body: message,
        target_url,
        segment_type: segment,
        total_target: finalList.length,
        total_sent: 0,
        total_failed: 0,
        status: "SENDING",
        meta: {
          campaign_type: campaignType,
          personalized: true,
          queue: true,
          batch_size: 20
        }
      })
      .select()
      .single();

    if (campaignErr) throw campaignErr;

    const rows = finalList.map(t => {
      const p = normalizePhone(t.customer_phone);

      return {
        campaign_id: campaign.id,
        thread_id: t.id,
        customer_phone: p || t.customer_phone,
        status: "PENDING",
        sent_at: null,
        error_message: null,
        meta: {
          customer_id: t.customer_id || null,
          customer_name: String(t.customer_name || "Cik").trim() || "Cik"
        }
      };
    });

    if (rows.length){
      const { error: recErr } = await supabase
        .from("notification_campaign_recipients")
        .insert(rows);

      if (recErr) throw recErr;
    }

    return json(200, {
      ok: true,
      queued: true,
      campaign_id: campaign.id,
      total: finalList.length,
      message: "Campaign queue created. Worker will process recipients by batch."
    });

  }catch(e){
    return json(500, { ok:false, error:e.message });
  }
};