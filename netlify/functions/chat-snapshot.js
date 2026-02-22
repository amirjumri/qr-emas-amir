import { createClient } from "@supabase/supabase-js";

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
  if (!d) return { ok: false, error: "Nombor kosong" };

  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);

  // SG 8 digits -> +65
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;

  const isMY = d.startsWith("60") && (d.length === 11 || d.length === 12);
  const isSG = d.startsWith("65") && d.length === 10;

  if (!isMY && !isSG) {
    return { ok: false, error: "Nombor tak sah" };
  }
  return { ok: true, e164: d, country: isMY ? "MY" : "SG" };
}

function detectMYZoneFromStateOrAddress(state, alamat) {
  const t = (String(state || "") + " " + String(alamat || "")).toLowerCase();
  if (t.includes("sabah") || t.includes("sarawak") || t.includes("labuan")) return "EAST_MY";
  return "WEST_MY";
}

function calcShipFee(country, zone) {
  if (country === "SG") return 45;
  return zone === "EAST_MY" ? 20 : 10;
}

function shipLabel(country, zone) {
  if (country === "SG") return "Pos Singapore";
  return zone === "EAST_MY" ? "Pos Sabah/Sarawak" : "Pos Semenanjung";
}

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return json(400, { ok: false, error: "Body JSON tak sah" }); }

    const rawPhone = body.phone || body.customer_phone || "";
    const threadIdIn = body.thread_id || null;

    const p = normalizePhone(rawPhone);
    if (!p.ok) return json(400, { ok: false, error: p.error });

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap" });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    // 1) dapatkan thread (ikut thread_id kalau ada, kalau tak ambil latest ikut phone)
    let thread = null;

    if (threadIdIn) {
      const th = await supabase
        .from("chat_threads")
        .select("id,status,customer_phone,meta")
        .eq("id", threadIdIn)
        .maybeSingle();

      if (th.error) throw th.error;
      thread = th.data || null;
    }

    if (!thread) {
      const find = await supabase
        .from("chat_threads")
        .select("id,status,customer_phone,meta")
        .eq("customer_phone", p.e164)
        .order("created_at", { ascending: false })
        .limit(1);

      if (find.error) throw find.error;
      thread = (find.data && find.data[0]) ? find.data[0] : null;
    }

    if (!thread) {
      return json(200, { ok: true, thread: null, lock: null });
    }

    const status = String(thread.status || "OPEN").toUpperCase();

    // 2) kalau bukan LOCK -> return thread sahaja
    if (!status.startsWith("LOCK_")) {
      return json(200, {
        ok: true,
        thread: { id: thread.id, status, meta: thread.meta || {} },
        lock: null
      });
    }

    // 3) lock items OPEN
    const qItems = await supabase
      .from("chat_lock_items")
      .select("id,seq,price_rm,size_text,weight_g,tag_raw,attachment_url,wants_cut,cut_to_cm,current_length_cm,status")
      .eq("thread_id", thread.id)
      .eq("status", "OPEN")
      .order("seq", { ascending: true });

    if (qItems.error) throw qItems.error;

    const items = qItems.data || [];
    const subtotal = items.reduce((acc, it) => acc + Number(it.price_rm || 0), 0);

    // 4) kira zone + ship
    // zone dari meta jika ada, kalau tak cuba detect dari customer record (MY)
    let zone = (thread.meta && thread.meta.zone) ? String(thread.meta.zone) : null;

    if (!zone) {
      if (p.country === "SG") {
        zone = "SG";
      } else {
        let custRow = null;
        const local0 = "0" + p.e164.slice(2);

        const c1 = await supabase
          .from("customers")
          .select("alamat,postcode,city,state,phone")
          .eq("phone", local0)
          .limit(1);
        if (!c1.error && c1.data && c1.data[0]) custRow = c1.data[0];

        if (!custRow) {
          const c2 = await supabase
            .from("customers")
            .select("alamat,postcode,city,state,phone")
            .eq("phone", p.e164)
            .limit(1);
          if (!c2.error && c2.data && c2.data[0]) custRow = c2.data[0];
        }

        zone = detectMYZoneFromStateOrAddress(custRow?.state, custRow?.alamat);
      }
    }

    const ship_fee = calcShipFee(p.country, zone);
    const ship_label = shipLabel(p.country, zone);
    const total = subtotal + ship_fee;

    return json(200, {
      ok: true,
      thread: { id: thread.id, status, meta: thread.meta || {} },
      lock: {
        items,
        subtotal,
        zone,
        ship_fee,
        ship_label,
        total
      }
    });

  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
}