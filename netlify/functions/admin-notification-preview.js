const { createClient } = require("@supabase/supabase-js");

function json(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
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

function todayMY(offsetDays){
  const now = new Date();
  const my = new Date(now.toLocaleString("en-US", { timeZone:"Asia/Kuala_Lumpur" }));
  my.setDate(my.getDate() + Number(offsetDays || 0));

  const mm = String(my.getMonth() + 1).padStart(2, "0");
  const dd = String(my.getDate()).padStart(2, "0");
  return mm + dd;
}

function cleanIc(raw){
  return String(raw || "").replace(/\D+/g, "");
}

/* ✅ Ambil semua thread lebih 1000 row */
async function fetchAllThreads(supabase, days){
  const pageSize = 1000;
  let from = 0;
  const all = [];

  while (true){
    let query = supabase
      .from("chat_threads")
      .select("id, customer_phone, last_message_at")
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

exports.handler = async (event) => {
  try{
    const body = JSON.parse(event.body || "{}");
    const segment = body.segment_type || "ALL";
    const phonesInput = Array.isArray(body.phones) ? body.phones : [];

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    let threads = [];

    if (segment === "MANUAL"){
      const phones = phonesInput.map(normalizePhone).filter(Boolean);

      const { data, error } = await supabase
        .from("chat_threads")
        .select("id, customer_phone, last_message_at")
        .in("customer_phone", phones);

      if (error) throw error;
      threads = data || [];

    } else if (segment === "BIRTHDAY_TOMORROW" || segment === "BIRTHDAY_TODAY") {
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

      if (birthdayPhones.length){
        const { data, error } = await supabase
          .from("chat_threads")
          .select("id, customer_phone, last_message_at")
          .in("customer_phone", Array.from(new Set(birthdayPhones)))
          .order("last_message_at", { ascending:false });

        if (error) throw error;

        threads = (data || []).map(t => {
          const p = normalizePhone(t.customer_phone);
          return {
            ...t,
            customer_name: birthdayMap[p]?.customer_name || "Cik",
            customer_id: birthdayMap[p]?.customer_id || "",
            ic: birthdayMap[p]?.ic || ""
          };
        });
      }

    } else {
      let days = 0;
      if (segment === "7D") days = 7;
      if (segment === "14D") days = 14;
      if (segment === "30D") days = 30;

      threads = await fetchAllThreads(supabase, days);
    }

    const map = {};

    for (const t of threads){
      const p = normalizePhone(t.customer_phone);
      if (!p) continue;

      if (!map[p] || new Date(t.last_message_at || 0) > new Date(map[p].last_message_at || 0)){
        map[p] = t;
      }
    }

    const finalList = Object.values(map);

    return json(200, {
      ok: true,
      total: finalList.length,
      sample: finalList.slice(0,10)
    });

  }catch(e){
    return json(500, { ok:false, error:e.message || String(e) });
  }
};