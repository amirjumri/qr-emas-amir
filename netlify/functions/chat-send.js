// netlify/functions/chat-send.js
const { createClient } = require("@supabase/supabase-js");
const { routeIntent } = require("./ai_router.js");

/* =========================
   0) HELPERS
========================= */

function fmtRM(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return "RM 0.00";
  return "RM " + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function isJ916AvailableStatus(st) {
  const s = String(st || "").toUpperCase();
  if (!s) return true;
  return ["AVAILABLE", "READY", "INSTOCK", "IN_STOCK", "ACTIVE"].includes(s);
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
    return {
      ok: false,
      error: "Nombor tak sah. MY: 01xxxxxxxx / +60..., SG: +65xxxxxxxx"
    };
  }
  return { ok: true, e164: d, country: isMY ? "MY" : "SG" };
}

function parsePriceRM(text) {
  const t = String(text || "").toLowerCase();
  const m1 = t.match(/rm\s*([0-9]{1,6}(?:\.[0-9]{1,2})?)/i);
  if (m1 && m1[1]) return Number(m1[1]);
  const m2 = t.match(/(?:^|\s)([0-9]{2,6}(?:\.[0-9]{1,2})?)(?:\s|$)/);
  if (m2 && m2[1]) return Number(m2[1]);
  return null;
}

function parseLengthCm(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/(?:^|\s)([0-9]{1,3}(?:\.[0-9])?)\s*(?:cm)?(?:\s|$)/i);
  if (!m || !m[1]) return null;

  const v = Number(m[1]);
  if (!isFinite(v)) return null;

  if (v < 10 || v > 70) return null;
  return v;
}

function formatAddress(cust) {
  const a = String(cust?.alamat || "").trim();
  const p = String(cust?.postcode || "").trim();
  const city = String(cust?.city || "").trim();
  const st = String(cust?.state || "").trim();
  const tail = [p, city, st].filter(Boolean).join(", ");
  if (!a && !tail) return "";
  if (a && tail) return `${a}, ${tail}`;
  return a || tail;
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

/* =========================
   (NEW) RESET TRANSIENT META
   - ini punca utama "pos jem" bila thread reuse:
     flag lama kekal (awaiting_cut_item, awaiting_current_length, awaiting_addr_confirm, cut_mode dll)
========================= */

function resetTransientMeta(meta = {}) {
  const m = { ...(meta || {}) };

  // flags sementara untuk step-step
  delete m.awaiting_addr_confirm;
  delete m.awaiting_pickup_when;
  delete m.pickup_when_text;

  delete m.awaiting_cut_item;
  delete m.cut_mode;
  delete m.cut_target_seq;
  delete m.cut_seq_queue;

  delete m.awaiting_current_length;
  delete m.current_length_cm;

  // optional: kalau Amir simpan return_to_status, biar kekal
  // delete m.return_to_status;

  return m;
}

function setStepMeta(meta = {}, patch = {}) {
  // setiap kali tukar step besar, kita reset transient dulu
  const clean = resetTransientMeta(meta);
  return { ...clean, ...patch };
}

/* =========================
   INTENTS FROM DB (chat_intents)
========================= */

async function getActiveIntents(supabase) {
  if (!globalThis.__ea_intents_cache) globalThis.__ea_intents_cache = { at: 0, rows: [] };
  const now = Date.now();
  if (globalThis.__ea_intents_cache.rows.length && (now - globalThis.__ea_intents_cache.at) < 60_000) {
    return globalThis.__ea_intents_cache.rows;
  }

  const q = await supabase
    .from("chat_intents")
    .select("intent_key,mode,priority,match_any,match_all,match_regex,sop_key,set_thread_status,clear_lock_items,is_active")
    .eq("is_active", true)
    .order("priority", { ascending: true });

  if (q.error) throw q.error;

  globalThis.__ea_intents_cache = { at: now, rows: q.data || [] };
  return q.data || [];
}

function textContainsAll(t, arr) {
  if (!arr || !arr.length) return true;
  return arr.every(k => t.includes(String(k || "").toLowerCase()));
}
function textContainsAny(t, arr) {
  if (!arr || !arr.length) return true;
  return arr.some(k => t.includes(String(k || "").toLowerCase()));
}

function matchIntentRow(tLower, row, inLockFlow) {
  const mode = String(row.mode || "ANY").toUpperCase();
  if (mode === "LOCK" && !inLockFlow) return false;
  if (mode === "NON_LOCK" && inLockFlow) return false;

  const anyOk = textContainsAny(tLower, row.match_any || []);
  const allOk = textContainsAll(tLower, row.match_all || []);
  if (!anyOk || !allOk) return false;

  if (row.match_regex) {
    try {
      const re = new RegExp(row.match_regex, "i");
      if (!re.test(tLower)) return false;
    } catch (_) {
      return false;
    }
  }
  return true;
}

/* =========================
   1) WHATSAPP SENDER (ONSEND)
========================= */

async function sendWA(event, phone_number, message, opt = {}) {
  try {
    const host =
      event?.headers?.host ||
      event?.headers?.Host ||
      event?.headers?.["x-forwarded-host"] ||
      "";

    const proto =
      event?.headers?.["x-forwarded-proto"] ||
      (host ? "https" : "");

    const baseUrl = host ? `${proto}://${host}` : "";
    const fallback = process.env.SITE_PUBLIC_URL || "https://emasamir.app";
    const url = (baseUrl || fallback) + "/.netlify/functions/send-wa";

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number,
        message,
        file_url: opt.file_url || "",
        file_name: opt.file_name || ""
      })
    });

    const j = await r.json().catch(() => ({}));
    return r.ok && (j.ok === true || j.ok === "true" || j.data);
  } catch (e) {
    console.warn("sendWA error:", e?.message || e);
    return false;
  }
}

/* =========================
   2) OCR TAG (optional)
   - Extract: NAME + PRICE (RM) + SIZE + WEIGHT
========================= */

async function extractTagFromImage(imageUrl) {
  if (!imageUrl) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Anda OCR untuk screenshot LIVE barang emas (tag Emas Amir).\n" +
            "Cari 5 benda jika ada:\n" +
            "1) SIZE/PANJANG (S:..). Kadang-kadang tak tulis 'S:' tapi ada nombor macam ':51' — anggap itu S.\n" +
            "2) WEIGHT/BERAT (W:..gm)\n" +
            "3) LEBAR (L:..cm) atau (WIDTH ..cm) jika ada\n" +
            "4) HARGA dalam RM (contoh: RM481 / RM 481)\n" +
            "5) NAMA / label ringkas (contoh: MISS, NUR, AIN)\n\n" +
            "Jika nampak pola tag Emas Amir seperti '... :51 L:0.2 W:1.65gm', maka size=51 walaupun tiada 'S:'.\n\n" +
            "Balas JSON sahaja ikut format ini:\n" +
            "{\"size\":\"51\",\"weight_g\":\"1.65\",\"width_cm\":\"0.2\",\"price_rm\":1260,\"name\":\"EMAS AMIR\",\"raw\":\"S:51 / L:0.2 / W:1.65gm\"}\n\n" +
            "Rules:\n" +
            "- price_rm mesti nombor (integer). Kalau tak nampak, set null.\n" +
            "- name: ambil teks paling jelas pada kertas (kalau ada). Kalau tak nampak, set null.\n" +
            "- size/weight_g/width_cm kalau tak nampak, set null.\n" +
            "- raw gabungkan apa yang jumpa (S/W/L)."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Baca S/W pada tag dan juga nama & harga RM jika ada pada screenshot." },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ],
      temperature: 0
    })
  });

  const data = await r.json().catch(() => ({}));
  const txt = data?.choices?.[0]?.message?.content?.trim() || "";

  try {
    const cleaned = txt.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const j = JSON.parse(cleaned);

    const out = {
      name: j?.name ? String(j.name).trim() : null,
      price_rm: (j?.price_rm !== null && j?.price_rm !== undefined && j?.price_rm !== "")
        ? Number(j.price_rm)
        : null,
      size: j?.size ? String(j.size).trim() : null,
      weight_g: (j?.weight_g !== null && j?.weight_g !== undefined && j?.weight_g !== "")
        ? Number(j.weight_g)
        : null,
      width_cm: (j?.width_cm !== null && j?.width_cm !== undefined && j?.width_cm !== "")
        ? Number(j.width_cm)
        : null,
      raw: j?.raw ? String(j.raw).trim() : null
    };

    if (!isFinite(out.price_rm)) out.price_rm = null;
    if (!isFinite(out.weight_g)) out.weight_g = null;
    if (!isFinite(out.width_cm)) out.width_cm = null;

    // fallback: ":51" tanpa S:
    if (!out.size) {
      const raw = String(out.raw || "");
      const m = raw.match(/[:\s]([1-6][0-9](?:\.[0-9])?)\b/);
      if (m && m[1]) {
        const v = Number(m[1]);
        if (isFinite(v) && v >= 10 && v <= 70) {
          out.size = String(v);
          if (!raw.toUpperCase().includes("S:")) {
            out.raw = (`S:${out.size}` + (raw ? ` / ${raw}` : "")).replace(/\s+/g, " ").trim();
          }
        }
      }
    }

    return out;
  } catch {
    return null;
  }
}

/* =========================
   3) LOCK ITEMS DB HELPERS
========================= */

async function getLatestOpenItem(supabase, threadId) {
  const q = await supabase
    .from("chat_lock_items")
    .select("id,seq,current_length_cm,length_cm,tag_raw")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .order("seq", { ascending: false })
    .limit(1);

  if (q.error) throw q.error;
  return (q.data && q.data[0]) ? q.data[0] : null;
}

async function getOpenLockItems(supabase, threadId) {
  const q = await supabase
    .from("chat_lock_items")
    .select("id,seq,price_rm,size_text,weight_g,tag_raw,attachment_url,wants_cut,cut_to_cm,current_length_cm,status,item_code")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .order("seq", { ascending: true });

  if (q.error) throw q.error;
  return q.data || [];
}

async function createLockItemFromTag(supabase, threadId, tagExtracted, attachment) {
  const mx = await supabase
    .from("chat_lock_items")
    .select("seq")
    .eq("thread_id", threadId)
    .order("seq", { ascending: false })
    .limit(1);

  if (mx.error) throw mx.error;
  const nextSeq = (mx.data && mx.data[0] ? Number(mx.data[0].seq || 0) : 0) + 1;

  const size = tagExtracted?.size ? String(tagExtracted.size) : null;
  const weight = tagExtracted?.weight_g ? Number(tagExtracted.weight_g) : null;
  const raw = tagExtracted?.raw ? String(tagExtracted.raw) : null;

  const sizeNum = (size !== null && size !== undefined && size !== "")
    ? Number(size)
    : null;

  const currentLen =
    (sizeNum && isFinite(sizeNum) && sizeNum > 0)
      ? sizeNum
      : null;

  const ins = await supabase
    .from("chat_lock_items")
    .insert({
      thread_id: threadId,
      seq: nextSeq,
      size_text: size,
      weight_g: weight,
      tag_raw: raw,
      current_length_cm: currentLen,
      attachment_url: attachment?.url || null,
      attachment_name: attachment?.name || null,
      attachment_mime: attachment?.mime || null,
      status: "OPEN"
    })
    .select("id,seq")
    .single();

  if (ins.error) throw ins.error;
  return ins.data;
}

async function setLatestItemPrice(supabase, threadId, price) {
  const items = await supabase
    .from("chat_lock_items")
    .select("id,seq,price_rm")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .order("seq", { ascending: false })
    .limit(1);

  if (items.error) throw items.error;
  const it = items.data && items.data[0] ? items.data[0] : null;
  if (!it) return false;

  const up = await supabase
    .from("chat_lock_items")
    .update({ price_rm: Number(price) })
    .eq("id", it.id);

  if (up.error) throw up.error;
  return true;
}

async function markLatestItemCut(supabase, threadId, currentLenCm = 18) {
  const latest = await supabase
    .from("chat_lock_items")
    .select("id,seq")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .order("seq", { ascending: false })
    .limit(1);

  if (latest.error) throw latest.error;
  const it = latest.data && latest.data[0] ? latest.data[0] : null;
  if (!it) return null;

  const up = await supabase
    .from("chat_lock_items")
    .update({ wants_cut: true, current_length_cm: currentLenCm })
    .eq("id", it.id);

  if (up.error) throw up.error;
  return it;
}

async function markItemCutBySeq(supabase, threadId, seq, currentLenCm = 18) {
  const q = await supabase
    .from("chat_lock_items")
    .select("id,seq")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .eq("seq", Number(seq))
    .limit(1);

  if (q.error) throw q.error;
  const it = q.data && q.data[0] ? q.data[0] : null;
  if (!it) return null;

  const up = await supabase
    .from("chat_lock_items")
    .update({ wants_cut: true, current_length_cm: currentLenCm })
    .eq("id", it.id);

  if (up.error) throw up.error;
  return it;
}

async function markAllOpenItemsCut(supabase, threadId, currentLenCm = 18) {
  const items = await getOpenLockItems(supabase, threadId);
  if (!items.length) return [];

  const ids = items.map(x => x.id);

  const up = await supabase
    .from("chat_lock_items")
    .update({ wants_cut: true, current_length_cm: currentLenCm })
    .in("id", ids);

  if (up.error) throw up.error;
  return items;
}

async function setLatestCutTo(supabase, threadId, cutTo) {
  const latestCut = await supabase
    .from("chat_lock_items")
    .select("id,seq")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .eq("wants_cut", true)
    .order("seq", { ascending: false })
    .limit(1);

  if (latestCut.error) throw latestCut.error;
  const it = latestCut.data && latestCut.data[0] ? latestCut.data[0] : null;
  if (!it) return null;

  const up = await supabase
    .from("chat_lock_items")
    .update({ cut_to_cm: Number(cutTo) })
    .eq("id", it.id);

  if (up.error) throw up.error;
  return it;
}

function buildItemsBreakdown(items) {
  const lines = [];
  let subtotal = 0;

  for (const it of (items || [])) {
    const p = Number(it.price_rm || 0);
    subtotal += p;

    const tag = it.tag_raw
      ? it.tag_raw
      : [
        it.size_text ? `S:${it.size_text}` : "",
        it.weight_g ? `W:${it.weight_g}gm` : ""
      ].filter(Boolean).join(" / ");

    const tagPart = tag ? ` (${tag})` : "";
    const cutPart = it.wants_cut
      ? ` • POTONG → ${it.cut_to_cm ? it.cut_to_cm + "cm" : "?"}`
      : "";

    lines.push(`Item ${it.seq}: ${fmtRM(p)}${tagPart}${cutPart}`);
  }

  return { lines, subtotal };
}

/* =========================
   3A) J916 EXACT MATCH HELPERS
   - EXACT weight, then EXACT length (S)
========================= */

async function findJ916ExactCandidates(supabase, { weight_g, size }, limit = 5) {
  const wRaw = (weight_g !== null && weight_g !== undefined && weight_g !== "")
    ? String(weight_g)
    : "";
  if (!wRaw) return [];

  const sNum = (size !== null && size !== undefined && size !== "")
    ? Number(size)
    : null;

  if (!(sNum && isFinite(sNum) && sNum > 0)) {
    return [];
  }

  const base = await supabase
    .from("j916_items")
    .select("id,code,design_id,weight_g,length_cm,status,is_active,active")
    .eq("is_active", true)
    .eq("active", true)
    .eq("weight_g", wRaw)
    .order("created_at", { ascending: false })
    .limit(200);

  if (base.error) throw base.error;

  const rows = (base.data || []).filter(r => isJ916AvailableStatus(r.status));
  if (!rows.length) return [];

  const exactSize = rows.filter(r => Number(r.length_cm || 0) === sNum);
  if (!exactSize.length) return [];

  return exactSize.slice(0, limit);
}

function renderJ916PickList(cands) {
  return (cands || []).map((it, idx) => {
    const w = (it.weight_g !== null && it.weight_g !== undefined) ? `${it.weight_g}g` : "";
    const l = (it.length_cm && Number(it.length_cm) > 0) ? ` / ${it.length_cm}cm` : "";
    const extra = (w || l) ? ` (${w}${l})` : "";
    return `${idx + 1}) ${it.code}${extra}`;
  }).join("\n");
}

/* =========================
   3B) SOP FROM SUPABASE (chat_sop)
========================= */

let _sopCache = { map: {} };

async function sopGet(supabase, key) {
  const now = Date.now();

  const hit = _sopCache.map[key];
  if (hit && (now - hit.at) < 60_000) return hit.row;

  const q = await supabase
    .from("chat_sop")
    .select("key,body,is_active")
    .eq("key", key)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (q.error) throw q.error;
  const row = q.data || null;

  if (row) _sopCache.map[key] = { at: now, row };
  return row;
}

function sopRender(tpl, vars = {}) {
  let s = String(tpl || "");
  for (const [k, v] of Object.entries(vars || {})) {
    s = s.replaceAll(`{${k}}`, String(v ?? ""));
  }
  return s;
}

async function Tdb(supabase, key, vars = {}) {
  const row = await sopGet(supabase, key);
  if (!row) return `⚠️ SOP tiada: ${key}`;
  return sopRender(row.body, vars);
}

/* =========================
   4) MAIN HANDLER
========================= */

exports.handler = async function handler(event) {
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
    const msg = String(body.message || "").trim();
    const threadIdIn = body.thread_id || null;

    const attachment = body.attachment || null;
    const fileUrl =
      (attachment && attachment.url) ||
      body.file_url || body.attachment_url || body.url || "";
    const fileName =
      (attachment && attachment.name) || body.file_name || "";
    const fileMime =
      (attachment && attachment.mime) || body.file_mime || "";

    const isLoggedIn =
      body.is_logged_in === true ||
      String(body.is_logged_in).toLowerCase() === "true";

    if (!msg && !fileUrl) {
      return json(400, { ok: false, error: "Message kosong & tiada lampiran" });
    }

    const p = normalizePhone(rawPhone);
    if (!p.ok) return json(400, { ok: false, error: p.error });

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";
    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, {
        ok: false,
        error: "Supabase env belum lengkap (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)."
      });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const siteUrl = process.env.SITE_PUBLIC_URL || "https://emasamir.app";
    const admin = process.env.CHAT_ADMIN_PHONE || "";

    /* ========= 1) GET/CREATE THREAD ========= */
    let threadId = threadIdIn;

    if (!threadId) {
      const find = await supabase
        .from("chat_threads")
        .select("id")
        .eq("customer_phone", p.e164)
        .order("created_at", { ascending: false })
        .limit(1);

      if (find.error) throw find.error;

      if (find.data && find.data[0] && find.data[0].id) {
        threadId = find.data[0].id;
      } else {
        const ins = await supabase
          .from("chat_threads")
          .insert({ customer_phone: p.e164, status: "OPEN" })
          .select("id")
          .single();
        if (ins.error) throw ins.error;
        threadId = ins.data.id;
      }
    }

    const th = await supabase
      .from("chat_threads")
      .select("id,status,customer_phone,meta")
      .eq("id", threadId)
      .single();
    if (th.error) throw th.error;

    const threadStatus = String(th.data?.status || "OPEN").toUpperCase();
    const inLockFlow = threadStatus.startsWith("LOCK_");

    /* ========= 2) OCR TAG (if image) ========= */
    let tagExtracted = null;
    const isImage = fileUrl && /^image\//i.test(fileMime || "");
    if (isImage) tagExtracted = await extractTagFromImage(fileUrl);

    /* ========= 3) SAVE CUSTOMER MESSAGE ========= */
    const insMsg = await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "customer",
      text: msg || "(lampiran)",
      meta: {
        country: p.country,
        is_logged_in: isLoggedIn,
        attachment: fileUrl ? { url: fileUrl, name: fileName, mime: fileMime } : null,
        tag_extracted: tagExtracted || null
      }
    });
    if (insMsg.error) throw insMsg.error;

    await supabase
      .from("chat_threads")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", threadId);

    const tLower = String(msg || "").toLowerCase();
    const intents = await getActiveIntents(supabase);

    // try match DB intent first
    let matchedIntent = null;
    for (const row of intents) {
      if (matchIntentRow(tLower, row, inLockFlow)) {
        matchedIntent = row;
        break;
      }
    }

    if (matchedIntent && matchedIntent.sop_key) {
      const reply = await Tdb(supabase, matchedIntent.sop_key, {
        phone: p.e164,
        threadId: threadId
      });

      if (matchedIntent.set_thread_status) {
        // bila set status baru, reset transient
        const metaClean = resetTransientMeta(th.data?.meta || {});
        await supabase
          .from("chat_threads")
          .update({ status: String(matchedIntent.set_thread_status).toUpperCase(), meta: metaClean })
          .eq("id", threadId);
      }

      if (matchedIntent.clear_lock_items) {
        await supabase
          .from("chat_lock_items")
          .update({ status: "CANCELLED" })
          .eq("thread_id", threadId)
          .eq("status", "OPEN");
      }

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { intent_db: matchedIntent.intent_key, sop_key: matchedIntent.sop_key }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "intent_db" });
    }

    /* ========= 4) ROUTE INTENT ========= */
    const r = routeIntent({ msg, fileUrl, isLoggedIn, threadStatus });
    const hardLockIntent = r.isLock;
    const lockIntent = hardLockIntent || (inLockFlow && !r.isGreeting);

    /* ========= 4A) PICK J916 CANDIDATE (reply 1/2) ========= */
    if (inLockFlow) {
      const metaNow = th.data?.meta || {};
      const picks = Array.isArray(metaNow.j916_pick_candidates) ? metaNow.j916_pick_candidates : [];
      const ans = String(msg || "").trim();

      const isPickNumber = /^[1-9][0-9]*$/.test(ans);

      if (picks.length && isPickNumber) {
        const idx = Number(ans) - 1;
        const chosen = (idx >= 0 && idx < picks.length) ? picks[idx] : null;

        if (!chosen) {
          const reply =
            `Baik cik 😊 Nombor tu tak ada dalam pilihan.\n` +
            `Sila balas nombor yang betul ya (contoh: 1 atau 2).`;

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { pick_j916_invalid: true, picks_count: picks.length }
          });

          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "pick_j916_invalid" });
        }

        const pickedPrice =
          (metaNow.j916_pick_price_rm !== null && metaNow.j916_pick_price_rm !== undefined && metaNow.j916_pick_price_rm !== "")
            ? Number(metaNow.j916_pick_price_rm)
            : (
              (metaNow?.j916_pick_tag?.price_rm !== null && metaNow?.j916_pick_tag?.price_rm !== undefined && metaNow?.j916_pick_tag?.price_rm !== "")
                ? Number(metaNow.j916_pick_tag.price_rm)
                : null
            );

        const pickedHasPrice = (pickedPrice !== null && isFinite(pickedPrice) && pickedPrice > 0);

        let chosenRow = null;
        try {
          const q = await supabase
            .from("j916_items")
            .select("id,code,weight_g,length_cm,design_id,j916_designs(name,width_cm,cat_code,img1_url,img2_url,img3_url)")
            .eq("code", chosen)
            .limit(1)
            .maybeSingle();

          if (!q.error && q.data) chosenRow = q.data;
        } catch (_) { }

        const chosenLen =
          (chosenRow?.length_cm !== null && chosenRow?.length_cm !== undefined && chosenRow?.length_cm !== "")
            ? Number(chosenRow.length_cm)
            : null;

        const chosenWeight =
          (chosenRow?.weight_g !== null && chosenRow?.weight_g !== undefined && chosenRow?.weight_g !== "")
            ? Number(chosenRow.weight_g)
            : null;

        const chosenName = chosenRow?.j916_designs?.name
          ? String(chosenRow.j916_designs.name).trim()
          : null;

        const chosenWidth =
          (chosenRow?.j916_designs?.width_cm !== null && chosenRow?.j916_designs?.width_cm !== undefined && chosenRow?.j916_designs?.width_cm !== "")
            ? Number(chosenRow.j916_designs.width_cm)
            : null;

        const chosenCat = chosenRow?.j916_designs?.cat_code
          ? String(chosenRow.j916_designs.cat_code).trim().toUpperCase()
          : null;

        // simpan pilihan dalam thread meta + clear candidates (reset transient juga)
        const metaClean = resetTransientMeta(metaNow);

        await supabase
          .from("chat_threads")
          .update({
            meta: {
              ...metaClean,
              j916_selected_code: chosen,
              j916_selected_at: new Date().toISOString(),
              j916_selected_length_cm: (chosenLen && isFinite(chosenLen)) ? chosenLen : null,
              j916_selected_weight_g: (chosenWeight && isFinite(chosenWeight)) ? chosenWeight : null,
              j916_selected_name: chosenName || null,
              j916_selected_width_cm: (chosenWidth && isFinite(chosenWidth)) ? chosenWidth : null,
              j916_selected_cat_code: chosenCat || null,

              j916_pick_candidates: [],
              j916_pick_weight_g: null,
              j916_pick_length_cm: null,
              j916_pick_for_lock_item_seq: null,

              j916_pick_price_rm: null,
              j916_pick_has_price: false,
              j916_pick_tagLine: null,
              j916_pick_name: null,
              j916_pick_tag: null
            }
          })
          .eq("id", threadId);

        // update lock item: item_code + panjang asal
        try {
          const seq = metaNow.j916_pick_for_lock_item_seq ? Number(metaNow.j916_pick_for_lock_item_seq) : null;
          if (seq) {
            const patch = { item_code: chosen };
            if (chosenLen && isFinite(chosenLen) && chosenLen > 0) {
              patch.current_length_cm = chosenLen;
            }

            await supabase
              .from("chat_lock_items")
              .update(patch)
              .eq("thread_id", threadId)
              .eq("seq", seq)
              .eq("status", "OPEN");
          }
        } catch (_) { }

        if (pickedHasPrice) {
          await setLatestItemPrice(supabase, threadId, pickedPrice);

          const reply =
            `Baik cik 😊 Saya dah set barang pilihan cik:\n` +
            (chosenName ? `✅ Nama: *${chosenName}*\n` : ``) +
            `✅ Code: *${chosen}*\n` +
            (chosenWeight ? `⚖️ Berat: *${chosenWeight}g*\n` : ``) +
            (chosenLen ? `📏 Panjang asal: *${chosenLen}cm*\n` : ``) +
            (chosenWidth ? `📐 Lebar: *${chosenWidth}cm*\n` : ``) +
            `💰 Harga: *${fmtRM(pickedPrice)}*\n\n` +
            `Sekarang cik nak ambil di kedai atau nak pos?`;

          await supabase
            .from("chat_threads")
            .update({ status: "LOCK_WAIT_SHIP" })
            .eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: {
              pick_j916_done: true,
              chosen_code: chosen,
              length_cm: chosenLen || null,
              price_rm: pickedPrice,
              price_from_image: true,
              lock_sop: true,
              step: "LOCK_WAIT_SHIP"
            }
          });

          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "pick_j916_done_price_to_ship" });
        }

        const reply =
          `Baik cik 😊 Saya dah set barang yang cik pilih:\n` +
          (chosenName ? `✅ Nama: *${chosenName}*\n` : ``) +
          `✅ Code: *${chosen}*\n` +
          (chosenWeight ? `⚖️ Berat: *${chosenWeight}g*\n` : ``) +
          (chosenLen ? `📏 Panjang asal: *${chosenLen}cm*\n` : ``) +
          (chosenWidth ? `📐 Lebar: *${chosenWidth}cm*\n` : ``) +
          `\nKalau cik ingat, harga masa LIVE tadi berapa ya?\n` +
          `Kalau tak ingat, cik boleh balas “lupa harga”.`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { pick_j916_done: true, chosen_code: chosen, length_cm: chosenLen || null }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "pick_j916_done" });
      }
    }

    /* ========= 5) SEMAK TAG (tanpa lock) ========= */
    if (fileUrl && r.isSemakTag) {
      const raw = tagExtracted?.raw || null;
      const s = tagExtracted?.size ? `S:${tagExtracted.size}` : null;
      const w = tagExtracted?.weight_g ? `W:${tagExtracted.weight_g}gm` : null;
      const tagLine = raw || [s, w].filter(Boolean).join(" / ");

      const reply = tagLine
        ? await Tdb(supabase, "semak_tag.ok", { tagLine })
        : await Tdb(supabase, "semak_tag.fail");

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { semak_tag: true }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
        file_url: fileUrl,
        file_name: fileName
      });

      return json(200, { ok: true, thread_id: threadId, reply, action: "semak_tag" });
    }

    /* ========= 6) REQUIRE LOGIN ========= */
    if (lockIntent && !isLoggedIn) {
      const reply = await Tdb(supabase, "require_login.lock");

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { require_login: true, lock_intent: true }
      });

      const waToCustomer =
        `Emas Amir\n\n${reply}\n\n` +
        `Daftar: ${siteUrl}/login.html?next=/chat&phone=${p.e164}&thread=${threadId}`;

      await sendWA(event, p.e164, waToCustomer, { file_url: fileUrl, file_name: fileName });
      if (admin) await sendWA(event, admin, `🟡 LOCK REQUEST (perlu daftar)\nCustomer: ${p.e164}\nThread: ${threadId}`);

      return json(200, { ok: true, thread_id: threadId, reply, action: "require_login" });
    }

    /* ========= 7) NON-LOCK ========= */
    if (!lockIntent) {
      if (r.isGreeting) {
        const reply = await Tdb(supabase, "greet.default");
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { greeting: true }
        });
        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "greet" });
      }

      if (r.isDaily) {
        const reply = await Tdb(supabase, "info.daily_price", { siteUrl });
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { info: "daily_price" }
        });
        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "info" });
      }

      if (r.payAtome) {
        const reply = await Tdb(supabase, "pay.ansuran.reply");

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { pay_atome: true }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);

        return json(200, { ok: true, thread_id: threadId, reply, action: "pay_atome" });
      }

      if (fileUrl) {
        const reply = await Tdb(supabase, "attachment.ask_intent");
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { got_attachment: true }
        });
        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
          file_url: fileUrl,
          file_name: fileName
        });
        return json(200, { ok: true, thread_id: threadId, reply, action: "ask_intent" });
      }

      await supabase.from("chat_unknown_intents").insert({
        thread_id: threadId,
        phone: p.e164,
        message: msg,
        thread_status: threadStatus
      });

      const reply = await Tdb(supabase, "fallback.default");
      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { fallback: true }
      });
      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "fallback" });
    }

    /* ========= 8) LOCK FLOW (LOGGED IN) ========= */

    // kalau tiba2 tanya harga harian dalam lock flow
    if (r.isDaily && inLockFlow) {
      const reply = await Tdb(supabase, "info.daily_price", { siteUrl });
      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { info: "daily_price", lock_flow: true }
      });
      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "info_only" });
    }

    // start lock
    if (!inLockFlow) {
      const low = msg.toLowerCase();
      const noImage =
        low.includes("tak sempat") ||
        low.includes("tiada gambar") ||
        low.includes("tak ada gambar") ||
        low.includes("takde gambar") ||
        low.includes("lupa ambik") ||
        low.includes("lupa amik");

      const reply = noImage
        ? await Tdb(supabase, "lock.start.no_image")
        : await Tdb(supabase, "lock.start.ask_tag");

      // bila start lock, reset transient meta (supaya lock baru tak diwarisi flag lama)
      const metaClean = resetTransientMeta(th.data?.meta || {});

      await supabase.from("chat_threads").update({ status: "LOCK_WAIT_TAG", meta: metaClean }).eq("id", threadId);
      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { lock_sop: true, step: "LOCK_WAIT_TAG" }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      if (admin) await sendWA(event, admin, `🟠 LOCK START\nCustomer: ${p.e164}\nSTEP: LOCK_WAIT_TAG\nThread: ${threadId}`);

      return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
    }

    // ===== STATES =====
    // LOCK_WAIT_TAG
    // LOCK_PICK_J916
    // LOCK_WAIT_PRICE
    // LOCK_WAIT_SHIP
    // LOCK_WAIT_CUT_ITEM
    // LOCK_WAIT_CUT_LEN
    // LOCK_WAIT_PAY
    // LOCK_DONE

    /* ========= LOCK_WAIT_TAG ========= */
    if (threadStatus === "LOCK_WAIT_TAG") {
      if (!fileUrl) {
        const reply = await Tdb(supabase, "lock.wait_tag.remind");
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_TAG" }
        });
        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
      }

      const created = await createLockItemFromTag(
        supabase,
        threadId,
        tagExtracted,
        { url: fileUrl, name: fileName, mime: fileMime }
      );

      const tagName = tagExtracted?.name ? String(tagExtracted.name).trim() : null;

      const tagPriceNum = (tagExtracted?.price_rm !== null && tagExtracted?.price_rm !== undefined && tagExtracted?.price_rm !== "")
        ? Number(tagExtracted.price_rm)
        : null;

      const tagPriceOk = (tagPriceNum !== null && isFinite(tagPriceNum) && tagPriceNum > 0);
      const tagPrice = tagPriceOk ? fmtRM(tagPriceNum) : null;

      const raw = tagExtracted?.raw || null;
      const s = tagExtracted?.size ? `S:${tagExtracted.size}` : null;
      const wTxt = tagExtracted?.weight_g ? `W:${tagExtracted.weight_g}gm` : null;
      const lTxt = tagExtracted?.width_cm ? `L:${tagExtracted.width_cm}cm` : null;

      const tagLine = (
        raw ||
        [tagName, s, wTxt, lTxt, tagPrice].filter(Boolean).join(" / ") ||
        [s, wTxt, lTxt].filter(Boolean).join(" / ")
      );

      // exact match J916
      try {
        const w = tagExtracted?.weight_g ?? null;
        const sSize = tagExtracted?.size ?? null;

        if (w) {
          const cands = await findJ916ExactCandidates(supabase, { weight_g: w, size: sSize }, 5);

          if (!cands || cands.length === 0) {
            try {
              await supabase
                .from("chat_lock_items")
                .update({ status: "CANCELLED" })
                .eq("thread_id", threadId)
                .eq("seq", created.seq)
                .eq("status", "OPEN");
            } catch (_) { }

            const hasS = !!(tagExtracted?.size);
            const hasW = !!(tagExtracted?.weight_g);
            const hasGoodTag = hasS && hasW;

            const reply =
              (!hasS && hasW)
                ? (
                  `Maaf cik 😊\n` +
                  `Saya dah baca tag: *${tagLine || "-"}*\n\n` +
                  `Untuk padankan stok, kami perlukan *S (size/panjang)* sekali.\n` +
                  `Dalam gambar ni bahagian *S/size tak nampak / tiada*.\n\n` +
                  `✅ Cara paling cepat:\n` +
                  `1) Cik balas *S berapa* (contoh: S20), ATAU\n` +
                  `2) Ambil screenshot yang nampak jelas *S & W*.\n\n` +
                  `Terima kasih cik 🙏`
                )
                : (hasS && hasW)
                  ? (
                    `Maaf cik 😔\n` +
                    `Saya dah semak ikut tag: *${tagLine || "-"}*\n\n` +
                    `✅ Data stok untuk size/berat ni *tak jumpa*.\n` +
                    `Item ini *kemungkinan dah dibayar (PAID) / dah dijual*.\n\n` +
                    `Cik boleh *LOCK item lain* dalam LIVE atau terus pilih di *emasamir.app*.\n` +
                    `Kalau cik rasa data betul, minta item tu *masuk LIVE semula* dan ambil screenshot tag yang ada *S/W/L* ya.\n` +
                    `Kalau tak sempat, tak apa — *staf lain akan respon* bila ada info yang cukup.`
                  )
                  : (
                    `Maaf cik 😊\n` +
                    `Untuk padankan stok, kami perlukan maklumat tag yang jelas: *S (size/panjang) & W (berat)*.\n\n` +
                    `Boleh cik ambil screenshot tag *lebih dekat* supaya nampak S/W/L ya.\n` +
                    `Kalau tak sempat, tak apa — *staf lain akan respon* bila ada maklumat yang cukup.`
                  );

            await supabase.from("chat_messages").insert({
              thread_id: threadId,
              role: "ai",
              text: reply,
              meta: {
                lock_sop: true,
                step: "LOCK_WAIT_TAG",
                pick_j916_none: true,
                tagLine: tagLine || null,
                likely_paid: hasGoodTag ? true : false
              }
            });

            await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
              file_url: fileUrl,
              file_name: fileName
            });

            return json(200, { ok: true, thread_id: threadId, reply, action: "pick_j916_none" });
          }

          if (cands.length >= 2) {
            const list = renderJ916PickList(cands);

            if (tagPriceOk) {
              await setLatestItemPrice(supabase, threadId, tagPriceNum);
            }

            const reply =
              `Baik cik 😊 Saya jumpa beberapa code barang yang *sebijik* ikut tag.\n\n` +
              `📌 Tag dikesan: *${tagLine || "-"}*\n` +
              (tagPriceOk ? `💰 Harga dikesan: *${fmtRM(tagPriceNum)}*\n\n` : `\n`) +
              `Cik pilih nombor ya:\n\n` +
              `${list}\n\n` +
              `Balas contoh: *1* atau *2*`;

            const th2 = await supabase
              .from("chat_threads")
              .select("meta")
              .eq("id", threadId)
              .single();

            const metaNow2 = (th2.data && th2.data.meta) ? th2.data.meta : {};
            const metaClean2 = resetTransientMeta(metaNow2);

            await supabase
              .from("chat_threads")
              .update({
                status: "LOCK_PICK_J916",
                meta: {
                  ...metaClean2,
                  j916_pick_candidates: cands.map(x => x.code),
                  j916_pick_weight_g: w,
                  j916_pick_length_cm: (sSize ? Number(sSize) : null),
                  j916_pick_for_lock_item_seq: created?.seq || null,

                  j916_pick_price_rm: tagPriceOk ? Number(tagPriceNum) : null,
                  j916_pick_has_price: tagPriceOk ? true : false,
                  j916_pick_tagLine: tagLine || null,
                  j916_pick_name: tagName || null,

                  j916_pick_tag: {
                    name: tagName || null,
                    tagLine: tagLine || null,
                    price_rm: tagPriceOk ? Number(tagPriceNum) : null,
                    weight_g: (tagExtracted?.weight_g ?? null),
                    width_cm: (tagExtracted?.width_cm ?? null),
                    size: (tagExtracted?.size ?? null)
                  }
                }
              })
              .eq("id", threadId);

            await supabase.from("chat_messages").insert({
              thread_id: threadId,
              role: "ai",
              text: reply,
              meta: {
                pick_j916: true,
                step: "LOCK_PICK_J916",
                candidates: cands.map(x => x.code),
                tag: {
                  name: tagName || null,
                  tagLine: tagLine || null,
                  price_rm: tagPriceOk ? Number(tagPriceNum) : null,
                  weight_g: (tagExtracted?.weight_g ?? null),
                  size: (tagExtracted?.size ?? null)
                }
              }
            });

            await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
              file_url: fileUrl,
              file_name: fileName
            });

            return json(200, { ok: true, thread_id: threadId, reply, action: "pick_j916_candidate" });
          }

          // cands.length === 1
          if (cands.length === 1) {
            const one = cands[0];

            let chosenRow = null;
            try {
              const q = await supabase
                .from("j916_items")
                .select("id,code,weight_g,length_cm,design_id,j916_designs(name,width_cm,cat_code,img1_url,img2_url,img3_url)")
                .eq("code", one.code)
                .limit(1)
                .maybeSingle();
              if (!q.error && q.data) chosenRow = q.data;
            } catch (_) { }

            const chosenLen =
              (chosenRow?.length_cm !== null && chosenRow?.length_cm !== undefined && chosenRow?.length_cm !== "")
                ? Number(chosenRow.length_cm)
                : (sSize ? Number(sSize) : null);

            const chosenWeight =
              (chosenRow?.weight_g !== null && chosenRow?.weight_g !== undefined && chosenRow?.weight_g !== "")
                ? Number(chosenRow.weight_g)
                : (w ? Number(w) : null);

            const chosenName = chosenRow?.j916_designs?.name
              ? String(chosenRow.j916_designs.name).trim()
              : (tagName ? String(tagName).trim() : null);

            const chosenWidth =
              (chosenRow?.j916_designs?.width_cm !== null && chosenRow?.j916_designs?.width_cm !== undefined && chosenRow?.j916_designs?.width_cm !== "")
                ? Number(chosenRow.j916_designs.width_cm)
                : null;

            const chosenCat = chosenRow?.j916_designs?.cat_code
              ? String(chosenRow.j916_designs.cat_code).trim().toUpperCase()
              : null;

            const th2 = await supabase
              .from("chat_threads")
              .select("meta")
              .eq("id", threadId)
              .single();

            const metaNow2 = (th2.data && th2.data.meta) ? th2.data.meta : {};
            const metaClean2 = resetTransientMeta(metaNow2);

            await supabase
              .from("chat_threads")
              .update({
                meta: {
                  ...metaClean2,
                  j916_selected_code: one.code,
                  j916_selected_from: "exact_match",
                  j916_selected_at: new Date().toISOString(),
                  j916_selected_length_cm: (chosenLen && isFinite(chosenLen)) ? chosenLen : null,
                  j916_selected_weight_g: (chosenWeight && isFinite(chosenWeight)) ? chosenWeight : null,
                  j916_selected_name: chosenName || null,
                  j916_selected_width_cm: (chosenWidth && isFinite(chosenWidth)) ? chosenWidth : null,
                  j916_selected_cat_code: chosenCat || null,

                  j916_pick_candidates: [],
                  j916_pick_weight_g: null,
                  j916_pick_length_cm: null,
                  j916_pick_for_lock_item_seq: null
                }
              })
              .eq("id", threadId);

            try {
              const seq = created?.seq ? Number(created.seq) : null;
              if (seq) {
                const patch = { item_code: one.code };
                if (chosenLen && isFinite(chosenLen) && chosenLen > 0) patch.current_length_cm = chosenLen;

                await supabase
                  .from("chat_lock_items")
                  .update(patch)
                  .eq("thread_id", threadId)
                  .eq("seq", seq)
                  .eq("status", "OPEN");
              }
            } catch (_) { }

            if (tagPriceOk) {
              await setLatestItemPrice(supabase, threadId, tagPriceNum);

              const reply =
                `Baik cik 😊 Kami dah terima lampiran dan terus lockkan ✅\n\n` +
                `✅ Saya nampak tag: ${tagLine || "-"}\n` +
                `✅ Code (stok): *${one.code}*\n` +
                (chosenName ? `✅ Nama: *${chosenName}*\n` : ``) +
                (chosenWeight ? `✅ Berat: *${chosenWeight}g*\n` : ``) +
                (chosenLen ? `✅ Panjang asal: *${chosenLen}cm*\n` : ``) +
                (chosenWidth ? `✅ Lebar: *${chosenWidth}cm*\n` : ``) +
                `✅ Harga pada LIVE: *${fmtRM(tagPriceNum)}*\n\n` +
                `Cik nak ambil di kedai (walk-in) atau nak kami pos?`;

              await supabase
                .from("chat_threads")
                .update({ status: "LOCK_WAIT_SHIP", meta: resetTransientMeta(metaClean2) })
                .eq("id", threadId);

              await supabase.from("chat_messages").insert({
                thread_id: threadId,
                role: "ai",
                text: reply,
                meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", auto_exact_one: true, code: one.code, price_rm: tagPriceNum }
              });

              await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
                file_url: fileUrl,
                file_name: fileName
              });

              return json(200, { ok: true, thread_id: threadId, reply, action: "lock_exact_one_price_to_ship" });
            }

            const reply =
              `Baik cik 😊 Kami dah terima lampiran dan terus lockkan ✅\n\n` +
              `✅ Saya nampak tag: ${tagLine || "-"}\n` +
              `✅ Code (stok): *${one.code}*\n\n` +
              `Kalau cik ingat, harga masa LIVE tadi berapa ya?\n` +
              `Kalau tak ingat, cik boleh balas “lupa harga”.`;

            await supabase
              .from("chat_threads")
              .update({ status: "LOCK_WAIT_PRICE", meta: resetTransientMeta(metaClean2) })
              .eq("id", threadId);

            await supabase.from("chat_messages").insert({
              thread_id: threadId,
              role: "ai",
              text: reply,
              meta: { lock_sop: true, step: "LOCK_WAIT_PRICE", auto_exact_one: true, code: one.code }
            });

            await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
              file_url: fileUrl,
              file_name: fileName
            });

            return json(200, { ok: true, thread_id: threadId, reply, action: "lock_exact_one_ask_price" });
          }
        }
      } catch (e) {
        console.warn("findJ916ExactCandidates error:", e?.message || e);
      }

      // CASE A: OCR jumpa harga
      if (tagPriceOk) {
        await setLatestItemPrice(supabase, threadId, tagPriceNum);

        const reply = await Tdb(supabase, "lock.tag_received.price_detected.ask_ship", {
          tagLine,
          price: fmtRM(tagPriceNum),
          name: tagName || ""
        });

        // reset transient bila tukar step
        const metaClean = resetTransientMeta(th.data?.meta || {});

        await supabase.from("chat_threads").update({ status: "LOCK_WAIT_SHIP", meta: metaClean }).eq("id", threadId);
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: {
            lock_sop: true,
            step: "LOCK_WAIT_SHIP",
            item_seq: created.seq,
            tag_name: tagName || null,
            tag_price_rm: tagPriceNum,
            price_from_image: true
          }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
          file_url: fileUrl,
          file_name: fileName
        });

        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
      }

      // CASE B: tiada harga → tanya harga
      const reply = await Tdb(supabase, "lock.tag_received.ask_price", { tagLine });

      const metaClean = resetTransientMeta(th.data?.meta || {});

      await supabase.from("chat_threads").update({ status: "LOCK_WAIT_PRICE", meta: metaClean }).eq("id", threadId);
      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: {
          lock_sop: true,
          step: "LOCK_WAIT_PRICE",
          item_seq: created.seq,
          tag_name: tagName || null,
          tag_price_rm: null
        }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, {
        file_url: fileUrl,
        file_name: fileName
      });

      return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
    }

    /* ========= LOCK_WAIT_PRICE ========= */
    if (threadStatus === "LOCK_WAIT_PRICE") {
      if (r.forgotPrice) {
        const reply = await Tdb(supabase, "lock.price.forgot.ask_ship");

        const metaClean = resetTransientMeta(th.data?.meta || {});
        await supabase.from("chat_threads").update({ status: "LOCK_WAIT_SHIP", meta: metaClean }).eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", price_rm: null }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
      }

      const price = parsePriceRM(msg);
      if (price) {
        await setLatestItemPrice(supabase, threadId, price);

        const reply = await Tdb(supabase, "lock.price.ok.ask_ship", { price: fmtRM(price) });

        const metaClean = resetTransientMeta(th.data?.meta || {});
        await supabase.from("chat_threads").update({ status: "LOCK_WAIT_SHIP", meta: metaClean }).eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", price_rm: Number(price) }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
      }

      const reply2 = await Tdb(supabase, "lock.wait_price.remind");
      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply2,
        meta: { lock_sop: true, step: "LOCK_WAIT_PRICE" }
      });
      await sendWA(event, p.e164, `Emas Amir\n\n${reply2}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true, thread_id: threadId, reply: reply2, action: "lock_step" });
    }

    /* ========= PART 1 END ========= */
    // Sambungan selepas ini bermula dari:
    // if (threadStatus === "LOCK_WAIT_SHIP") { ... }
    // termasuk LOCK_WAIT_CUT_ITEM, LOCK_WAIT_CUT_LEN, LOCK_WAIT_PAY, LOCK_DONE
    //
    // >>> Amir reply: "masuk part 2" untuk saya bagi sambungan penuh sampai habis.

    

// =========================
// chat-send.js (PART 2)
// Sambungan dari: if (threadStatus === "LOCK_WAIT_SHIP") { ... }
// Pastikan PART 1 dah dipaste dulu.
// =========================

    /* ========= LOCK_WAIT_SHIP ========= */
    if (threadStatus === "LOCK_WAIT_SHIP") {
      // ambil customer profile (fallback banyak format phone)
let cust = null;
try {
  const local0 =
    (p.country === "MY" && p.e164.startsWith("60"))
      ? ("0" + p.e164.slice(2))
      : null;

  const candidates = [
    p.e164,
    "+" + p.e164,
    local0
  ].filter(Boolean);

  for (const ph of candidates) {
    const qc = await supabase
      .from("customers")
      .select("id,name,phone,alamat,postcode,city,state")
      .eq("phone", ph)
      .limit(1)
      .maybeSingle();

    if (!qc.error && qc.data) {
      cust = qc.data;
      break;
    }
  }
} catch (_) {}

      const metaNow = th.data?.meta || {};

      // detect pilihan pickup/pos
      const low = String(msg || "").toLowerCase();

      const wantPickup =
        low.includes("ambil") ||
        low.includes("pickup") ||
        low.includes("walk in") ||
        low.includes("walkin") ||
        low.includes("walk-in") ||
        low.includes("datang") ||
        low.includes("kedai");

      const wantPost =
        low.includes("pos") ||
        low.includes("post") ||
        low.includes("delivery") ||
        low.includes("hantar") ||
        low.includes("courier") ||
        low.includes("gdex") ||
        low.includes("jne");

      // 1) Kalau user jawab pelik → guide
      if (!wantPickup && !wantPost) {
        // jika dia jawab "hari ni/malam ni/esok" tapi belum pilih pickup/pos, kita anggap PICKUP
        const looksLikeTime =
          low.includes("hari") ||
          low.includes("malam") ||
          low.includes("pagi") ||
          low.includes("petang") ||
          low.includes("esok") ||
          low.includes("lusa") ||
          low.match(/\b\d{1,2}(:\d{2})?\s*(am|pm)?\b/);

        if (looksLikeTime) {
          const reply =
            `Baik cik 😊\n` +
            `Cik nak *ambil di kedai* ya? Kalau ya, cik boleh bagitahu masa (contoh: “esok petang 3pm”).\n\n` +
            `Kalau cik nak *pos*, balas “pos” ya.`;

          const metaUpd = setStepMeta(metaNow, {
            awaiting_pickup_when: true,
            pickup_when_text: null
          });

          await supabase
            .from("chat_threads")
            .update({ meta: metaUpd })
            .eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", awaiting_pickup_when: true }
          });

          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "lock_wait_ship_clarify_time" });
        }

        const reply =
          `Baik cik 😊\n` +
          `Cik nak ambil di kedai atau nak kami pos?\n\n` +
          `✅ Balas: “ambil kedai” atau “pos”`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", clarify: true }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_wait_ship_clarify" });
      }

      // 2) PICKUP
      if (wantPickup) {
        // jika address confirmation sedang tunggu, clear dulu sebab pickup tak perlukan pos
        const metaUpd = setStepMeta(metaNow, {
          ship_mode: "PICKUP",
          awaiting_pickup_when: true,
          pickup_when_text: null
        });

        await supabase
          .from("chat_threads")
          .update({ meta: metaUpd })
          .eq("id", threadId);

        const reply =
          `Baik cik 😊\n` +
          `✅ Pilihan: *Ambil di kedai*\n\n` +
          `Cik nak datang bila ya?\n` +
          `Contoh balas: “hari ni petang”, “esok 3pm”, “malam lepas Isyak”.`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "PICKUP", awaiting_pickup_when: true }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        if (admin) await sendWA(event, admin, `🟢 LOCK SHIP MODE\nPICKUP\nCustomer:${p.e164}\nThread:${threadId}`);

        return json(200, { ok: true, thread_id: threadId, reply, action: "ship_pickup_ask_when" });
      }

      // 3) POST
      if (wantPost) {
        const addr = formatAddress(cust);

        // kalau tiada alamat
        if (!addr) {
          const reply =
            `Baik cik 😊✅ Pilihan: *Pos*\n\n` +
            `Saya belum nampak alamat penghantaran dalam sistem.\n` +
            `Cik boleh balas alamat penuh (Alamat + Poskod + Bandar + Negeri) ya.`;

          const metaUpd = setStepMeta(metaNow, {
            ship_mode: "POST",
            awaiting_addr_confirm: true,
            addr_text: null
          });

          await supabase
            .from("chat_threads")
            .update({ meta: metaUpd })
            .eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "POST", need_address: true }
          });

          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "ship_post_need_address" });
        }

        // ada alamat → confirm
        const zone = detectMYZoneFromStateOrAddress(cust?.state, cust?.alamat);
        const fee = calcShipFee(p.country, zone);
        const label = shipLabel(p.country, zone);

        const reply =
          `Baik cik 😊✅ Pilihan: *Pos*\n\n` +
          `📍 Alamat penghantaran kami rekod:\n` +
          `${addr}\n\n` +
          `📦 Caj pos (anggaran): *${fmtRM(fee)}* (${label})\n\n` +
          `Alamat ni betul?\n` +
          `✅ Balas “YA” untuk teruskan.\n` +
          `✍️ Balas “TUKAR” untuk bagi alamat baru.`;

        const metaUpd = setStepMeta(metaNow, {
  ship_mode: "POST",
  addr_text: addr,
  ship_fee_rm: fee,
  ship_label: label,
  ship_zone: zone,
  awaiting_addr_confirm: true,   // <<< WAJIB ADA
  addr_need_new: false           // <<< optional tapi bagus
});

        await supabase
          .from("chat_threads")
          .update({ meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "POST", awaiting_addr_confirm: true, ship_fee_rm: fee }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        if (admin) await sendWA(event, admin, `🟢 LOCK SHIP MODE\nPOST\nCustomer:${p.e164}\nThread:${threadId}\nFee:${fmtRM(fee)}`);

        return json(200, { ok: true, thread_id: threadId, reply, action: "ship_post_confirm_addr" });
      }
    }

  /* ========= LOCK_WAIT_SHIP (ADDRESS CONFIRM / PICKUP WHEN) ========= */
if (threadStatus === "LOCK_WAIT_SHIP") {
  const metaNow = th.data?.meta || {};
  const low = String(msg || "").toLowerCase().trim();

  /* =====================================================
     1) PRIORITY: SAMBUNG STEP YANG SEDANG MENUNGGU
  ====================================================== */

  // A) Pickup - tunggu masa datang
  if (metaNow.awaiting_pickup_when) {
    const whenText = String(msg || "").trim();

    const metaUpd = setStepMeta(metaNow, {
      ship_mode: "PICKUP",
      pickup_when_text: whenText,
      awaiting_pickup_when: false
    });

    await supabase
      .from("chat_threads")
      .update({ status: "LOCK_WAIT_CUT_ITEM", meta: metaUpd })
      .eq("id", threadId);

    const reply =
      `Baik cik 😊\n` +
      `✅ Cik akan ambil di kedai: *${whenText}*\n\n` +
      `Cik nak *potong* (ubah panjang) untuk item ni?\n` +
      `Balas: *POTONG* atau *TAK POTONG*.\n` +
      `Kalau item lebih dari 1, boleh tulis: “POTONG item 2 sahaja”.`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { lock_sop: true, step: "LOCK_WAIT_CUT_ITEM", pickup_when: whenText }
    });

    await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
    return json(200, { ok: true });
  }

  // B) Address confirm (YA / TUKAR)
  if (metaNow.awaiting_addr_confirm) {

    const yes =
      low === "ya" ||
      low === "yes" ||
      low.includes("betul") ||
      low.includes("confirm");

    const change =
      low.includes("tukar") ||
      low.includes("ubah") ||
      low.includes("change") ||
      low.includes("alamat baru");

    // --- User nak tukar alamat
    if (change) {
      const reply =
        `Baik cik 😊\n` +
        `Sila balas *alamat baru penuh* (Alamat + Poskod + Bandar + Negeri).`;

      const metaUpd = setStepMeta(metaNow, {
        addr_need_new: true
      });

      await supabase
        .from("chat_threads")
        .update({ meta: metaUpd })
        .eq("id", threadId);

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { lock_sop: true }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true });
    }

    // --- User sedang beri alamat baru
    if (metaNow.addr_need_new && !yes) {
      const newAddr = String(msg || "").trim();

      if (newAddr.length < 12) {
        const reply =
          `Alamat nampak terlalu pendek 😅\n` +
          `Sila beri alamat penuh (Alamat + Poskod + Bandar + Negeri).`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true });
      }

      const zone = detectMYZoneFromStateOrAddress("", newAddr);
      const fee = calcShipFee(p.country, zone);
      const label = shipLabel(p.country, zone);

      const reply =
        `Baik cik 😊 Saya rekod alamat baru:\n` +
        `${newAddr}\n\n` +
        `📦 Caj pos (anggaran): *${fmtRM(fee)}* (${label})\n\n` +
        `Alamat ni betul?\n` +
        `Balas: *YA* atau *TUKAR*`;

      const metaUpd = setStepMeta(metaNow, {
        ship_mode: "POST",
        addr_text: newAddr,
        ship_fee_rm: fee,
        ship_label: label,
        ship_zone: zone,
        addr_need_new: false,
        awaiting_addr_confirm: true
      });

      await supabase
        .from("chat_threads")
        .update({ meta: metaUpd })
        .eq("id", threadId);

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true });
    }

    // --- User confirm YA
    if (yes) {
      const metaUpd = setStepMeta(metaNow, {
        awaiting_addr_confirm: false,
        addr_need_new: false
      });

      await supabase
        .from("chat_threads")
        .update({ status: "LOCK_WAIT_CUT_ITEM", meta: metaUpd })
        .eq("id", threadId);

      const reply =
        `Baik cik 😊✅ Alamat confirm.\n\n` +
        `Cik nak *potong* (ubah panjang) untuk item ni?\n` +
        `Balas: *POTONG* atau *TAK POTONG*.`;

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true });
    }

    // --- Jawapan tak jelas
    const reply =
      `Maaf cik 😊 Balas *YA* untuk teruskan atau *TUKAR* untuk ubah alamat ya.`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply
    });

    await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
    return json(200, { ok: true });
  }
}

    /* ========= LOCK_WAIT_CUT_ITEM ========= */
    if (threadStatus === "LOCK_WAIT_CUT_ITEM") {
      const items = await getOpenLockItems(supabase, threadId);
      const metaNow = th.data?.meta || {};
      const low = String(msg || "").toLowerCase();

      if (!items.length) {
        const reply =
          `Maaf cik 😔 Saya tak jumpa item lock yang masih OPEN.\n` +
          `Boleh cik hantar semula gambar tag / mula semula lock ya.`;

        const metaClean = resetTransientMeta(metaNow);
        await supabase.from("chat_threads").update({ status: "OPEN", meta: metaClean }).eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, no_open_items: true }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "no_items" });
      }

      const noCut =
        low.includes("tak potong") ||
        low.includes("x potong") ||
        low.includes("taknak potong") ||
        low.includes("tak nak potong") ||
        low === "tak" ||
        low === "x";

      const yesCut =
        low.includes("potong") ||
        low.includes("cut");

      // Kalau TAK POTONG → terus payment
      if (noCut && !yesCut) {
        // reset potong flags supaya tak jem
        const metaUpd = setStepMeta(metaNow, { cut_mode: "NONE" });

        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_WAIT_PAY", meta: metaUpd })
          .eq("id", threadId);

        // payment summary
        const breakdown = buildItemsBreakdown(items);
        const shipFee = Number(metaNow.ship_fee_rm || 0);
        const grand = breakdown.subtotal + shipFee;

        const shipLine =
          (metaNow.ship_mode === "POST")
            ? `\n📦 Caj pos: ${fmtRM(shipFee)}`
            : `\n🏬 Ambil kedai: ${metaNow.pickup_when_text ? metaNow.pickup_when_text : "-"}`;

        const reply =
          `Baik cik 😊✅ *Tak potong.*\n\n` +
          `Ringkasan:\n` +
          breakdown.lines.join("\n") +
          shipLine +
          `\n\nJumlah: *${fmtRM(grand)}*\n\n` +
          `Cik nak bayar guna apa?\n` +
          `✅ Balas: “FPX”, “TRANSFER”, atau “ATOME”`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_PAY", subtotal: breakdown.subtotal, ship_fee_rm: shipFee, total: grand }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        if (admin) await sendWA(event, admin, `🟦 LOCK → PAY\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(grand)}\n(No cut)`);

        return json(200, { ok: true, thread_id: threadId, reply, action: "to_pay_no_cut" });
      }

      if (yesCut) {
        // parsing: "potong item 2 sahaja" atau "potong semua"
        const all =
          low.includes("semua") ||
          low.includes("all");

        const mItem = low.match(/item\s*([0-9]{1,3})/i);
        const onlySeq = mItem && mItem[1] ? Number(mItem[1]) : null;

        if (all) {
          await markAllOpenItemsCut(supabase, threadId, 18);

          const metaUpd = setStepMeta(metaNow, {
            cut_mode: "ALL",
            cut_seq_queue: items.map(x => x.seq),
            cut_target_seq: items[0]?.seq || null,
            awaiting_current_length: true
          });

          await supabase
            .from("chat_threads")
            .update({ status: "LOCK_WAIT_CUT_LEN", meta: metaUpd })
            .eq("id", threadId);

          const reply =
            `Baik cik 😊✅ *POTONG semua item*\n\n` +
            `Sebelum pilih nak potong jadi berapa cm, saya nak confirm *panjang asal* dulu.\n` +
            `Item ${items[0]?.seq}: panjang asal berapa cm ya? (contoh: 18cm)`;

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", cut_mode: "ALL", target_seq: items[0]?.seq || null }
          });

          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "cut_all_ask_current_len" });
        }

        if (onlySeq) {
          const chosen = items.find(x => Number(x.seq) === Number(onlySeq));
          if (!chosen) {
            const reply =
              `Item ${onlySeq} tak jumpa 😅\n` +
              `Item yang ada sekarang: ${items.map(x => x.seq).join(", ")}\n` +
              `Cuba balas “POTONG item ${items[0].seq}” ya.`;

            await supabase.from("chat_messages").insert({
              thread_id: threadId,
              role: "ai",
              text: reply,
              meta: { lock_sop: true, step: "LOCK_WAIT_CUT_ITEM", invalid_seq: onlySeq }
            });
            await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
            return json(200, { ok: true, thread_id: threadId, reply, action: "cut_invalid_seq" });
          }

          await markItemCutBySeq(supabase, threadId, onlySeq, 18);

          const metaUpd = setStepMeta(metaNow, {
            cut_mode: "ONE",
            cut_target_seq: onlySeq,
            awaiting_current_length: true
          });

          await supabase
            .from("chat_threads")
            .update({ status: "LOCK_WAIT_CUT_LEN", meta: metaUpd })
            .eq("id", threadId);

          const reply =
            `Baik cik 😊✅ *POTONG item ${onlySeq}*\n\n` +
            `Item ${onlySeq}: panjang asal berapa cm ya? (contoh: 18cm)`;

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", cut_mode: "ONE", target_seq: onlySeq }
          });

          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "cut_one_ask_current_len" });
        }

        // default: potong latest item
        const last = items[items.length - 1];
        await markLatestItemCut(supabase, threadId, 18);

        const metaUpd = setStepMeta(metaNow, {
          cut_mode: "LATEST",
          cut_target_seq: last.seq,
          awaiting_current_length: true
        });

        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_WAIT_CUT_LEN", meta: metaUpd })
          .eq("id", threadId);

        const reply =
          `Baik cik 😊✅ *POTONG item ${last.seq}*\n\n` +
          `Item ${last.seq}: panjang asal berapa cm ya? (contoh: 18cm)`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", cut_mode: "LATEST", target_seq: last.seq }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "cut_latest_ask_current_len" });
      }

      // tak jelas
      const reply =
        `Baik cik 😊\n` +
        `Cik nak *potong* atau *tak potong*?\n` +
        `✅ Balas “TAK POTONG” atau “POTONG”.`;

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { lock_sop: true, step: "LOCK_WAIT_CUT_ITEM", clarify: true }
      });
      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "cut_clarify" });
    }

    /* ========= LOCK_WAIT_CUT_LEN ========= */
    if (threadStatus === "LOCK_WAIT_CUT_LEN") {
      const metaNow = th.data?.meta || {};
      const items = await getOpenLockItems(supabase, threadId);

      const targetSeq = metaNow.cut_target_seq ? Number(metaNow.cut_target_seq) : null;
      const target = targetSeq ? items.find(x => Number(x.seq) === targetSeq) : null;

      // Step A: confirm current length
      if (metaNow.awaiting_current_length) {
        const curr = parseLengthCm(msg);
        if (!curr) {
          const reply =
            `Maaf cik 😊 Panjang asal berapa cm ya?\n` +
            `Contoh: 18cm / 19cm / 20cm.`;
          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", awaiting_current_length: true, invalid: true }
          });
          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "cut_need_current_len" });
        }

        // update current_length_cm untuk target item
        try {
          if (targetSeq) {
            await supabase
              .from("chat_lock_items")
              .update({ current_length_cm: Number(curr) })
              .eq("thread_id", threadId)
              .eq("seq", targetSeq)
              .eq("status", "OPEN");
          } else {
            // fallback: latest open
            const latest = await getLatestOpenItem(supabase, threadId);
            if (latest) {
              await supabase
                .from("chat_lock_items")
                .update({ current_length_cm: Number(curr) })
                .eq("id", latest.id);
            }
          }
        } catch (_) {}

        const metaUpd = setStepMeta(metaNow, {
          awaiting_current_length: false,
          current_length_cm: Number(curr)
        });

        await supabase
          .from("chat_threads")
          .update({ meta: metaUpd })
          .eq("id", threadId);

        const reply =
          `Baik cik 😊 Panjang asal: *${curr}cm*\n\n` +
          `Cik nak potong jadi *berapa cm*? (contoh: 16cm)`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", awaiting_cut_to: true, current_length_cm: Number(curr), target_seq: targetSeq || null }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "cut_ask_cut_to" });
      }

      // Step B: get cut_to
      const cutTo = parseLengthCm(msg);
      if (!cutTo) {
        const reply =
          `Maaf cik 😊 Cik nak potong jadi berapa cm?\n` +
          `Contoh: 16cm / 17cm.`;
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", invalid: true }
        });
        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "cut_need_cut_to" });
      }

      // validate
      const currLen = Number(metaNow.current_length_cm || (target?.current_length_cm || 0));
      if (currLen && cutTo >= currLen) {
        const reply =
          `Maaf cik 😊 Potong mesti *lebih pendek* dari panjang asal.\n` +
          `Panjang asal: *${currLen}cm*\n` +
          `Cik nak potong jadi berapa cm? (contoh: ${Math.max(10, currLen - 1)}cm)`;
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", invalid: true, current_length_cm: currLen }
        });
        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "cut_invalid_ge_current" });
      }

      // set cut_to for latest wants_cut item (or target)
      if (targetSeq) {
        await supabase
          .from("chat_lock_items")
          .update({ wants_cut: true, cut_to_cm: Number(cutTo) })
          .eq("thread_id", threadId)
          .eq("seq", targetSeq)
          .eq("status", "OPEN");
      } else {
        await setLatestCutTo(supabase, threadId, cutTo);
      }

      // jika cut_mode ALL dan ada queue, proceed to next seq
      if (String(metaNow.cut_mode || "").toUpperCase() === "ALL") {
        const queue = Array.isArray(metaNow.cut_seq_queue) ? metaNow.cut_seq_queue : [];
        const idx = targetSeq ? queue.indexOf(targetSeq) : -1;
        const nextSeq = (idx >= 0 && idx + 1 < queue.length) ? queue[idx + 1] : null;

        if (nextSeq) {
          // set next as target and ask its current len
          const metaUpd = setStepMeta(metaNow, {
            cut_target_seq: nextSeq,
            awaiting_current_length: true,
            current_length_cm: null
          });

          await supabase
            .from("chat_threads")
            .update({ meta: metaUpd })
            .eq("id", threadId);

          const reply =
            `Baik cik 😊 Item ${targetSeq} potong → *${cutTo}cm* ✅\n\n` +
            `Sekarang item ${nextSeq}: panjang asal berapa cm ya? (contoh: 18cm)`;

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", cut_mode: "ALL", done_seq: targetSeq || null, next_seq: nextSeq }
          });

          await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "cut_all_next_item" });
        }
      }

      // selesai potong → payment
      const metaUpd = setStepMeta(metaNow, {
        cut_target_seq: null,
        cut_seq_queue: null,
        cut_mode: null,
        current_length_cm: null
      });

      await supabase
        .from("chat_threads")
        .update({ status: "LOCK_WAIT_PAY", meta: metaUpd })
        .eq("id", threadId);

      const itemsAfter = await getOpenLockItems(supabase, threadId);
      const breakdown = buildItemsBreakdown(itemsAfter);
      const shipFee = Number(metaNow.ship_fee_rm || 0);
      const grand = breakdown.subtotal + shipFee;

      const shipLine =
        (metaNow.ship_mode === "POST")
          ? `\n📦 Caj pos: ${fmtRM(shipFee)}`
          : `\n🏬 Ambil kedai: ${metaNow.pickup_when_text ? metaNow.pickup_when_text : "-"}`;

      const reply =
        `Baik cik 😊✅ Rekod potong siap.\n\n` +
        `Ringkasan:\n` +
        breakdown.lines.join("\n") +
        shipLine +
        `\n\nJumlah: *${fmtRM(grand)}*\n\n` +
        `Cik nak bayar guna apa?\n` +
        `✅ Balas: “FPX”, “TRANSFER”, atau “ATOME”`;

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { lock_sop: true, step: "LOCK_WAIT_PAY", subtotal: breakdown.subtotal, ship_fee_rm: shipFee, total: grand }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      if (admin) await sendWA(event, admin, `🟦 LOCK → PAY\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(grand)}\n(Cut recorded)`);

      return json(200, { ok: true, thread_id: threadId, reply, action: "cut_done_to_pay" });
    }

    /* ========= LOCK_WAIT_PAY ========= */
    if (threadStatus === "LOCK_WAIT_PAY") {
      const metaNow = th.data?.meta || {};
      const low = String(msg || "").toLowerCase();

      const items = await getOpenLockItems(supabase, threadId);
      const breakdown = buildItemsBreakdown(items);

      const shipFee = Number(metaNow.ship_fee_rm || 0);
      const total = breakdown.subtotal + shipFee;

      const payFPX = low.includes("fpx");
      const payTransfer = low.includes("transfer") || low.includes("bank");
      const payAtome = low.includes("atome") || low.includes("tomey") || low.includes("ansur");

      // helper for payment links (placeholder)
      const mkFPXLink = () => `${siteUrl}/pay?thread=${encodeURIComponent(threadId)}&m=fpx`;
      const mkAtomeLink = () => `${siteUrl}/pay?thread=${encodeURIComponent(threadId)}&m=atome`;
      const mkTransferInfo = () =>
        `Bank Transfer:\n` +
        `✅ Nama akaun: Emas Amir\n` +
        `✅ (Isi nombor akaun bank dalam SOP chat_sop key: pay.transfer.details)\n` +
        `\nLepas bayar, hantar screenshot resit ya.`;

      if (payAtome) {
        const reply =
          `Baik cik 😊✅ Pilihan: *ATOME (ansuran)*\n\n` +
          `Jumlah: *${fmtRM(total)}*\n\n` +
          `Cik klik link ini untuk teruskan:\n` +
          `${mkAtomeLink()}\n\n` +
          `Nota: Bayaran pertama kali anda akan terus dapat barang.\n` +
          `Min ansuran 3 bulan dan ia boleh lebih dari 3 bulan bergantung akaun anda.\n` +
          `Cik boleh semak berapa bulan anda layak ketika scan QR Atome nanti.`;

        const metaUpd = setStepMeta(metaNow, { pay_method: "ATOME" });

        await supabase
          .from("chat_threads")
          .update({ meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_PAY", method: "ATOME", total }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        if (admin) await sendWA(event, admin, `🟣 PAY METHOD ATOME\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(total)}`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "pay_atome" });
      }

      if (payFPX) {
        const reply =
          `Baik cik 😊✅ Pilihan: *FPX*\n\n` +
          `Jumlah: *${fmtRM(total)}*\n\n` +
          `Cik klik link ini untuk bayar FPX:\n` +
          `${mkFPXLink()}\n\n` +
          `Lepas berjaya bayar, sistem akan auto-update.`;

        const metaUpd = setStepMeta(metaNow, { pay_method: "FPX" });

        await supabase
          .from("chat_threads")
          .update({ meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_PAY", method: "FPX", total }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        if (admin) await sendWA(event, admin, `🟣 PAY METHOD FPX\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(total)}`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "pay_fpx" });
      }

      if (payTransfer) {
        // kalau ada SOP bank details dalam DB, guna itu
        let transferTxt = null;
        try {
          transferTxt = await Tdb(supabase, "pay.transfer.details", {});
        } catch (_) {}

        const reply =
          `Baik cik 😊✅ Pilihan: *BANK TRANSFER*\n\n` +
          `Jumlah: *${fmtRM(total)}*\n\n` +
          (transferTxt && !transferTxt.startsWith("⚠️") ? transferTxt : mkTransferInfo()) +
          `\n\nLepas bayar, hantar screenshot resit ya.`;

        const metaUpd = setStepMeta(metaNow, { pay_method: "TRANSFER", awaiting_transfer_receipt: true });

        await supabase
          .from("chat_threads")
          .update({ meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_PAY", method: "TRANSFER", total, awaiting_transfer_receipt: true }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
        if (admin) await sendWA(event, admin, `🟣 PAY METHOD TRANSFER\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(total)}`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "pay_transfer" });
      }

      // transfer receipt flow: if awaiting and got image
      if (metaNow.awaiting_transfer_receipt && fileUrl && /^image\//i.test(fileMime || "")) {
        const reply =
          `Terima kasih cik 😊✅ Resit diterima.\n` +
          `Staf kami akan semak & confirm ya.\n\n` +
          `Status: *Dalam semakan*`;

        const metaUpd = setStepMeta(metaNow, {
          awaiting_transfer_receipt: false,
          transfer_receipt_url: fileUrl
        });

        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_DONE", meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_DONE", receipt_url: fileUrl }
        });

        await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`, { file_url: fileUrl, file_name: fileName });

        if (admin) {
          await sendWA(
            event,
            admin,
            `🧾 TRANSFER RECEIPT\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(total)}\nResit:${fileUrl}`
          );
        }

        return json(200, { ok: true, thread_id: threadId, reply, action: "transfer_receipt_received" });
      }

      const reply =
        `Baik cik 😊\n` +
        `Cik nak bayar guna apa?\n` +
        `✅ Balas: “FPX”, “TRANSFER”, atau “ATOME”`;

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { lock_sop: true, step: "LOCK_WAIT_PAY", clarify: true }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "pay_clarify" });
    }

    /* ========= LOCK_DONE ========= */
    if (threadStatus === "LOCK_DONE") {
      const metaNow = th.data?.meta || {};

      // jika user tanya apa-apa selepas selesai, bagi status + link
      const reply =
        `Baik cik 😊\n` +
        `✅ Lock cik dah direkod.\n\n` +
        `Staf kami akan uruskan (confirm stok / payment / pos).\n` +
        `Kalau cik nak tambah item lock lain, cik boleh mula semula dengan hantar gambar tag lagi ya.\n\n` +
        `Chat: ${siteUrl}/chat`;

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { lock_sop: true, step: "LOCK_DONE", keepalive: true }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "done_keepalive" });
    }

    /* ========= FALLBACK LOCK ========= */
    {
      const reply = await Tdb(supabase, "escalate.default");

      const metaClean = resetTransientMeta(th.data?.meta || {});
      await supabase
        .from("chat_threads")
        .update({ meta: metaClean })
        .eq("id", threadId);

      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply,
        meta: { escalate: true, fallback_lock: true, part1_fallback: true }
      });

      await sendWA(event, p.e164, `Emas Amir\n\n${reply}\n\n(Chat: ${siteUrl}/chat)`);

      if (admin) {
        await sendWA(
          event,
          admin,
          `🔴 Need human (fallback lock)\nThread:${threadId}\nCustomer:${p.e164}\nMsg:${msg || "(lampiran)"}`
        );
      }

      return json(200, { ok: true, thread_id: threadId, reply, action: "escalate" });
    }

} catch (e) {
  console.error("chat-send error:", e);
  return json(500, {
    ok: false,
    error: e?.message || String(e),
    stack: e?.stack || null
  });
}
};

/* =========================
   UTIL
========================= */

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