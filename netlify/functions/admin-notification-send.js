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

function chunkArray(arr, size){
  const out = [];
  for (let i = 0; i < arr.length; i += size){
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function todayMY(offsetDays){
  const now = new Date();
  const my = new Date(now.toLocaleString("en-US", { timeZone:"Asia/Kuala_Lumpur" }));
  my.setDate(my.getDate() + Number(offsetDays || 0));

  const mm = String(my.getMonth() + 1).padStart(2, "0");
  const dd = String(my.getDate()).padStart(2, "0");
  return mm + dd;
}

/* ✅ Ambil semua thread lebih 1000 row */
async function fetchAllThreads(supabase, days){
  const pageSize = 1000;
  let from = 0;
  const all = [];

  while (true){
    let query = supabase
      .from("chat_threads")
      .select("*")
      .not("customer_phone", "is", null)
      .neq("customer_phone", "")
      .order("last_message_at", { ascending:false })
      .range(from, from + pageSize - 1);

    if (days > 0){
      const date = new Date();
      date.setDate(date.getDate() - days);
      query = query.gte("last_message_at", date.toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;

    all.push(...(data || []));

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

async function fetchCustomersByPhoneVariants(supabase, variants){
  const uniq = Array.from(new Set((variants || []).filter(Boolean)));
  if (!uniq.length) return [];

  const all = [];

  for (const batch of chunkArray(uniq, 250)){
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, customer_name, phone")
      .in("phone", batch);

    if (error) throw error;
    all.push(...(data || []));
  }

  return all;
}

async function fetchThreadsByPhoneVariants(supabase, variants){
  const uniq = Array.from(new Set((variants || []).filter(Boolean)));
  if (!uniq.length) return [];

  const all = [];

  for (const batch of chunkArray(uniq, 250)){
    const { data, error } = await supabase
      .from("chat_threads")
      .select("*")
      .in("customer_phone", batch)
      .order("last_message_at", { ascending:false });

    if (error) throw error;
    all.push(...(data || []));
  }

  return all;
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

  const customers = await fetchCustomersByPhoneVariants(supabase, variants);

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

  const data = await fetchThreadsByPhoneVariants(supabase, threadPhoneVariants);

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

    const data = await fetchThreadsByPhoneVariants(supabase, variants);

    return await attachCustomerNamesByPhone(supabase, data || []);
  }

  if (segment === "BIRTHDAY_TOMORROW" || segment === "BIRTHDAY_TODAY"){
    return await getBirthdayThreads(supabase, segment);
  }

  let days = 0;

  if (segment === "7D") days = 7;
  if (segment === "14D") days = 14;
  if (segment === "30D") days = 30;

  const data = await fetchAllThreads(supabase, days);

  return await attachCustomerNamesByPhone(supabase, data || []);
}

async function fetchAllDeviceTokens(supabase){
  const pageSize = 1000;
  let from = 0;
  const all = [];

  while (true){
    const { data, error } = await supabase
      .from("chat_device_tokens")
      .select("device_token, platform, token_type, customer_phone, thread_id, is_active, updated_at")
      .eq("is_active", true)
      .not("device_token", "is", null)
      .neq("device_token", "")
      .order("updated_at", { ascending:false })
      .range(from, from + pageSize - 1);

    if (error) throw error;

    all.push(...(data || []));

    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

function filterDeviceTokensBySegment(tokens, tokenSegment, phonesInput){
  const seg = String(tokenSegment || "WITH_THREAD").toUpperCase();

  const manualPhones = new Set(
    (phonesInput || [])
      .map(normalizePhone)
      .filter(Boolean)
  );

  return (tokens || []).filter(t => {
    const p = normalizePhone(t.customer_phone || "");
    const threadId = String(t.thread_id || "").trim();

    if (seg === "WITH_THREAD"){
      return !!threadId;
    }

    if (seg === "TOKEN_ONLY"){
      return !threadId;
    }

    if (seg === "MANUAL"){
      if (!manualPhones.size) return false;
      return !!p && manualPhones.has(p);
    }

    return !!threadId;
  });
}

function buildTokenRecipientRows({
  campaignId,
  tokens,
  selectedPhones,
  title,
  message,
  target_url,
  campaignType,
  onlyMissingThread
}){
  const rows = [];
  const seenToken = new Set();
  const phoneSet = new Set(
    Array.from(selectedPhones || []).map(normalizePhone).filter(Boolean)
  );

  for (const t of (tokens || [])){
    const deviceToken = String(t.device_token || "").trim();
    if (!deviceToken) continue;
    if (seenToken.has(deviceToken)) continue;

    const p = normalizePhone(t.customer_phone || "");
    const threadId = String(t.thread_id || "").trim();

    /*
      Jika onlyMissingThread = true:
      - token yang phone dia sudah termasuk dalam thread target akan skip
      - elak double push
      - token anonymous / belum daftar tetap masuk
    */
    if (onlyMissingThread && p && phoneSet.has(p)){
      continue;
    }

    seenToken.add(deviceToken);

    rows.push({
      campaign_id: campaignId,
      thread_id: null,
      customer_phone: p || null,
      status: "PENDING",
      sent_at: null,
      error_message: null,
      meta: {
        recipient_type: "TOKEN",
        device_token: deviceToken,
        platform: t.platform || "",
        token_type: t.token_type || "",
        source: "chat_device_tokens",

        // kalau token ada phone/thread, simpan juga untuk rujukan
        customer_phone: p || null,
        linked_thread_id: threadId || null,

        title,
        body: message,
        target_url,
        campaign_type: campaignType
      }
    });
  }

  return rows;
}

function personalizeText(text, t){
  const name = String(t.customer_name || "Cik").trim() || "Cik";
  return String(text || "")
    .replaceAll("{{nama}}", name)
    .replaceAll("{{name}}", name);
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod === "OPTIONS"){
      return json(200, { ok:true });
    }

    const body = JSON.parse(event.body || "{}");

    const segment = body.segment_type || "ALL";
const tokenSegment = body.token_segment_type || segment;
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

    const useThreadTargets = body.use_thread_targets !== false;

const threads = useThreadTargets
  ? await getSegmentThreads(supabase, segment, phonesInput)
  : [];

    const map = {};

    for (const t of threads){
      const p = normalizePhone(t.customer_phone);
      if (!p) continue;
      if (!t.id) continue;

      if (!map[p] || new Date(t.last_message_at || 0) > new Date(map[p].last_message_at || 0)){
        map[p] = t;
      }
    }

   const finalList = Object.values(map);

const campaignType =
  segment === "BIRTHDAY_TOMORROW" ? "BIRTHDAY_TOMORROW" :
  segment === "BIRTHDAY_TODAY" ? "BIRTHDAY_TODAY" :
  String(body.campaign_type || body.template_type || "");

const includeDeviceTokens =
  body.include_device_tokens === true ||
  body.include_device_tokens === "true";

const onlyMissingThread =
  body.device_token_only_for_missing_thread !== false;

const selectedPhones = new Set(
  finalList
    .map(t => normalizePhone(t.customer_phone))
    .filter(Boolean)
);

let tokenRows = [];

if (includeDeviceTokens){
  const allTokens = await fetchAllDeviceTokens(supabase);

  const tokens = filterDeviceTokensBySegment(
    allTokens,
    tokenSegment,
    phonesInput
  );

  tokenRows = buildTokenRecipientRows({
    campaignId: "TEMP",
    tokens,
    selectedPhones,
    title,
    message,
    target_url,
    campaignType,
    onlyMissingThread
  });
}
const totalTarget = finalList.length + tokenRows.length;

const { data: campaign, error: campaignErr } = await supabase
  .from("notification_campaigns")
  .insert({
    title,
    body: message,
    target_url,
    segment_type: segment,
    total_target: totalTarget,
    total_sent: 0,
    total_failed: 0,
    status: "SENDING",
    meta: {
      campaign_type: campaignType,
      personalized: true,
      queue: true,
      batch_size: 20,

      include_device_tokens: includeDeviceTokens,
      device_token_only_for_missing_thread: onlyMissingThread,
      thread_target: finalList.length,
      token_target: tokenRows.length
    }
  })
  .select()
  .single();

if (campaignErr) throw campaignErr;

const threadRows = finalList.map(t => {
  const p = normalizePhone(t.customer_phone);
  const name = String(t.customer_name || "Cik").trim() || "Cik";

  return {
    campaign_id: campaign.id,
    thread_id: t.id,
    customer_phone: p || t.customer_phone,
    status: "PENDING",
    sent_at: null,
    error_message: null,
    meta: {
      recipient_type: "THREAD",
      customer_id: t.customer_id || null,
      customer_name: name,
      title,
      body: personalizeText(message, t),
      target_url,
      campaign_type: campaignType
    }
  };
});

if (includeDeviceTokens && tokenRows.length){
  tokenRows = tokenRows.map(r => ({
    ...r,
    campaign_id: campaign.id
  }));
}

const rows = [
  ...threadRows,
  ...tokenRows
];

let inserted = 0;

if (rows.length){
  for (const batch of chunkArray(rows, 100)){
    const { error: recErr } = await supabase
      .from("notification_campaign_recipients")
      .insert(batch);

    if (recErr) throw recErr;
    inserted += batch.length;
  }
}

return json(200, {
  ok: true,
  queued: true,
  campaign_id: campaign.id,
  total: totalTarget,
  thread_target: finalList.length,
  token_target: tokenRows.length,
  inserted,
  message: "Campaign queue created. Worker will process recipients by batch."
});

  }catch(e){
    console.error("[admin-notification-send error]", e);

    return json(500, {
      ok:false,
      error:e.message || String(e),
      detail:e.details || null,
      hint:e.hint || null,
      code:e.code || null
    });
  }
};