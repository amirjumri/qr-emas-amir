// netlify/functions/chat-send.js
const { createClient } = require("@supabase/supabase-js");
const { routeIntent } = require("./ai_router.js");
const payflow = require("./chat-payflow.js");
const gold999 = require("./chat-gold999.js");
const crypto = require("crypto");
const webpush = require("web-push");


function looksLikePaidProof(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("dah bayar") ||
    t.includes("sudah bayar") ||
    t.includes("bayar dah") ||
    t.includes("saya dah bayar") ||
    t.includes("slip") ||
    t.includes("bukti bayar") ||
    t.includes("resit") ||
    t.includes("receipt") ||
    t.includes("payment proof") ||
    t.includes("proof bayar")
  );
}

/* =========================
   0) HELPERS
========================= */

function fmtRM(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return "RM 0.00";
  return "RM " + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function floorRM(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return 0;
  // floor ke 2 decimal (sen)
  return Math.floor(x * 100) / 100;
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

function normalizePhoneText(raw) {
  let d = String(raw || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;
  return d;
}

function phoneVariantsText(raw) {
  const d = normalizePhoneText(raw);
  if (!d) return [];
  const out = new Set([d, "+" + d]);
  if (d.startsWith("60")) out.add("0" + d.slice(2));
  return Array.from(out);
}

function cutPushText(s, n = 120) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > n ? t.slice(0, n - 3) + "..." : t;
}

async function sendPushToOne(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { ok: true };
  } catch (e) {
    const code = Number(e?.statusCode || 0);
    if (code === 404 || code === 410) {
      return { ok: false, expired: true, error: e?.message || String(e) };
    }
    return { ok: false, expired: false, error: e?.message || String(e) };
  }
}

async function notifyAdminsCustomerChat({ supabase, threadId, customerPhone, message, attachment }) {
  const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || "").trim();
  const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || "").trim();
  const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || "mailto:support@emasamir.app").trim();

  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  }

  const adminQ = await supabase
    .from("admin_users")
    .select("phone,is_active")
    .eq("is_active", true);

  if (adminQ.error) throw adminQ.error;

  const adminPhones = (adminQ.data || [])
    .map(a => normalizePhoneText(a.phone))
    .filter(Boolean);

  const allAdminPhoneVariants = Array.from(
    new Set(adminPhones.flatMap(p => phoneVariantsText(p)))
  );

  if (!allAdminPhoneVariants.length) {
    return { web_sent: 0, web_failed: 0, web_expired: 0, ios_sent: 0, ios_failed: 0, android_sent: 0, android_failed: 0 };
  }

  const bodyText = message
    ? cutPushText(message, 120)
    : (attachment?.name ? `Customer hantar fail: ${attachment.name}` : "Customer masuk chat");

  const payload = {
    title: "Chat Customer Masuk",
    body: `${customerPhone}: ${bodyText || "Customer masuk chat"}`,
    url: `/admin-chat.html?thread=${encodeURIComponent(threadId)}`,
    deeplink: `/admin-chat.html?thread=${encodeURIComponent(threadId)}`,
    tag: `ea-admin-chat-${threadId}`,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png"
  };

  let webSent = 0, webFailed = 0, webExpired = 0;
  let iosSent = 0, iosFailed = 0;
  let androidSent = 0, androidFailed = 0;

  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    const webQ = await supabase
      .from("chat_push_subscriptions")
      .select("id,customer_phone,endpoint,p256dh,auth,is_active,created_at")
      .in("customer_phone", allAdminPhoneVariants)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(100);

    if (webQ.error) throw webQ.error;

    const seenEndpoints = new Set();

    for (const row of (webQ.data || [])) {
      const endpoint = String(row.endpoint || "").trim();
      if (!endpoint || seenEndpoints.has(endpoint)) continue;
      seenEndpoints.add(endpoint);

      const result = await sendPushToOne({
        endpoint,
        keys: {
          p256dh: String(row.p256dh || ""),
          auth: String(row.auth || "")
        }
      }, payload);

      if (result.ok) {
        webSent++;
      } else if (result.expired) {
        webExpired++;
        await supabase
          .from("chat_push_subscriptions")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", row.id);
      } else {
        webFailed++;
      }
    }
  }

  const iosQ = await supabase
    .from("chat_device_tokens")
    .select("id,customer_phone,device_token,platform,is_active,updated_at")
    .in("customer_phone", allAdminPhoneVariants)
    .eq("is_active", true)
    .eq("platform", "ios")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (iosQ.error) throw iosQ.error;

  const seenIos = new Set();

  for (const row of (iosQ.data || [])) {
    const deviceToken = String(row.device_token || "").trim();
    if (!deviceToken || seenIos.has(deviceToken)) continue;
    seenIos.add(deviceToken);

    try {
      const res = await fetch("https://emasamir.app/.netlify/functions/send-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceToken,
          title: payload.title,
          body: payload.body,
          data: { url: payload.url, thread_id: threadId }
        })
      });

      const j = await res.json().catch(() => ({}));
      if (j?.success) iosSent++;
      else iosFailed++;
    } catch {
      iosFailed++;
    }
  }

  const androidQ = await supabase
    .from("chat_device_tokens")
    .select("id,customer_phone,device_token,platform,is_active,updated_at")
    .in("customer_phone", allAdminPhoneVariants)
    .eq("is_active", true)
    .eq("platform", "android")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (androidQ.error) throw androidQ.error;

  const seenAndroid = new Set();

  for (const row of (androidQ.data || [])) {
    const deviceToken = String(row.device_token || "").trim();
    if (!deviceToken || seenAndroid.has(deviceToken)) continue;
    seenAndroid.add(deviceToken);

    try {
      const res = await fetch("https://earnest-bombolone-4d2e8a.netlify.app/.netlify/functions/send-push-android", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceToken,
          platform: "fcm",
          token_type: "fcm",
          title: payload.title,
          body: payload.body,
          url: payload.url
        })
      });

      const j = await res.json().catch(() => ({}));
      if (j?.success) androidSent++;
      else androidFailed++;
    } catch {
      androidFailed++;
    }
  }

  return {
    web_sent: webSent,
    web_failed: webFailed,
    web_expired: webExpired,
    ios_sent: iosSent,
    ios_failed: iosFailed,
    android_sent: androidSent,
    android_failed: androidFailed
  };
} 

async function shouldNotifyAdminAiMode({ supabase, customerPhone, msg, fileUrl, fileMime, body }) {
  const t = String(msg || "").toLowerCase();

  if (fileUrl) return true;

  if (
    looksLikePaidProof(msg) ||
    t.includes("pending") ||
    t.includes("order") ||
    t.includes("admin") ||
    t.includes("tolong check") ||
    t.includes("semak") ||
    t.includes("bayaran") ||
    t.includes("dah bayar") ||
    t.includes("sudah bayar")
  ) {
    return true;
  }

  if (
    String(body?.action || "").toLowerCase() === "live_checkout_submit" ||
    isLiveLockRequest(body)
  ) {
    return true;
  }

  const variants = phoneVariantsText(customerPhone);

  if (variants.length) {
    const q = await supabase
      .from("j916_orders")
      .select("id")
      .in("phone", variants)
      .eq("status", "PENDING")
      .limit(1);

    if (!q.error && q.data && q.data.length) return true;
  }

  return false;
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
   (NEW) AI-DAN HELPERS
========================= */

function looksLikeAiDanQuery(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  // jangan kacau command lock
  if (t.includes("nak lock") || t.includes("lock live")) return false;

  // mesti ada sekurang2nya satu "signal"
  const hasBudget =
    /\brm\s*\d{2,6}\b/i.test(t) ||
    /\b(bajet|budget)\s*\d{2,6}\b/i.test(t);

  const hasCat =
    /\b(rt|rl|cc|lk|rk|bc|sb)\b/i.test(t) ||
    /\b(rantai tangan|rantai leher|loket|gelang|cincin)\b/i.test(t);

  const hasLength =
    /\b(panjang|size|saiz)\b/i.test(t) ||
    /\b\d{2}(?:\.\d)?\s*(cm)?\b/i.test(t); // contoh "19", "45", "19cm"

  const hasAsk =
    /\b(ada tak|ada x|ada\?|nak cari|cari|bajet|budget)\b/i.test(t);

  // elak trigger dari nombor semata2 (contoh "45" sahaja)
  const isOnlyNumber = /^\d{1,3}$/.test(t);

  if (isOnlyNumber) return false;

  // rule ringkas: ada "ask" + (budget/cat/length) ATAU memang ada budget terus
  if (hasBudget) return true;
  if (hasAsk && (hasCat || hasLength)) return true;

  return false;
}

async function callAiDanJ916(event, payload = {}) {
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
    const url = (baseUrl || fallback) + "/.netlify/functions/ai-dan-j916";

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return j;
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function isAiDanCommand(text) {
  const t = String(text || "").toLowerCase().trim();
  return (
    t === "ai-dan" ||
    t === "aidan" ||
    t === "ai dan" ||
    t === "nak ai-dan" ||
    t === "masuk ai-dan" ||
    t.includes("nak ai-dan") ||
    t.includes("masuk ai-dan") ||
    t.includes("aktifkan ai-dan")
  );
}

function isAiDanExit(text) {
  const t = String(text || "").toLowerCase().trim();
  return (
    t === "tutup ai-dan" ||
    t === "stop ai-dan" ||
    t === "keluar ai-dan" ||
    t === "exit ai-dan" ||
    t === "tutup aidan" ||
    t === "stop aidan" ||
    t === "cancel ai-dan" ||
    t.includes("tutup ai-dan") ||
    t.includes("stop ai-dan") ||
    t.includes("keluar ai-dan")
  );
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

  // ✅ penting: bila sedang LOCK flow, jangan bagi intent "ANY" kacau step-by-step flow
  // Dalam LOCK flow, hanya intent yang mode=LOCK sahaja dibenarkan match.
  if (inLockFlow) {
    if (mode !== "LOCK") return false;
  } else {
    // bukan lock flow: intent LOCK tak boleh match
    if (mode === "LOCK") return false;
  }

  // (optional) kalau kau masih guna NON_LOCK dalam DB
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

function canSendWA(opt = {}) {
  const allowed = ["QR", "TRANSFER", "ATOME", "TRANSFER_RECEIPT"];
  const method = String(opt?.allow_after_pay_method || "").toUpperCase().trim();
  return allowed.includes(method);
}

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

    console.log("DEBUG sendWA url:", url);
    console.log("DEBUG sendWA phone_number:", phone_number);
    console.log("DEBUG sendWA has_file:", !!(opt.file_url || ""));
    console.log("DEBUG sendWA message_len:", String(message || "").length);

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

    console.log("DEBUG sendWA response_status:", r.status);
    console.log("DEBUG sendWA response_json:", JSON.stringify(j));

    return r.ok && (j.ok === true || j.ok === "true" || j.data);
  } catch (e) {
    console.warn("DEBUG sendWA error:", e?.message || e);
    return false;
  }
}

async function sendWAControlled(event, phone_number, message, opt = {}) {
  const method = String(opt?.allow_after_pay_method || "").toUpperCase().trim();
  const allowed = canSendWA(opt);

  console.log("DEBUG sendWAControlled phone_number:", phone_number);
  console.log("DEBUG sendWAControlled method:", method || "(empty)");
  console.log("DEBUG sendWAControlled allowed:", allowed);

  if (!allowed) {
    console.log("DEBUG sendWAControlled BLOCKED");
    return false;
  }

  console.log("DEBUG sendWAControlled ALLOWED");
  return await sendWA(event, phone_number, message, opt);
}
/* =========================
   2) OCR TAG (optional) — LIVE STABIL
   - Extract: NAME + PRICE (RM) + SIZE + WEIGHT + WIDTH
========================= */

async function extractTagFromImage(imageUrl) {
  if (!imageUrl) return null;
  if (!process.env.OPENAI_API_KEY) return null;

  // --- helpers
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // normalize numeric strings like "0.64gm", "0,64", "O.64"
  const toNumberLoose = (v) => {
    if (v === null || v === undefined || v === "") return null;
    let s = String(v).trim();
    s = s.replace(/,/g, ".");         // 0,64 -> 0.64
    s = s.replace(/[oO]/g, "0");      // O.64 -> 0.64
    s = s.replace(/[^0-9.]+/g, "");   // keep digits/dot only
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  };

  const toIntLoose = (v) => {
    if (v === null || v === undefined || v === "") return null;
    let s = String(v).trim();
    s = s.replace(/[oO]/g, "0");
    s = s.replace(/,/g, "");
    s = s.replace(/[^0-9]+/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

// normalize code OCR supaya tak terlebih 0 / space / typo biasa
  const normalizeTagCode = (v) => {
    let c = String(v || "").toUpperCase().trim();
    if (!c) return null;

    // buang semua space
    c = c.replace(/\s+/g, "");

    // OCR biasa salah O jadi 0
    c = c.replace(/O/g, "0");

    // pastikan pattern prefix + nombor sahaja
    const m = c.match(/^(CC|RT|RL|LK|RK|BC|SB)(\d{4,12})$/i);
    if (!m) return c;

    const prefix = m[1].toUpperCase();
    let digits = m[2];

    // FIX paling biasa:
    // contoh OCR baca RT10000267, padahal RT1000267
    // jika selepas prefix ada 8 digit dan bermula dengan 10000,
    // buang satu 0 jadi 1000xxxx
    if (digits.length === 8 && digits.startsWith("10000")) {
      digits = "1000" + digits.slice(5);
    }

    return prefix + digits;
  };

  // try extract from any raw text (fallback if JSON fails / incomplete)
  const extractByRegex = (text) => {
    const t = String(text || "");
    const tUpper = t.toUpperCase();

    // ✅ CODE: CC/RT/RL/LK/RK/BC/SB + digit (contoh RT0019014)
    let code = null;
    let mc = tUpper.match(/\b(?:CC|RT|RL|LK|RK|BC|SB)\s*\d{4,12}\b/);
    if (mc && mc[0]) {
      code = normalizeTagCode(mc[0]);
    }

    // SIZE: S:17 OR :51 OR S 17
    let size = null;
    let m = t.match(/\bS\s*[:\-]?\s*([1-6][0-9](?:\.[0-9])?)\b/i);
    if (m && m[1]) size = String(toNumberLoose(m[1]) ?? "").trim() || null;
    if (!size) {
      m = t.match(/[:\s]([1-6][0-9](?:\.[0-9])?)\b/); // :51
      const v = toNumberLoose(m?.[1]);
      if (v !== null && v >= 10 && v <= 70) size = String(v);
    }

    // WEIGHT: W:0.64gm / W 0.64 g
    let weight_g = null;
    m = t.match(/\bW\s*[:\-]?\s*([0-9oO.,]+)\s*(?:g|gm)\b/i);
    if (m && m[1]) weight_g = toNumberLoose(m[1]);

    // WIDTH: L:0.2 / WIDTH 0.2
    let width_cm = null;
    m = t.match(/\bL\s*[:\-]?\s*([0-9oO.,]+)\b/i);
    if (m && m[1]) width_cm = toNumberLoose(m[1]);
    if (width_cm === null) {
      m = t.match(/\bWIDTH\s*[:\-]?\s*([0-9oO.,]+)\b/i);
      if (m && m[1]) width_cm = toNumberLoose(m[1]);
    }

    // PRICE: RM 527 / RM527
    let price_rm = null;
    m = t.match(/\bRM\s*([0-9oO,]{2,6})\b/i);
    if (m && m[1]) {
      const n = toIntLoose(m[1]);
      if (n !== null && n >= 10) price_rm = n;
    }

    // CALC DISPLAY ...
    if (price_rm === null) {
      const nums = [];
      const re = /\b([0-9oO]{3,4})\b/g;
      let mm;
      while ((mm = re.exec(t))) {
        const rawN = mm[1];
        const n = toIntLoose(rawN);
        if (!n) continue;
        if (n === 916) continue;
        if (n === 12) continue;
        if (n >= 100 && n <= 9999) nums.push(n);
      }
      if (nums.length) {
        const freq = new Map();
        for (const n of nums) freq.set(n, (freq.get(n) || 0) + 1);
        let best = nums[nums.length - 1];
        let bestC = 0;
        for (const [n, c] of freq.entries()) {
          if (c > bestC) { best = n; bestC = c; }
        }
        price_rm = best;
      }
    }

    return { code, size, weight_g, width_cm, price_rm };
  };

  // --- convert remote image to base64 data URL (stabil walaupun link private/expire)
  async function toDataUrlFromImageUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`image fetch failed: ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());

    // cuba detect content-type, fallback jpeg
    const ct = resp.headers.get("content-type") || "image/jpeg";
    const b64 = buf.toString("base64");
    return `data:${ct};base64,${b64}`;
  }

  let dataUrl = null;
  try {
    dataUrl = await toDataUrlFromImageUrl(imageUrl);
  } catch (e) {
    // fail softly
    return null;
  }

  // --- OpenAI call
  const payload = {
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Anda OCR untuk screenshot LIVE barang emas (tag Emas Amir).\n" +
          "FOKUS 2 kawasan sahaja:\n" +
          "A) Tag putih kecil yang ada teks seperti '916 EMAS AMIR', 'S:..', 'W:..gm', kadang 'L:..'.\n" +
          "B) Paparan nombor besar pada calculator/timbangan (contoh 520/400/600/527) sebagai HARGA.\n\n" +
          "Abaikan overlay TikTok (komen, sticker, watermark, viewer count, icon).\n\n" +
          "Cari jika ada:\n" +
          "1) size (S:17 atau kadang ':51' -> anggap size=51)\n" +
          "2) weight_g (W:0.64gm)\n" +
          "3) width_cm (L:0.2) jika ada\n" +
          "4) price_rm (integer) — ambil dari 'RMxxx' ATAU nombor besar pada calculator.\n" +
          "5) name (teks paling jelas pada tag, contoh '916 EMAS AMIR' / 'EMAS AMIR')\n\n" +
          "Balas SATU JSON sahaja, tanpa markdown/codeblock. Format:\n" +
          "{\"code\":\"RT0019014\",\"size\":\"17\",\"weight_g\":\"0.64\",\"width_cm\":\"0.2\",\"price_rm\":520,\"name\":\"916 EMAS AMIR\",\"raw\":\"RT0019014 / S:17 / L:0.2 / W:0.64gm\"}\n\n" +
          "Rules:\n" +
          "- code (jika nampak) format seperti RT0019014 / RL0004442 / SB1234.\n" +
          "- Jika S/W/L tak nampak, tetap pulangkan code jika jelas (jangan kosongkan).\n" +
          "- code string atau null.\n" +
          "- price_rm integer atau null.\n" +
          "- size/weight_g/width_cm string atau null.\n" +
          "- raw gabungkan apa yang jumpa (S/L/W + apa-apa clue harga)."
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Baca tag (S/W/L) dan harga (RM) dari paparan calculator jika ada." },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    temperature: 0
  };

  let txt = "";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const e = await r.text().catch(() => "");
      // fail softly
      return null;
    }

    const data = await r.json().catch(() => ({}));
    txt = norm(data?.choices?.[0]?.message?.content || "");
  } catch {
    return null;
  }

  // --- Parse JSON if possible
  let j = null;
  try {
    const cleaned = txt.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
    j = JSON.parse(cleaned);
  } catch {
    j = null;
  }

  // --- Build output (from JSON first)
  const out = {
    code: j?.code ? normalizeTagCode(j.code) : null,
    name: j?.name ? norm(j.name) : null,
    price_rm: (j?.price_rm !== null && j?.price_rm !== undefined && j?.price_rm !== "")
      ? toIntLoose(j.price_rm)
      : null,
    size: j?.size ? norm(j.size) : null,
    weight_g: (j?.weight_g !== null && j?.weight_g !== undefined && j?.weight_g !== "")
      ? toNumberLoose(j.weight_g)
      : null,
    width_cm: (j?.width_cm !== null && j?.width_cm !== undefined && j?.width_cm !== "")
      ? toNumberLoose(j.width_cm)
      : null,
    raw: j?.raw ? norm(j.raw) : (txt || null)
  };

  // --- Fallback regex (fills missing fields)
  const fb = extractByRegex(txt);

  if (!out.code && fb.code) out.code = fb.code;
  if (!out.size && fb.size) out.size = fb.size;
  if (out.weight_g === null && fb.weight_g !== null) out.weight_g = fb.weight_g;
  if (out.width_cm === null && fb.width_cm !== null) out.width_cm = fb.width_cm;
  if (out.price_rm === null && fb.price_rm !== null) out.price_rm = fb.price_rm;
if (out.code) out.code = normalizeTagCode(out.code);

  // fallback: build raw S/L/W nicely
  if (!out.raw) out.raw = txt || null;
  const rawParts = [];
  if (out.code) rawParts.push(`${out.code}`);
  if (out.size) rawParts.push(`S:${out.size}`);
  if (out.width_cm !== null) rawParts.push(`L:${out.width_cm}`);
  if (out.weight_g !== null) rawParts.push(`W:${out.weight_g}gm`);
  if (rawParts.length) out.raw = rawParts.join(" / ");

  // sanity checks
  if (out.size) {
    const sv = toNumberLoose(out.size);
    if (sv === null || sv < 10 || sv > 70) out.size = null;
  }
  if (out.weight_g !== null && (out.weight_g <= 0 || out.weight_g > 200)) out.weight_g = null;
  if (out.width_cm !== null && (out.width_cm <= 0 || out.width_cm > 50)) out.width_cm = null;
  if (out.price_rm !== null && (out.price_rm < 10 || out.price_rm > 500000)) out.price_rm = null;

  return out;
}
/* =========================
   3) LOCK ITEMS DB HELPERS
========================= */



async function getOpenLockItems(supabase, threadId) {
  const q = await supabase
    .from("chat_lock_items")
    .select("id,seq,price_rm,size_text,weight_g,tag_raw,attachment_url,wants_cut,cut_to_cm,current_length_cm,status")
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
  .select("id,code,design_id,weight_g,length_cm,status,is_active,active,j916_designs(name)")
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
    const nm = it?.j916_designs?.name ? ` — ${String(it.j916_designs.name).trim()}` : "";
    const w = (it.weight_g !== null && it.weight_g !== undefined) ? `${it.weight_g}g` : "";
    const l = (it.length_cm && Number(it.length_cm) > 0) ? ` / ${it.length_cm}cm` : "";
    const extra = (w || l) ? ` (${w}${l})` : "";
    return `${idx + 1}) ${it.code}${nm}${extra}`;
  }).join("\n");
}

/* =========================
   3A-EXTRA) J916 MATCH BY CODE
========================= */
async function findJ916ByCode(supabase, code) {
  if (!code) return null;
  const c = String(code).toUpperCase().replace(/\s+/g, "").trim();

  // ✅ jangan terlalu ketat pada active/is_active (kadang column/row tak konsisten)
  const q = await supabase
    .from("j916_items")
    .select("id,code,design_id,weight_g,length_cm,status,is_active,active,j916_designs(name,width_cm,cat_code,img1_url,img2_url,img3_url)")
    .eq("code", c)
    .limit(1)
    .maybeSingle();

  if (q.error) return null;
  const row = q.data || null;
  if (!row) return null;

  // ✅ kalau ada flag is_active/active, hormat—tapi jangan block kalau null
  if (row.is_active === false) return null;
  if (row.active === false) return null;

  if (!isJ916AvailableStatus(row.status)) return null;
  return row;
}

function isLiveLockRequest(body = {}) {
  if (String(body.action || "").toLowerCase() === "live_checkout_submit") return false;
  if (String(body.source || "").toLowerCase() === "live_checkout") return false;

  return (
    body.live_lock === true ||
    body.source === "comment_live" ||
    body.source === "live_comment" ||
    String(body.action || "").toLowerCase() === "live_lock"
  );
}
function cleanLiveCode(v) {
  return String(v || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

async function createLiveLockItemFromJ916(supabase, threadId, item, livePriceRm) {
  const mx = await supabase
    .from("chat_lock_items")
    .select("seq")
    .eq("thread_id", threadId)
    .order("seq", { ascending: false })
    .limit(1);

  if (mx.error) throw mx.error;

  const nextSeq = (mx.data && mx.data[0] ? Number(mx.data[0].seq || 0) : 0) + 1;

  const weight = item?.weight_g != null ? Number(item.weight_g) : null;
  const length = item?.length_cm != null ? Number(item.length_cm) : null;

  const price = Number(livePriceRm || 0);
  if (!isFinite(price) || price <= 0) {
    throw new Error("Harga live tidak sah.");
  }

  const tagRaw = [
    item?.code ? String(item.code).toUpperCase() : "",
    length ? `S:${length}` : "",
    weight ? `W:${weight}gm` : ""
  ].filter(Boolean).join(" / ");

  const ins = await supabase
    .from("chat_lock_items")
    .insert({
      thread_id: threadId,
      seq: nextSeq,
      j916_item_id: item.id,
      price_rm: price,
      size_text: length ? String(length) : null,
      weight_g: weight || null,
      tag_raw: tagRaw || null,
      current_length_cm: length || null,
      status: "OPEN"
    })
    .select("id,seq")
    .single();

  if (ins.error) throw ins.error;
  return ins.data;
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

const source = String(body.source || body.from || "").toLowerCase();
const statusRef = body.status_ref || null;
const isFromStatus = source === "status" || source === "app_status";

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

const threadMeta = th.data?.meta || {};
const adminMode = threadMeta.admin_mode === true;

// ✅ elak notifikasi admin duplicate
let adminAlreadyNotified = false;


// ✅ LOCK dianggap aktif kalau:
// 1) status thread memang LOCK_*
// 2) ATAU masih ada chat_lock_items yang OPEN (thread mungkin tersangkut OPEN tapi item lock masih ada)
let inLockFlow = threadStatus.startsWith("LOCK_");

if (!inLockFlow) {
  const qOpen = await supabase
    .from("chat_lock_items")
    .select("id")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .limit(1);

  if (!qOpen.error && qOpen.data && qOpen.data.length > 0) {
    inLockFlow = true;
  }
}



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
    tag_extracted: tagExtracted || null,

    source: isFromStatus ? "status" : (source || null),
    status_ref: isFromStatus ? statusRef : null
  }
});
    if (insMsg.error) throw insMsg.error;

    const nowIso = new Date().toISOString();

await supabase
  .from("chat_threads")
  .update({
    last_message_at: nowIso,
    last_customer_message_at: nowIso
  })
  .eq("id", threadId);
// 🔥 ADMIN MODE: simpan mesej customer, tapi AI jangan balas
// KECUALI:
// 1) order/live checkout
// 2) live lock
// 3) slip/resit/bukti bayaran gambar/PDF
// 4) ayat "dah bayar / slip / resit" supaya payflow tetap jalan
if (adminMode) {
  let adminNotify = null;

  try {
    adminNotify = await notifyAdminsCustomerChat({
      supabase,
      threadId,
      customerPhone: p.e164,
      message: msg || "(lampiran)",
      attachment: fileUrl ? { url: fileUrl, name: fileName, mime: fileMime } : null
    });

    adminAlreadyNotified = true;
  } catch (notifyErr) {
    console.error("notify admin customer chat error:", notifyErr);
  }

  const isLiveCheckoutSubmitNow =
    String(body.action || "").toLowerCase() === "live_checkout_submit";

  const isLiveLockNow = isLiveLockRequest(body);

  const isProofUploadNow =
    !!fileUrl &&
    (
      String(fileMime || "").toLowerCase().startsWith("image/") ||
      String(fileMime || "").toLowerCase() === "application/pdf"
    );

  const isPaidProofTextNow = looksLikePaidProof(msg);

  const allowPayflowInManual =
    isProofUploadNow ||
    isPaidProofTextNow;

  if (
    !isLiveCheckoutSubmitNow &&
    !isLiveLockNow &&
    !allowPayflowInManual
  ) {
    return json(200, {
      ok: true,
      thread_id: threadId,
      reply: "",
      action: "admin_mode_hold",
      meta: {
        admin_mode: true,
        no_ai_reply: true,
        admin_notify: adminNotify
      }
    });
  }
}

// 🔔 AI-DAN MODE: notify admin hanya jika chat penting / ada order / pending / bayaran
// Jika adminMode sudah notify di atas, jangan notify kali kedua.
try {
  const aiNeedNotifyAdmin = await shouldNotifyAdminAiMode({
    supabase,
    customerPhone: p.e164,
    msg,
    fileUrl,
    fileMime,
    body
  });

  if (aiNeedNotifyAdmin && !adminAlreadyNotified) {
    await notifyAdminsCustomerChat({
      supabase,
      threadId,
      customerPhone: p.e164,
      message: msg || "(lampiran / order masuk)",
      attachment: fileUrl ? { url: fileUrl, name: fileName, mime: fileMime } : null
    });

    adminAlreadyNotified = true;
  }
} catch (notifyErr) {
  console.error("notify admin ai-mode important chat error:", notifyErr);
}
 const tLower = String(msg || "").toLowerCase();


/* =========================================
   LIVE CHECKOUT SUBMIT — dari comment.html
   Bypass step-by-step, terus create order + detail bayaran
========================================= */

if (String(body.action || "").toLowerCase() === "live_checkout_submit") {
  if (!isLoggedIn) {
    return json(400, { ok:false, error:"Sila log masuk dulu." });
  }

  const code = cleanLiveCode(body.code || "");
  const livePrice = Number(body.price_rm || 0);
  const payMethod = String(body.pay_method || "TRANSFER").toUpperCase();
  const shipMode = String(body.ship || "POST").toUpperCase();
  const cutMode = String(body.cut || "NO").toUpperCase();

  if (!code) return json(400, { ok:false, error:"Code barang kosong." });
  if (!isFinite(livePrice) || livePrice <= 0) {
    return json(400, { ok:false, error:"Harga LIVE tidak sah." });
  }

  const item = await findJ916ByCode(supabase, code);
  if (!item) {
    return json(400, { ok:false, error:`Item ${code} tak jumpa dalam stok aktif.` });
  }

  await supabase
    .from("chat_lock_items")
    .update({ status:"CANCELLED" })
    .eq("thread_id", threadId)
    .eq("status", "OPEN");

  const created = await createLiveLockItemFromJ916(supabase, threadId, item, livePrice);

  if (cutMode === "YES") {
    await supabase
      .from("chat_lock_items")
      .update({
        wants_cut: true,
        current_length_cm: parseLengthCm(body.current_length_cm) || item.length_cm || null,
        cut_to_cm: parseLengthCm(body.cut_to_cm) || null
      })
      .eq("id", created.id);
  }

  const shipFee = shipMode === "POST" ? 10 : 0;

  const rules = await getPayRules(supabase).catch(() => ({
    postage_discount_rm: 0,
    cashback_percent: 0,
    cashback_round_mode: "FLOOR"
  }));

  const postageDiscount = shipMode === "POST"
    ? Math.max(0, Math.min(Number(rules.postage_discount_rm || 0), shipFee))
    : 0;

  const cashbackRaw = (livePrice * Number(rules.cashback_percent || 0)) / 100;
  const cashback = String(rules.cashback_round_mode || "FLOOR").toUpperCase() === "FLOOR"
    ? Math.floor(cashbackRaw)
    : floorRM(cashbackRaw);

  const finalCash = Math.max(0, livePrice + shipFee - postageDiscount - cashback);
  const finalAtome = Math.max(0, livePrice + shipFee - postageDiscount);

  const finalPay = payMethod === "ATOME" ? finalAtome : finalCash;
const cashbackUse = payMethod === "ATOME" ? 0 : cashback;

// TABUNG + TOPUP display sahaja untuk Ai-Dan
const tabungUnitsUsed = Number(body.tabung_units_used || 0);
const tabungValueRm = Number(body.tabung_value_rm || 0);
const topupRm = Number(body.topup_rm || 0);
const tabungRequestId = String(body.tabung_request_id || "").trim();

const isTabungTopup = payMethod === "TABUNG_TOPUP" && tabungValueRm > 0;

const customerPay = isTabungTopup
  ? Math.max(0, topupRm)
  : finalPay;

  const weight = Number(item.weight_g || 0);
  if (!weight) return json(400, { ok:false, error:"Berat item tidak sah." });

  const livePerG = livePrice / weight;

  const orderRes = await fetch(`${siteUrl}/.netlify/functions/j916-lock-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phone: p.e164.replace(/^60/, "0"),
      item_id: item.id,
      live_rm_per_g: livePerG,
      live_upah: 0,
      shipping_rm: shipFee,
      checkout_group: threadId,
      override_amount_rm: finalPay,
      discount_postage_rm: postageDiscount,
      cashback_rm: cashbackUse
    })
  });

  const orderJson = await orderRes.json().catch(() => ({}));
  if (!orderRes.ok || !orderJson.ok) {
    return json(500, { ok:false, error: orderJson.error || "Gagal create order." });
  }

  const orderCode =
    orderJson.order?.order_code ||
    orderJson.order?.id ||
    orderJson.order_code ||
    orderJson.order_id ||
    "";

  await supabase
    .from("chat_lock_items")
    .update({ status:"LOCKED" })
    .eq("id", created.id);

  const bankName = process.env.BANK_NAME || "";
  const bankAccName = process.env.BANK_ACC_NAME || "";
  const bankAccNo = process.env.BANK_ACC_NO || "";
  const bankQrUrl = process.env.BANK_QR_URL || "";

  const name = item?.j916_designs?.name ? String(item.j916_designs.name).trim() : code;

  const shipLine = shipMode === "POST"
    ? `• Caj pos: ${fmtRM(shipFee)} (Pos Semenanjung)\n`
    : `• Ambil kedai: ${body.pickup_when || "-"}\n`;

  const cutLine = cutMode === "YES"
    ? ` • POTONG → ${body.cut_to_cm}`
    : "";

  const reply =
    `Baik cik 😊✅ Pilihan: *${payMethod === "TRANSFER" ? "Bank Transfer" : payMethod}*\n\n` +
    `Order code: *${orderCode}*\n\n` +
    `Ringkasan bayaran:\n` +
    `• Item 1: ${fmtRM(livePrice)} (${code} / ${name} / W:${weight}gm)${cutLine}\n` +
    shipLine +
    `• Jumlah asal: *${fmtRM(livePrice + shipFee)}*\n` +
(postageDiscount ? `• Diskaun postage: *-${fmtRM(postageDiscount)}*\n` : ``) +
`• Cashback: *-${fmtRM(cashbackUse)}*\n` +
(
  isTabungTopup
    ? `• Tolak Tabung: *-${fmtRM(tabungValueRm)}* (${tabungUnitsUsed} unit)\n`
    : ``
) +
(
  isTabungTopup && tabungRequestId
    ? `• Request tabung: *${tabungRequestId}*\n`
    : ``
) +
`\n` +
`✅ Jumlah akhir perlu dibayar: *${fmtRM(customerPay)}*\n\n` +
    
    (payMethod === "ATOME"
      ? `Link Atome:\n${siteUrl}/qr-atome.html\n\n`
      : `Bank: ${bankName}\nNama Akaun: ${bankAccName}\nNo Akaun: ${bankAccNo}\n\nQR:\n${bankQrUrl}\n\n`
    ) +
    `Selepas pembayaran berjaya, mohon hantarkan bukti pembayaran ke WhatsApp kami untuk kami teruskan proses penghantaran ya 🙏`;

  await supabase
    .from("chat_threads")
    .update({
      status: "OPEN",
      meta: {
        ...(resetTransientMeta(th.data?.meta || {})),
        lock: false,
        step: "OPEN",
        live_checkout_done: true,
        last_pay_method: payMethod,
        last_order_code: orderCode,
        last_total_rm: finalPay,
        awaiting_transfer_receipt: payMethod === "TRANSFER"
      }
    })
    .eq("id", threadId);

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: {
      live_checkout_done: true,
      method: payMethod,
      orderCode,
      final_pay: customerPay,
order_full_amount: finalPay,
tabung_value_rm: tabungValueRm,
tabung_units_used: tabungUnitsUsed,
tabung_request_id: tabungRequestId
    }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
    allow_after_pay_method: payMethod
  });

  return json(200, {
    ok: true,
    thread_id: threadId,
    reply,
    action: "live_checkout_submit_done"
  });
}

/* =========================================
   (NEW) LIVE COMMENT LOCK → MASUK AI-DAN/CHAT
   - dari page comment/live
   - bypass checkout biasa
   - terus create lock item + masuk LOCK_WAIT_SHIP
========================================= */

if (isLiveLockRequest(body)) {
  if (!isLoggedIn) {
    const code = cleanLiveCode(body.code || body.item_code || body.live_code || "");

    const reply =
      `Sila log masuk dulu untuk lock barang LIVE ya 😊\n\n` +
      `Lepas log masuk, tekan semula butang Lock pada barang tersebut.`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: {
        require_login: true,
        live_lock: true,
        code: code || null
      }
    });

    return json(200, {
      ok: true,
      thread_id: threadId,
      reply,
      action: "live_lock_require_login"
    });
  }

  const code = cleanLiveCode(body.code || body.item_code || body.live_code || "");
  const livePrice = Number(body.price_rm || body.live_price_rm || body.price || 0);

  if (!code) {
    const reply =
      `Maaf cik 😊 Code barang LIVE tak diterima.\n` +
      `Sila tekan semula butang Lock pada barang yang cik nak.`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { live_lock_error: true, reason: "missing_code" }
    });

    return json(200, {
      ok: true,
      thread_id: threadId,
      reply,
      action: "live_lock_missing_code"
    });
  }

  const item = await findJ916ByCode(supabase, code);

  if (!item) {
    const reply =
      `Maaf cik 😔\n` +
      `Barang LIVE dengan code *${code}* tak jumpa dalam stok aktif sekarang.\n\n` +
      `Kemungkinan item ini sudah dibayar / sudah dilock orang lain / atau host baru tukar barang.\n` +
      `Cik boleh cuba lock item lain ya.`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: {
        live_lock: true,
        live_lock_error: true,
        reason: "item_not_found",
        code
      }
    });

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

    return json(200, {
      ok: true,
      thread_id: threadId,
      reply,
      action: "live_lock_item_not_found"
    });
  }

  if (!isFinite(livePrice) || livePrice <= 0) {
    const reply =
      `Maaf cik 😊 Harga LIVE untuk *${code}* tak diterima.\n` +
      `Sila tekan semula butang Lock pada barang tersebut ya.`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: {
        live_lock: true,
        live_lock_error: true,
        reason: "invalid_price",
        code
      }
    });

    return json(200, {
      ok: true,
      thread_id: threadId,
      reply,
      action: "live_lock_invalid_price"
    });
  }

  // reset item OPEN lama supaya lock dari live ni bersih
  await supabase
    .from("chat_lock_items")
    .update({ status: "CANCELLED" })
    .eq("thread_id", threadId)
    .eq("status", "OPEN");

  const metaClean = resetTransientMeta(th.data?.meta || {});
  const lockId = crypto.randomUUID();

  await createLiveLockItemFromJ916(supabase, threadId, item, livePrice);

  const name = item?.j916_designs?.name ? String(item.j916_designs.name).trim() : null;
  const weight = item?.weight_g != null ? Number(item.weight_g) : null;
  const length = item?.length_cm != null ? Number(item.length_cm) : null;
  const width = item?.j916_designs?.width_cm != null ? Number(item.j916_designs.width_cm) : null;

  const metaUpd = {
    ...metaClean,
    lock_id: lockId,
    live_lock: true,
    live_lock_source: "comment_live",
    j916_selected_code: code,
    j916_selected_from: "comment_live",
    j916_selected_at: new Date().toISOString(),
    j916_selected_length_cm: length || null,
    j916_selected_weight_g: weight || null,
    j916_selected_name: name || null,
    j916_selected_width_cm: width || null,
    lock_expected_items: 1,
    lock_received_items: 1,
    price_pending_seqs: null
  };

  await supabase
    .from("chat_threads")
    .update({
      status: "LOCK_WAIT_SHIP",
      meta: metaUpd
    })
    .eq("id", threadId);

  const reply =
    `Baik cik 😊 Kami dah terima lock dari LIVE dan terus rekodkan ✅\n\n` +
    `✅ Code: *${code}*\n` +
    (name ? `✅ Nama: *${name}*\n` : ``) +
    (weight ? `✅ Berat: *${weight}g*\n` : ``) +
    (length ? `✅ Panjang asal: *${length}cm*\n` : ``) +
    (width ? `✅ Lebar: *${width}cm*\n` : ``) +
    `✅ Harga LIVE: *${fmtRM(livePrice)}*\n\n` +
    `Cik nak ambil di kedai (walk-in) atau nak kami pos?`;

  const outMeta = {
    lock_sop: true,
    live_lock: true,
    step: "LOCK_WAIT_SHIP",
    clarify: true,
    quick_replies: [
      { label: "Ambil Kedai", send: "ambil kedai" },
      { label: "Pos", send: "pos" }
    ]
  };

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: outMeta
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

  if (admin) {
    await sendWAControlled(
      event,
      admin,
      `🟢 LIVE LOCK\nCustomer:${p.e164}\nThread:${threadId}\nCode:${code}\nHarga:${fmtRM(livePrice)}`
    );
  }

  return json(200, {
    ok: true,
    thread_id: threadId,
    reply,
    meta: outMeta,
    action: "live_lock_to_ship"
  });
}


/* =========================================
   (NEW) PAYFLOW EARLY ROUTE
   - "dah bayar"/slip/bukti bayar -> terus ke chat-payflow
   - juga jika upload file (image/pdf) semasa payflow
   - TAK ubah flow lain: kalau payflow taknak, dia return pass:true
========================================= */

const inPayFlow = String(threadStatus || "").toUpperCase().startsWith("PAY_");

const isProofFile =
  !!fileUrl &&
  (
    String(fileMime || "").toLowerCase().startsWith("image/") ||
    String(fileMime || "").toLowerCase() === "application/pdf"
  );

// ✅ Bila customer terus upload slip gambar/PDF,
// terus masuk payflow dan baca attachment itu.
// Jangan suruh customer upload sekali lagi.
const payflowShouldTry =
  isProofFile ||
  looksLikePaidProof(msg) ||
  inPayFlow;
if (payflowShouldTry && payflow) 
{
  // sokong 2 style export: function atau {handle}
  const fn = (typeof payflow === "function") ? payflow : (typeof payflow.handle === "function" ? payflow.handle : null);

  if (fn) {
    const pf = await fn({
      event,
      supabase,
      threadId,
      thread: th.data,            // ada status + meta
      phone: p.e164,
      msg,
      isLoggedIn,
      attachment: fileUrl ? { url: fileUrl, name: fileName, mime: fileMime } : null,
      siteUrl,
      admin
    });

    // ✅ payflow ambik alih
   if (pf && pf.pass !== true && pf.reply) {
  const reply = String(pf.reply || "").trim();
  const outMeta = { payflow: true, ...(pf.meta || {}) };

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: outMeta
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

  // ✅ notify admin (kalau ada)
  if (pf && pf.notify_admin_text && admin) {
    await sendWAControlled(event, admin, String(pf.notify_admin_text));
  }

  return json(200, {
    ok: true,
    thread_id: threadId,
    reply,
    meta: outMeta,
    action: pf.action || "payflow"
  });
}
  }
}

/* =========================================
   (NEW) GOLD999 EARLY ROUTE
   - chat-send hanya link sahaja
   - semua logic ada dalam chat-gold999.js
   - jalan untuk NON-LOCK sahaja
========================================= */
if (!inLockFlow && gold999 && typeof gold999.tryHandleGold999 === "function") {
 const g999 = await gold999.tryHandleGold999({
  supabase,
  threadId,
  text: msg,
  threadRow: th.data,
  isRealApp: body.is_real_app === true,
  appPlatform: body.app_platform || ""
});

  if (g999 && g999.reply) {
    const reply = String(g999.reply || "").trim();
    const outMeta = { gold999: true, ...(g999.meta || {}) };

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: outMeta
    });

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

    return json(200, {
      ok: true,
      thread_id: threadId,
      reply,
      meta: outMeta,
      action: g999.action || "gold999"
    });
  }
}
/* =========================================
   (NEW) AI-DAN MODE (manual command)
   - taip "ai-dan" untuk masuk mode
   - taip "tutup ai-dan" untuk keluar mode
   - mode hanya untuk NON-LOCK (chat biasa)
========================================= */

const metaNow0 = th.data?.meta || {};
const aiDanModeOn = (metaNow0.ai_dan_mode === true);

// keluar mode
if (!inLockFlow && isAiDanExit(msg) && aiDanModeOn) {
  const metaUpd = { ...resetTransientMeta(metaNow0), ai_dan_mode: false };

  await supabase
    .from("chat_threads")
    .update({ status: "OPEN", meta: metaUpd })
    .eq("id", threadId);

  const reply =
    `Baik cik 😊 AI-Dan saya tutup dulu ya.\n` +
    `Cik boleh terus tanya apa-apa macam biasa.`;

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: { ai_dan_mode: "OFF" }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
  return json(200, { ok: true, thread_id: threadId, reply, action: "ai_dan_mode_off" });
}

// masuk mode
if (!inLockFlow && isAiDanCommand(msg) && !aiDanModeOn) {
  const metaUpd = { ...resetTransientMeta(metaNow0), ai_dan_mode: true };

  await supabase
    .from("chat_threads")
    .update({ status: "OPEN", meta: metaUpd })
    .eq("id", threadId);

  const reply =
    `Baik cik 😊 Saya aktifkan AI-Dan.\n` +
    `Cik nak cari barang bajet berapa & kategori apa? Contoh:\n` +
    `• “Bajet RM500 nak RT panjang 19”\n` +
    `• “RL paling bajet panjang 45 ada tak?”\n\n` +
    `Untuk tutup AI-Dan, taip: “tutup ai-dan”.`;

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: { ai_dan_mode: "ON" }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
  return json(200, { ok: true, thread_id: threadId, reply, action: "ai_dan_mode_on" });
}

/* =========================================
   (FIX) QUICK CONFIRM: ADA LOCK / TIADA LOCK
   - Jangan trigger hanya sebab user balas "ya"
   - Hanya aktif bila BUKAN dalam lock flow & thread masih OPEN
========================================= */

// hanya jalan kalau memang belum masuk lock flow
const allowQuickConfirm = (!inLockFlow && threadStatus === "OPEN");

const saidYesLock =
  allowQuickConfirm && (
    tLower === "ada lock" ||
    tLower.includes("saya ada lock") ||
    tLower.includes("ada lock dalam live") ||
    tLower.includes("saya lock dalam live") ||
    tLower.includes("nak lock")
  );

const saidNoLock =
  allowQuickConfirm && (
    tLower === "tiada lock" ||
    tLower === "tak ada lock" ||
    tLower === "takde lock" ||
    tLower === "x ada lock"
  );

// ✅ Kalau user kata ADA LOCK → set status sahaja, biar flow LOCK_PREP_COUNT urus reply
if (saidYesLock) {
  const metaClean = resetTransientMeta(th.data?.meta || {});

  const metaUpd = {
    ...(metaClean || {}),
    lock_expected_items: null,
    lock_received_items: 0,
    price_pending_seqs: null
  };

  await supabase
    .from("chat_threads")
    .update({ status: "LOCK_PREP_COUNT", meta: metaUpd })
    .eq("id", threadId);

  // 🔥 Terus redirect ke state handler secara manual
  const reply =
    `Baik cik 😊\n` +
    `Sila teruskan chat di sini ya sehingga kami beri maklumat pembayaran.\n` +
    `Semua mesej dalam chat ini akan dihantar ke WhatsApp cik sebagai rujukan.\n\n` +
    `Cik ada berapa barang yang nak lock dari LIVE?\n\n` +
    `Balas nombor sahaja:\n` +
    `1 / 2 / 3 / 4`;

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: { lock_sop: true, step: "LOCK_PREP_COUNT", quick_confirm: "YES_LOCK" }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

  return json(200, { ok: true, thread_id: threadId, reply });
}

// ✅ Kalau user kata TIADA LOCK → kekal/open flow biasa
if (saidNoLock) {
  const metaClean = resetTransientMeta(th.data?.meta || {});

  await supabase
    .from("chat_lock_items")
    .update({ status: "CANCELLED" })
    .eq("thread_id", threadId)
    .eq("status", "OPEN");

  await supabase
    .from("chat_threads")
    .update({ status: "OPEN", meta: metaClean })
    .eq("id", threadId);

  const reply =
    `Baik cik 😊\n` +
    `Cik boleh terus tanya apa-apa ya.\n\n` +
    `Contoh:\n` +
    `• “916 berapa hari ini?”\n` +
    `• “nak ansuran Atome macam mana?”\n` +
    `• “999.9 gold coin custom?”\n` +
    `• “boleh semak tag?”`;

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: { quick_confirm: "NO_LOCK", open_flow: true }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
  return json(200, { ok: true, thread_id: threadId, reply, action: "open_quick_no_lock" });
}

/* =========================================
   (NEW) AI-DAN MODE: FORCE ROUTE
   - Bila ai_dan_mode ON (dan bukan LOCK), semua mesej cuba pergi AI-DAN dulu
   - Ini elak DB intent "curi" mesej ringkas macam "45 ada tk"
========================================= */

if (!inLockFlow && aiDanModeOn && !isAiDanCommand(msg) && !isAiDanExit(msg)) {
  const ai = await callAiDanJ916(event, {
    text: msg,
    phone: p.e164
  });

  if (ai && ai.ok && ai.reply) {
    const reply = String(ai.reply).trim();

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { ai_dan: true, ai_dan_mode: true }
    });

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
    return json(200, { ok: true, thread_id: threadId, reply, action: "ai_dan_mode_route" });
  }

  // kalau AI-Dan fail, jatuh ke intent DB / fallback (tak rosakkan flow)
}

/* ========================================= */
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

      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "intent_db" });
    }

    /* ========= 4) ROUTE INTENT ========= */
    const r = routeIntent({ msg, fileUrl, isLoggedIn, threadStatus });
console.log("DEBUG LOCK:", {
  threadStatus,
  inLockFlow,
  isSemakTag: r.isSemakTag,
  isLock: r.isLock
});
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

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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

// ✅ update lock item: simpan panjang asal + WAJIB simpan j916_item_id (uuid)
try {
  const seq = metaNow.j916_pick_for_lock_item_seq ? Number(metaNow.j916_pick_for_lock_item_seq) : null;
  if (seq) {
    const patch = {};

    // ✅ WAJIB: simpan uuid j916_items.id
    if (chosenRow?.id) {
      patch.j916_item_id = chosenRow.id;
    }

    // simpan panjang asal (optional)
    if (chosenLen && isFinite(chosenLen) && chosenLen > 0) {
      patch.current_length_cm = chosenLen;
    }

    // simpan berat (optional, untuk debug)
    if (chosenWeight && isFinite(chosenWeight) && chosenWeight > 0) {
      patch.weight_g = chosenWeight;
    }

    if (Object.keys(patch).length) {
      await supabase
        .from("chat_lock_items")
        .update(patch)
        .eq("thread_id", threadId)
        .eq("seq", seq)
        .eq("status", "OPEN");
    }
  }
} catch (_) { }

        if (pickedHasPrice) {
  await setLatestItemPrice(supabase, threadId, pickedPrice);

  // ✅ MULTI: kalau expected >=2, jangan terus masuk ship
  const metaNowAfterPick = th.data?.meta || {};
  const multiRes = await afterItemRecordedMulti({
    supabase,
    threadId,
    metaNow: metaNowAfterPick,
    siteUrl,
    event,
    phoneE164: p.e164,
    fileUrl,
    fileName
  });

  if (multiRes.handled) {
    return json(200, {
      ok: true,
      thread_id: threadId,
      reply: multiRes.reply,
      action: multiRes.action
    });
  }

  // ✅ SINGLE: baru tanya ship
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

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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

// ✅ PENTING: lepas tanya harga, masuk state tunggu harga
await supabase
  .from("chat_threads")
  .update({ status: "LOCK_WAIT_PRICE" })
  .eq("id", threadId);

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: { pick_j916_done: true, chosen_code: chosen, length_cm: chosenLen || null }
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
return json(200, { ok: true, thread_id: threadId, reply, action: "pick_j916_done" });
      }
    }

/* ========= 5) SEMAK TAG (tanpa lock) ========= */
// ⚠️ JANGAN trigger semak_tag kalau sedang LOCK flow
if (fileUrl && r.isSemakTag && !inLockFlow) {
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

      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
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

      await sendWAControlled(event, p.e164, waToCustomer, { file_url: fileUrl, file_name: fileName });
      if (admin) await sendWAControlled(event, admin, `🟡 LOCK REQUEST (perlu daftar)\nCustomer: ${p.e164}\nThread: ${threadId}`);

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
        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "info" });
      }

    
// ========= (NEW) AI-DAN: Bajet / Cari Barang (chat biasa) =========
      // jalan hanya bila:
      // - bukan lock flow
      // - bukan greeting/daily
      // - mesej nampak macam bajet/cari barang
      const metaNowNL = th.data?.meta || {};
const aiDanMode = (metaNowNL.ai_dan_mode === true);

if (!inLockFlow && !r.isGreeting && !r.isDaily && (aiDanMode || looksLikeAiDanQuery(msg))) {
        const ai = await callAiDanJ916(event, {
          text: msg,
          phone: p.e164,
          // optional: kalau nanti ada nama customer, boleh pass
          // name: customerName
        });

        if (ai && ai.ok && ai.reply) {
          const reply = String(ai.reply).trim();

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { ai_dan: true }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "ai_dan_j916" });
        }

        // kalau AI-Dan fail, jatuh ke fallback biasa (tak rosakkan flow)
      }
      // ========= (END) AI-DAN =========

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
      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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

      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
      if (admin) await sendWAControlled(event, admin, `🟠 LOCK START\nCustomer: ${p.e164}\nSTEP: LOCK_WAIT_TAG\nThread: ${threadId}`);

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

// ===== LOCK ID (simple) =====
const metaNow = th.data?.meta || {};
const isLockFlow = String(threadStatus || "").startsWith("LOCK_");

if (isLockFlow && !metaNow.lock_id) {
  const newLockId = crypto.randomUUID();
  const metaFix = { ...metaNow, lock_id: newLockId };

  await supabase.from("chat_threads").update({ meta: metaFix }).eq("id", threadId);

  // sync local supaya bawah2 terus pakai
  th.data.meta = metaFix;
}

   /* ========= LOCK_WAIT_TAG ========= */
if (threadStatus === "LOCK_WAIT_TAG" || threadStatus === "LOCK_COLLECT_TAGS") {
      if (!fileUrl) {
        const reply = await Tdb(supabase, "lock.wait_tag.remind");
        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_TAG" },
          lock_id: th.data?.meta?.lock_id || null
        });
        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
const codeTxt = tagExtracted?.code ? `${String(tagExtracted.code).toUpperCase().replace(/\s+/g, "")}` : null;
const s = tagExtracted?.size ? `S:${tagExtracted.size}` : null;
const wTxt = tagExtracted?.weight_g ? `W:${tagExtracted.weight_g}gm` : null;
const lTxt = tagExtracted?.width_cm ? `L:${tagExtracted.width_cm}cm` : null;

const tagLine = (
  raw ||
  [codeTxt, tagName, s, wTxt, lTxt, tagPrice].filter(Boolean).join(" / ") ||
  [codeTxt, s, wTxt, lTxt].filter(Boolean).join(" / ")
);

      // exact match J916
try {
  const codeTag = tagExtracted?.code ?? null;
  const w = tagExtracted?.weight_g ?? null;
  const sSize = tagExtracted?.size ?? null;

  let cands = [];

  // ✅ 1) MATCH BY CODE dulu (paling tepat)
  if (codeTag) {
    const oneByCode = await findJ916ByCode(supabase, codeTag);
    if (oneByCode) cands = [oneByCode];
  }

  // ✅ 2) fallback: weight+size (flow asal)
  if (!cands.length && w) {
    cands = await findJ916ExactCandidates(supabase, { weight_g: w, size: sSize }, 5);
  }

  if (!cands || cands.length === 0) {
    try {
      await supabase
        .from("chat_lock_items")
        .update({ status: "CANCELLED" })
        .eq("thread_id", threadId)
        .eq("seq", created.seq)
        .eq("status", "OPEN");
    } catch (_) { }

   const hasCode = !!(tagExtracted?.code);
    const hasS = !!(tagExtracted?.size);
    const hasW = !!(tagExtracted?.weight_g);
    const hasGoodTag = hasS && hasW;

    const reply =
      // ✅ PRIORITY: kalau CODE ada tapi tak jumpa dalam stok → bagitahu terus ikut CODE
      (hasCode)
        ? (
          `Maaf cik 😔\n` +
          `Saya nampak *CODE* pada tag: *${String(tagExtracted.code).toUpperCase().replace(/\s+/g, "")}*\n` +
          (tagLine ? `Tag dikesan: *${tagLine}*\n\n` : `\n`) +
          `Tapi saya *tak jumpa* code ni dalam stok aktif sekarang.\n` +
          `Kemungkinan item tu *dah dibayar (PAID) / dah dijual / atau data belum masuk*.\n\n` +
          `✅ Cara paling cepat:\n` +
          `1) Cik boleh LOCK item lain dulu, atau\n` +
          `2) Minta host/staf *scan tag semula* (pastikan code jelas), dan hantar screenshot lagi.\n\n` +
          `Kalau cik rasa code ni memang ada, staf kami akan semak manual ya 🙏`
        )
        : (!hasS && hasW)
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
              `✅ Data stok untuk tag ni *tak jumpa*.\n` +
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

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
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
      (tagName ? `🏷️ Nama dikesan: *${tagName}*\n` : ``) +
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
            code: tagExtracted?.code || null,
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
          code: tagExtracted?.code || null,
          name: tagName || null,
          tagLine: tagLine || null,
          price_rm: tagPriceOk ? Number(tagPriceNum) : null,
          weight_g: (tagExtracted?.weight_g ?? null),
          size: (tagExtracted?.size ?? null)
        }
      }
    });

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
      file_url: fileUrl,
      file_name: fileName
    });

    return json(200, { ok: true, thread_id: threadId, reply, action: "pick_j916_candidate" });
  }

  // cands.length === 1 (code match / exact match)
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
          j916_selected_from: (codeTag ? "code_match" : "exact_match"),
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

    // ✅ update lock item: simpan uuid j916_items.id + panjang asal
    try {
      const seq = created?.seq ? Number(created.seq) : null;
      if (seq) {
        const patch = {};
        if (chosenRow?.id) patch.j916_item_id = chosenRow.id;
        if (chosenLen && isFinite(chosenLen) && chosenLen > 0) patch.current_length_cm = chosenLen;
        if (chosenWeight && isFinite(chosenWeight) && chosenWeight > 0) patch.weight_g = chosenWeight;

        if (Object.keys(patch).length) {
          await supabase
            .from("chat_lock_items")
            .update(patch)
            .eq("thread_id", threadId)
            .eq("seq", seq)
            .eq("status", "OPEN");
        }
      }
    } catch (_) { }



           if (tagPriceOk) {
  await setLatestItemPrice(supabase, threadId, tagPriceNum);

  // ✅ MULTI: collect dulu sampai cukup
  const metaNowAfterExactOne = th.data?.meta || {};
  const multiRes = await afterItemRecordedMulti({
    supabase,
    threadId,
    metaNow: metaNowAfterExactOne,
    siteUrl,
    event,
    phoneE164: p.e164,
    fileUrl,
    fileName
  });

  if (multiRes.handled) {
    return json(200, {
      ok: true,
      thread_id: threadId,
      reply: multiRes.reply,
      action: multiRes.action
    });
  }

  // ✅ SINGLE: baru tanya ship
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

 const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_SHIP",
  clarify: true,
  quick_replies: [
    { label: "Ambil Kedai", send: "ambil kedai" },
    { label: "Pos", send: "pos" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
  file_url: fileUrl,
  file_name: fileName
});

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta,                 // ✅ PENTING: bagi chat.html render button
  action: "lock_exact_one_price_to_ship"
});
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

            await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
              file_url: fileUrl,
              file_name: fileName
            });

            return json(200, { ok: true, thread_id: threadId, reply, action: "lock_exact_one_ask_price" });
          }
      } catch (e) {
        console.warn("findJ916ExactCandidates error:", e?.message || e);
      }

      // CASE A: OCR jumpa harga
     if (tagPriceOk) {
  await setLatestItemPrice(supabase, threadId, tagPriceNum);

  // ✅ MULTI: collect dulu sampai cukup
  const metaNowAfterOcrPrice = th.data?.meta || {};
  const multiRes = await afterItemRecordedMulti({
    supabase,
    threadId,
    metaNow: metaNowAfterOcrPrice,
    siteUrl,
    event,
    phoneE164: p.e164,
    fileUrl,
    fileName
  });

  if (multiRes.handled) {
    return json(200, {
      ok: true,
      thread_id: threadId,
      reply: multiRes.reply,
      action: multiRes.action
    });
  }

  // ✅ SINGLE: baru tanya ship
  const reply = await Tdb(supabase, "lock.tag_received.price_detected.ask_ship", {
    tagLine,
    price: fmtRM(tagPriceNum),
    name: tagName || ""
  });

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

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
    file_url: fileUrl,
    file_name: fileName
  });

  return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
}

      // CASE B: tiada harga → (multi: collect dulu) / (single: tanya harga)
      const metaNow0 = th.data?.meta || {};
      const expected = Number(metaNow0.lock_expected_items || 0);
      const receivedBefore = Number(metaNow0.lock_received_items || 0);

      // MULTI MODE: jika expected >= 2, kita collect gambar sampai cukup dulu
      if (expected >= 2) {
        const received = receivedBefore + 1;

        const metaUpd = {
          ...(metaNow0 || {}),
          lock_received_items: received
        };

        // Kalau belum cukup, minta gambar seterusnya
        if (received < expected) {
          const replyCollect =
            `Terima kasih cik 😊 Saya dah rekod *barang #${received}*.\n\n` +
            `Sekarang sila hantar *gambar tag barang #${received + 1}* pula ya.\n` +
            `📌 (1 gambar untuk 1 barang – supaya saya boleh baca code/berat/panjang/harga)`;

          await supabase
  .from("chat_threads")
  .update({ status: "LOCK_COLLECT_TAGS", meta: metaUpd })
  .eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: replyCollect,
            meta: { lock_sop: true, step: "LOCK_COLLECT_TAGS", expected, received, item_seq: created.seq }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyCollect}\n\nChat: ${siteUrl}/chat`, {
            file_url: fileUrl,
            file_name: fileName
          });

          return json(200, { ok: true, thread_id: threadId, reply: replyCollect, action: "lock_collect_next" });
        }

        // Dah cukup collect -> check item mana yang tiada harga
        const pending = await getPendingPriceSeqs(supabase, threadId);

        // Kalau ada pending price -> start queue harga ikut item_seq
        if (pending.length) {
          const firstSeq = Number(pending[0]);

          const replyAsk =
            `Baik cik 😊 Semua tag dah saya terima & rekod.\n\n` +
            `Kalau cik ingat, harga masa LIVE untuk *barang #${firstSeq}* berapa ya?\n` +
            `Kalau tak ingat, cik boleh balas “lupa harga barang ${firstSeq}”.`;

          const metaClean2 = resetTransientMeta(metaUpd || {});
          const metaFinal = { ...(metaClean2 || {}), price_pending_seqs: pending };

          await supabase
            .from("chat_threads")
            .update({ status: "LOCK_WAIT_PRICE", meta: metaFinal })
            .eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: replyAsk,
            meta: { lock_sop: true, step: "LOCK_WAIT_PRICE", price_pending_seqs: pending }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyAsk}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply: replyAsk, action: "lock_price_queue_start" });
        }

        // Kalau semua item memang ada harga (rare), terus ke SHIP guna template sedia ada
        const replyShip = await Tdb(supabase, "lock.price.ok.ask_ship", { price: "" });

        const metaClean3 = resetTransientMeta(metaUpd || {});
        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_WAIT_SHIP", meta: metaClean3 })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: replyShip,
          meta: { lock_sop: true, step: "LOCK_WAIT_SHIP" }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyShip}\n\nChat: ${siteUrl}/chat`, {
          file_url: fileUrl,
          file_name: fileName
        });

        return json(200, { ok: true, thread_id: threadId, reply: replyShip, action: "lock_step" });
      }

      // SINGLE MODE (asal): tanya harga terus
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

      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
        file_url: fileUrl,
        file_name: fileName
      });

      return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
}

/* ========= LOCK_PREP_COUNT ========= */
    if (threadStatus === "LOCK_PREP_COUNT") {
      const metaNow = th.data?.meta || {};
      const n = parseLockCount(msg);

      if (!n) {
  const reply =
    `Baik cik 😊\n` +
    `Sila teruskan chat di sini ya sehingga kami beri maklumat pembayaran.\n` +
    `Semua mesej dalam chat ini akan dihantar ke WhatsApp cik sebagai rujukan, jadi tak perlu risau 😊\n\n` +
    `Cik ada berapa barang yang nak lock dari LIVE?\n\n` +
    `Balas nombor sahaja:\n` +
    `1 / 2 / 3 / 4`;

  const metaOut = {
    lock_sop: true,
    step: "LOCK_PREP_COUNT",
    quick_confirm: "YES_LOCK",
    quick_replies: [
      { label: "1", send: "1" },
      { label: "2", send: "2" },
      { label: "3", send: "3" },
      { label: "4", send: "4" }
    ]
  };

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: metaOut
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

  // ✅ penting: pulangkan meta supaya UI confirm dapat quick_replies (bukan harap regex teks)
  return json(200, {
    ok: true,
    thread_id: threadId,
    reply,
    meta: metaOut,
    action: "lock_prep_count_invalid"
  });
}

      // 1 barang -> terus minta gambar tag (flow asal)
      if (n === 1) {
        const reply =
          `Terima kasih cik 😊\n` +
          `Sila hantar *1 gambar/screenshot tag* barang tu ya (nampak *BERAT & SIZE/panjang*).\n` +
          `Kalau dalam gambar ada *harga*, lagi bagus. Kalau tak ada pun tak apa.`;

        const metaUpd = {
          ...(metaNow || {}),
          lock_expected_items: 1,
          lock_received_items: 0,
          price_pending_seqs: null
        };

        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_WAIT_TAG", meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_TAG", expected: 1 }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_ask_tag_one" });
      }

      // 2 / 3 barang -> collect mode
      if (n === 2 || n === 3) {
        const reply =
          `Terima kasih cik 😊\n` +
          `Sila hantar *gambar tag satu per satu* ya (1 gambar untuk 1 barang).\n\n` +
          `✅ Mula dengan *Gambar barang #1* dahulu.`;

        const metaUpd = {
          ...(metaNow || {}),
          lock_expected_items: n,
          lock_received_items: 0,
          price_pending_seqs: null
        };

        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_COLLECT_TAGS", meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_COLLECT_TAGS", expected: n }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_collect_start" });
      }

      // 4 -> lock 1 dulu (lebih kemas)
      if (n === 4) {
        const reply =
          `Baik cik 😊 Tak apa.\n` +
          `Kita *lock 1 barang dulu* supaya urusan ni bergerak dulu.\n\n` +
          `Sila hantar *gambar tag barang pertama* (nampak *BERAT & SIZE/panjang*).\n\n` +
          `✅ Lepas saya bagi detail bayaran untuk barang ni, cik boleh tambah barang lain dan kita sambung lock seterusnya.`;

        const metaUpd = {
          ...(metaNow || {}),
          lock_expected_items: 1,
          lock_received_items: 0,
          price_pending_seqs: null
        };

        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_WAIT_TAG", meta: metaUpd })
          .eq("id", threadId);

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_TAG", expected: 1, allow_more_later: true }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_ask_tag_one_allow_more" });
      }
    }  
  /* ========= LOCK_COLLECT_TAGS ========= */
    if (threadStatus === "LOCK_COLLECT_TAGS") {
      const metaNow = th.data?.meta || {};
      const expected = Number(metaNow.lock_expected_items || 0);

      // kalau user belum hantar gambar, remind
      if (!fileUrl) {
        const received = Number(metaNow.lock_received_items || 0);

        const reply =
          `Baik cik 😊\n` +
          `Sekarang saya tunggu *gambar tag barang #${Math.max(1, received + 1)}* ya.\n` +
          `📌 (1 gambar untuk 1 barang)`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_COLLECT_TAGS", expected, received, need_image: true }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_collect_need_image" });
      }

      // bila gambar masuk, flow baca tag yang sedia ada akan jalan (OCR / exact match / create item)
      // jadi di sini kita tak buat apa, sebab PATCH A yang akan urus "lepas create item" untuk collect next / ask price queue
    }


    /* ========= LOCK_WAIT_PRICE ========= */
    if (threadStatus === "LOCK_WAIT_PRICE") {
      const metaNow = th.data?.meta || {};
      const pending = Array.isArray(metaNow.price_pending_seqs) ? metaNow.price_pending_seqs : null;

      // MULTI PRICE QUEUE MODE
      if (pending && pending.length) {
        const currentSeq = Number(pending[0]);

        if (r.forgotPrice) {
          await setItemPriceBySeq(supabase, threadId, currentSeq, null);

          const rest = pending.slice(1);

          if (rest.length) {
            const replyNext =
              `Baik cik 😊\n` +
              `Saya rekod *barang #${currentSeq}* sebagai “lupa harga”.\n\n` +
              `Sekarang harga masa LIVE untuk *barang #${rest[0]}* berapa ya?\n` +
              `Kalau tak ingat, balas “lupa harga barang ${rest[0]}”.`;

            const metaUpd = { ...(metaNow || {}), price_pending_seqs: rest };

            await supabase
              .from("chat_threads")
              .update({ meta: metaUpd })
              .eq("id", threadId);

            await supabase.from("chat_messages").insert({
              thread_id: threadId,
              role: "ai",
              text: replyNext,
              meta: { lock_sop: true, step: "LOCK_WAIT_PRICE", price_pending_seqs: rest, forgot_seq: currentSeq }
            });

            await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyNext}\n\nChat: ${siteUrl}/chat`);
            return json(200, { ok: true, thread_id: threadId, reply: replyNext, action: "lock_price_queue_next" });
          }

          const replyShip = await Tdb(supabase, "lock.price.forgot.ask_ship");

          const metaClean = resetTransientMeta(metaNow || {});
          await supabase.from("chat_threads").update({ status: "LOCK_WAIT_SHIP", meta: metaClean }).eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: replyShip,
            meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", price_rm: null }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyShip}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply: replyShip, action: "lock_step" });
        }

        const price = parsePriceRM(msg);
        if (price) {
          await setItemPriceBySeq(supabase, threadId, currentSeq, Number(price));

          const rest = pending.slice(1);

          if (rest.length) {
            const replyNext =
              `Baik cik 😊✅ Harga barang #${currentSeq}: *${fmtRM(price)}*\n\n` +
              `Sekarang harga masa LIVE untuk *barang #${rest[0]}* berapa ya?\n` +
              `Kalau tak ingat, balas “lupa harga barang ${rest[0]}”.`;

            const metaUpd = { ...(metaNow || {}), price_pending_seqs: rest };

            await supabase
              .from("chat_threads")
              .update({ meta: metaUpd })
              .eq("id", threadId);

            await supabase.from("chat_messages").insert({
              thread_id: threadId,
              role: "ai",
              text: replyNext,
              meta: { lock_sop: true, step: "LOCK_WAIT_PRICE", price_pending_seqs: rest, price_seq: currentSeq, price_rm: Number(price) }
            });

            await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyNext}\n\nChat: ${siteUrl}/chat`);
            return json(200, { ok: true, thread_id: threadId, reply: replyNext, action: "lock_price_queue_next" });
          }

          const replyShip = await Tdb(supabase, "lock.price.ok.ask_ship", { price: fmtRM(price) });

          const metaClean = resetTransientMeta(metaNow || {});
          await supabase.from("chat_threads").update({ status: "LOCK_WAIT_SHIP", meta: metaClean }).eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: replyShip,
            meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", price_rm: Number(price) }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyShip}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply: replyShip, action: "lock_step" });
        }

        const replyBad =
          `Maaf cik 😊 Harga untuk *barang #${currentSeq}* berapa ya?\n` +
          `Contoh: 550 / RM550\n` +
          `Kalau tak ingat, balas “lupa harga barang ${currentSeq}”.`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: replyBad,
          meta: { lock_sop: true, step: "LOCK_WAIT_PRICE", invalid: true, price_seq: currentSeq }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${replyBad}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply: replyBad, action: "lock_step" });
      }

      // SINGLE MODE (asal)
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

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "lock_step" });
      }

      const reply2 = await Tdb(supabase, "lock.wait_price.remind");
      await supabase.from("chat_messages").insert({
        thread_id: threadId,
        role: "ai",
        text: reply2,
        meta: { lock_sop: true, step: "LOCK_WAIT_PRICE" }
      });
      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply2}\n\nChat: ${siteUrl}/chat`);
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
      const metaNow = th.data?.meta || {};
      const low = String(msg || "").toLowerCase().trim();

      /* =====================================================
         0) PRIORITY: SAMBUNG STEP YANG SEDANG MENUNGGU
         - ini WAJIB duduk paling atas supaya "YA/TUKAR/alamat/masa"
           tak jatuh ke branch clarify pickup/pos.
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

       const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_CUT_ITEM",
  ship_mode: "POST",
  quick_replies: [
    { label: "Potong", send: "POTONG" },
    { label: "Tak Potong", send: "TAK POTONG" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta,   // ✅ WAJIB supaya chat.html dapat render button
  action: "addr_yes_to_cut"
});
      }

      // B) Address confirm (ALAMAT BETUL / ALAMAT SALAH) atau input alamat baru
      if (metaNow.awaiting_addr_confirm) {

        const isBetul =
          low === "alamat betul" ||
          low.includes("alamat betul") ||
          low === "betul" ||
          low.includes("betul");

        const isSalah =
          low === "alamat salah" ||
          low.includes("alamat salah") ||
          low === "salah" ||
          low.includes("salah") ||
          low.includes("tukar alamat") ||
          low.includes("ubah alamat") ||
          low.includes("alamat baru");

        // B1) Jika customer kata SALAH / TUKAR → minta alamat baru
        if (isSalah) {
          const reply =
            `Baik cik 😊\n` +
            `Sila taip *alamat baru penuh* ya (Alamat + Poskod + Bandar + Negeri).`;

          // ⚠️ Jangan guna setStepMeta sini (kekalkan awaiting flow)
          const metaUpd = {
            ...(metaNow || {}),
            ship_mode: "POST",
            awaiting_addr_confirm: true,
            addr_need_new: true,

            // reset pickup flag (kalau ada)
            awaiting_pickup_when: false,
            pickup_when_text: null,

            // clear alamat lama supaya jelas
            addr_text: null
          };

          await supabase
            .from("chat_threads")
            .update({ meta: metaUpd })
            .eq("id", threadId);

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "POST", addr_need_new: true }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "addr_ask_new" });
        }

        // B2) Jika sedang tunggu alamat baru (addr_need_new = true)
if (metaNow.addr_need_new) {

  // ✅ jangan treat command sebagai alamat
  if (isBetul) {
    const reply =
      `Cik belum bagi alamat baru lagi 😊\n` +
      `Sila taip *alamat baru penuh* (Alamat + Poskod + Bandar + Negeri).`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "POST", addr_need_new: true }
    });

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
    return json(200, { ok: true, thread_id: threadId, reply, action: "addr_need_new_but_user_said_betul" });
  }

  if (isSalah) {
    const reply =
      `Baik cik 😊\n` +
      `Sila taip *alamat baru penuh* ya (Alamat + Poskod + Bandar + Negeri).`;

    // kekalkan addr_need_new = true
    const metaUpd = {
      ...(metaNow || {}),
      ship_mode: "POST",
      awaiting_addr_confirm: true,
      addr_need_new: true,
      awaiting_pickup_when: false,
      pickup_when_text: null,
      addr_text: null
    };

    await supabase
      .from("chat_threads")
      .update({ meta: metaUpd })
      .eq("id", threadId);

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "POST", addr_need_new: true }
    });

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
    return json(200, { ok: true, thread_id: threadId, reply, action: "addr_ask_new_again" });
  }

  // ✅ kalau bukan command, barulah treat sebagai alamat
  const newAddr = String(msg || "").trim();

  if (newAddr.length < 12) {
    const reply =
      `Alamat nampak terlalu pendek 😅\n` +
      `Sila taip alamat penuh (Alamat + Poskod + Bandar + Negeri).`;

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "POST", addr_need_new: true, invalid_addr: true }
    });

    await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
    return json(200, { ok: true, thread_id: threadId, reply, action: "addr_too_short" });
  }

  const zone = detectMYZoneFromStateOrAddress("", newAddr);
  const fee = calcShipFee(p.country, zone);
  const label = shipLabel(p.country, zone);

  const reply =
    `Baik cik 😊 Saya rekod alamat baru:\n` +
    `${newAddr}\n\n` +
    `📦 Caj pos (anggaran): *${fmtRM(fee)}* (${label})\n\n` +
    `Alamat ni betul?\n` +
    `✅ Balas “ALAMAT BETUL” untuk teruskan.\n` +
    `✍️ Balas “ALAMAT SALAH” untuk taip balik alamat.`;

  // ✅ lepas simpan alamat baru, balik ke mode confirm
  const metaUpd = setStepMeta(metaNow, {
    ship_mode: "POST",
    addr_text: newAddr,
    ship_fee_rm: fee,
    ship_label: label,
    ship_zone: zone,
    addr_need_new: false,
    awaiting_addr_confirm: true
  });

  // ✅ WAJIB update thread meta (ini punca utama bug)
  await supabase
    .from("chat_threads")
    .update({ meta: metaUpd })
    .eq("id", threadId);

  const outMeta = {
    lock_sop: true,
    step: "LOCK_WAIT_SHIP",
    ship_mode: "POST",
    awaiting_addr_confirm: true,
    ship_fee_rm: fee,
    quick_replies: [
      { label: "Alamat Betul", send: "ALAMAT BETUL" },
      { label: "Tukar Alamat", send: "ALAMAT SALAH" }
    ]
  };

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: outMeta
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

  return json(200, {
    ok: true,
    thread_id: threadId,
    reply,
    meta: outMeta,
    action: "addr_new_confirm"
  });
}
        

        // B3) Jika customer kata BETUL → terus ke CUT
        if (isBetul) {
          const metaUpd = setStepMeta(metaNow, {
            awaiting_addr_confirm: false,
            addr_need_new: false
          });

          await supabase
            .from("chat_threads")
            .update({ status: "LOCK_WAIT_CUT_ITEM", meta: metaUpd })
            .eq("id", threadId);

          const reply =
            `Baik cik 😊✅ Alamat disahkan.\n\n` +
            `Cik nak *potong* (ubah panjang) untuk item ni?\n` +
            `Balas: *POTONG* atau *TAK POTONG*.\n` +
            `Kalau item lebih dari 1, boleh tulis: “POTONG item 2 sahaja”.`;

         const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_CUT_ITEM",
  ship_mode: "POST",
  quick_replies: [
    { label: "Potong", send: "POTONG" },
    { label: "Tak Potong", send: "TAK POTONG" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta,   // ✅ WAJIB supaya chat.html dapat render button
  action: "addr_yes_to_cut"
});
        }

        // B4) Jawapan tak jelas
        const reply =
          `Maaf cik 😊\n` +
          `✅ Balas “ALAMAT BETUL” untuk teruskan.\n` +
          `✍️ Balas “ALAMAT SALAH” untuk taip balik alamat.`;

        const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_SHIP",
  ship_mode: "POST",
  awaiting_addr_confirm: true,
  ship_fee_rm: fee,
  quick_replies: [
    { label: "Alamat Betul", send: "ALAMAT BETUL" },
    { label: "Tukar Alamat", send: "ALAMAT SALAH" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta,            // ✅ penting untuk chat.html render quick replies
  action: "addr_new_confirm"
});
      }

      /* =====================================================
         1) BARU: DETECT PICKUP / POST (bila tak ada awaiting step)
      ====================================================== */

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

      // Jika user jawab "masa" tapi belum pilih pickup/pos → anggap pickup
      if (!wantPickup && !wantPost) {
        const looksLikeTime =
  low.includes("hari") ||
  low.includes("malam") ||
  low.includes("pagi") ||
  low.includes("petang") ||
  low.includes("esok") ||
  low.includes("lusa") ||
  /\b\d{1,2}:\d{2}\b/.test(low) ||        // 3:30
  /\b\d{1,2}\s*(am|pm)\b/.test(low);      // 3pm

        if (looksLikeTime) {
          const reply =
            `Baik cik 😊\n` +
            `Cik nak *ambil di kedai* ya? Kalau ya, cik boleh bagitahu masa (contoh: “esok petang 3pm”).\n\n` +
            `Kalau cik nak *pos*, balas “pos” ya.`;

          const metaUpd = setStepMeta(metaNow, {
            ship_mode: "PICKUP",
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
            meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "PICKUP", awaiting_pickup_when: true }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "ship_clarify_time_as_pickup" });
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

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "ship_clarify_pickup_or_post" });
      }

      // PICKUP
      if (wantPickup) {
        const metaUpd = setStepMeta(metaNow, {
  ship_mode: "PICKUP",
  awaiting_pickup_when: true,
  pickup_when_text: null,

  // 🔥 FIX RM10 MASUK
  ship_fee_rm: 0,
  ship_label: null,
  ship_zone: null,
  addr_text: null,
  awaiting_addr_confirm: false,
  addr_need_new: false
});

        await supabase
          .from("chat_threads")
          .update({ meta: metaUpd })
          .eq("id", threadId);

        const reply =
          `Baik cik 😊\n` +
          `✅ Pilihan: *Ambil di kedai*\n\n` +
          `Cik nak datang bila ya?\n` +
          `Contoh balas: “hari ni”, “esok”,.`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_SHIP", ship_mode: "PICKUP", awaiting_pickup_when: true }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        if (admin) await sendWAControlled(event, admin, `🟢 LOCK SHIP MODE\nPICKUP\nCustomer:${p.e164}\nThread:${threadId}`);

        return json(200, { ok: true, thread_id: threadId, reply, action: "ship_pickup_ask_when" });
      }

      // POST
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
            addr_need_new: true,
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

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
`✅ Balas “ALAMAT BETUL” untuk teruskan.\n` +
`✍️ Balas “ALAMAT SALAH” untuk bagi alamat baru.`;

        const metaUpd = setStepMeta(metaNow, {
          ship_mode: "POST",
          addr_text: addr,
          ship_fee_rm: fee,
          ship_label: label,
          ship_zone: zone,
          awaiting_addr_confirm: true,
          addr_need_new: false
        });

        await supabase
  .from("chat_threads")
  .update({ meta: metaUpd })
  .eq("id", threadId);

const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_SHIP",
  ship_mode: "POST",
  awaiting_addr_confirm: true,
  ship_fee_rm: fee,
  quick_replies: [
    { label: "Alamat Betul", send: "ALAMAT BETUL" },
    { label: "Tukar Alamat", send: "ALAMAT SALAH" }
  ]
};
await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
if (admin) await sendWAControlled(event, admin, `🟢 LOCK SHIP MODE\nPOST\nCustomer:${p.e164}\nThread:${threadId}\nFee:${fmtRM(fee)}`);

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta, // ✅ penting utk chat.html render button
  action: "ship_post_confirm_addr"
});
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

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
  !noCut && (
    low === "potong" ||
    low.startsWith("potong ") ||
    low.includes(" potong") ||
    low.includes("cut")
  );

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
          `✅ Balas: “QR”, “TRANSFER”, atau “ATOME”`;

        const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_PAY",
  subtotal: breakdown.subtotal,
  ship_fee_rm: shipFee,
  total: grand,
  quick_replies: [
    { label: "QR", send: "QR" },
    { label: "TRANSFER", send: "TRANSFER" },
    { label: "ATOME", send: "ATOME" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
if (admin) await sendWAControlled(event, admin, `🟦 LOCK → PAY\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(grand)}\n(Cut recorded)`);

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta, // ✅ bagi chat.html render button
  action: "cut_done_to_pay"
});
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

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
            await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "cut_one_ask_current_len" });
        }

        // default: kalau customer cuma tulis "POTONG" tanpa item
        // ✅ jika ada lebih dari 1 item, WAJIB tanya nak potong yang mana
        if (items.length > 1) {
          const seqs = items.map(x => x.seq);
          const listLine = seqs.map(s => `• Item ${s}`).join("\n");

          const reply =
            `Baik cik 😊✅ Cik nak *POTONG* item yang mana ya?\n\n` +
            `${listLine}\n\n` +
            `Balas salah satu:\n` +
            `✅ “POTONG item ${seqs[0]}”\n` +
            `✅ “POTONG item ${seqs[1]}”` +
            (seqs.length > 2 ? `\n✅ “POTONG item ${seqs[2]}”` : ``) +
            `\n\nAtau kalau semua: “POTONG semua”.`;

          const outMeta = {
            lock_sop: true,
            step: "LOCK_WAIT_CUT_ITEM",
            clarify_cut_pick_item: true,
            quick_replies: [
              ...seqs.slice(0, 10).map(s => ({ label: `Item ${s}`, send: `POTONG item ${s}` })),
              { label: "Potong Semua", send: "POTONG semua" },
              { label: "Tak Potong", send: "TAK POTONG" }
            ]
          };

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: outMeta
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply, meta: outMeta, action: "cut_pick_item_needed" });
        }

        // ✅ kalau item cuma 1, baru boleh auto proceed item itu
        const only = items[0];
        await markItemCutBySeq(supabase, threadId, only.seq, 18);

        const metaUpd = setStepMeta(metaNow, {
          cut_mode: "ONE",
          cut_target_seq: only.seq,
          awaiting_current_length: true
        });

        await supabase
          .from("chat_threads")
          .update({ status: "LOCK_WAIT_CUT_LEN", meta: metaUpd })
          .eq("id", threadId);

        const reply =
          `Baik cik 😊✅ *POTONG item ${only.seq}*\n\n` +
          `Item ${only.seq}: panjang asal berapa cm ya? (contoh: 18cm)`;

        await supabase.from("chat_messages").insert({
          thread_id: threadId,
          role: "ai",
          text: reply,
          meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", cut_mode: "ONE", target_seq: only.seq }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "cut_one_ask_current_len" });
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
      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
      return json(200, { ok: true, thread_id: threadId, reply, action: "cut_clarify" });
    }

    /* ========= LOCK_WAIT_CUT_LEN ========= */
    if (threadStatus === "LOCK_WAIT_CUT_LEN") {
      const metaNow = th.data?.meta || {};
      const items = await getOpenLockItems(supabase, threadId);
const targetSeq = metaNow.cut_target_seq ? Number(metaNow.cut_target_seq) : null;
      const target = targetSeq ? items.find(x => Number(x.seq) === targetSeq) : null;

      // ✅ PATCH: dalam mode ALL, pastikan targetSeq wujud (kalau hilang, ambil dari queue)
      const cutModeNow = String(metaNow.cut_mode || "").toUpperCase();
      const queueNow = Array.isArray(metaNow.cut_seq_queue) ? metaNow.cut_seq_queue : [];

      let effectiveTargetSeq = targetSeq;

      if (!effectiveTargetSeq && cutModeNow === "ALL" && queueNow.length) {
        effectiveTargetSeq = Number(queueNow[0]) || null;

        // sync balik ke meta supaya step seterusnya tak jatuh fallback latest
        const metaFix = setStepMeta(metaNow, { cut_target_seq: effectiveTargetSeq });
        await supabase.from("chat_threads").update({ meta: metaFix }).eq("id", threadId);
      }

const targetEff = effectiveTargetSeq
        ? items.find(x => Number(x.seq) === Number(effectiveTargetSeq))
        : null;

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
          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "cut_need_current_len" });
        }

        // update current_length_cm untuk target item
        try {
          const useSeq = effectiveTargetSeq;

          if (useSeq) {
            await supabase
              .from("chat_lock_items")
              .update({ current_length_cm: Number(curr) })
              .eq("thread_id", threadId)
              .eq("seq", useSeq)
              .eq("status", "OPEN");
          } else {
            // fallback hanya dibenarkan jika BUKAN mode ALL
            const cutModeNow2 = String(metaNow.cut_mode || "").toUpperCase();
            if (cutModeNow2 !== "ALL") {
              const latest = await getLatestOpenItem(supabase, threadId);
              if (latest) {
                await supabase
                  .from("chat_lock_items")
                  .update({ current_length_cm: Number(curr) })
                  .eq("id", latest.id);
              }
            }
          }
        } catch (_) {}

        // ✅ penting: kekalkan mode ALL + queue + target (kalau tidak, next reply jatuh ke "default/latest")
        const metaUpd = setStepMeta(metaNow, {
          cut_mode: metaNow.cut_mode || "ALL",
          cut_seq_queue: Array.isArray(metaNow.cut_seq_queue) ? metaNow.cut_seq_queue : (queueNow || []),
          cut_target_seq: effectiveTargetSeq || targetSeq || null,
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
          meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", awaiting_cut_to: true, current_length_cm: Number(curr), target_seq: effectiveTargetSeq || null }
        });

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "cut_need_cut_to" });
      }

      // validate
      const currLen = Number(metaNow.current_length_cm || (targetEff?.current_length_cm || 0));
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
        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
        return json(200, { ok: true, thread_id: threadId, reply, action: "cut_invalid_ge_current" });
      }

  // set cut_to untuk target item
      const useSeq = effectiveTargetSeq;

      if (useSeq) {
        await supabase
          .from("chat_lock_items")
          .update({ wants_cut: true, cut_to_cm: Number(cutTo) })
          .eq("thread_id", threadId)
          .eq("seq", useSeq)
          .eq("status", "OPEN");
      } else {
        // fallback hanya dibenarkan jika BUKAN mode ALL
        const cutModeNow3 = String(metaNow.cut_mode || "").toUpperCase();
        if (cutModeNow3 === "ALL") {
          const reply =
            `Maaf cik 😅 Saya hilang target item untuk potong.\n` +
            `Cik boleh balas semula “POTONG semua” atau “POTONG item ${items[0]?.seq || ""}”.`;

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", error: "missing_target_seq_all" }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
          return json(200, { ok: true, thread_id: threadId, reply, action: "cut_missing_target_all" });
        }

        await setLatestCutTo(supabase, threadId, cutTo);
      }

      // jika cut_mode ALL dan ada queue, proceed to next seq
      if (String(metaNow.cut_mode || "").toUpperCase() === "ALL") {
        const queue = Array.isArray(metaNow.cut_seq_queue) ? metaNow.cut_seq_queue : [];
        const idx = effectiveTargetSeq ? queue.indexOf(effectiveTargetSeq) : -1;
        const nextSeq = (idx >= 0 && idx + 1 < queue.length) ? queue[idx + 1] : null;

        if (nextSeq) {
          // set next as target and ask its current len
          const metaUpd = setStepMeta(metaNow, {
            cut_mode: "ALL",
            cut_seq_queue: Array.isArray(metaNow.cut_seq_queue) ? metaNow.cut_seq_queue : queue,
            cut_target_seq: nextSeq,
            awaiting_current_length: true,
            current_length_cm: null
          });

          await supabase
            .from("chat_threads")
            .update({ meta: metaUpd })
            .eq("id", threadId);

          const reply =
            `Baik cik 😊 Item ${effectiveTargetSeq} potong → *${cutTo}cm* ✅\n\n` +
            `Sekarang item ${nextSeq}: panjang asal berapa cm ya? (contoh: 18cm)`;

          await supabase.from("chat_messages").insert({
            thread_id: threadId,
            role: "ai",
            text: reply,
            meta: { lock_sop: true, step: "LOCK_WAIT_CUT_LEN", cut_mode: "ALL", done_seq: effectiveTargetSeq || null, next_seq: nextSeq }
          });

          await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
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
        `✅ Balas: “QR”, “TRANSFER”, atau “ATOME”`;

      const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_PAY",
  subtotal: breakdown.subtotal,
  ship_fee_rm: shipFee,
  total: grand,
  quick_replies: [
    { label: "QR", send: "QR" },
    { label: "TRANSFER", send: "TRANSFER" },
    { label: "ATOME", send: "ATOME" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);
if (admin) await sendWAControlled(event, admin, `🟦 LOCK → PAY\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(grand)}\n(Cut recorded)`);

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta, // ✅ bagi chat.html render button
  action: "cut_done_to_pay"
});
    }

// ===============================
// HELPER: CREATE J916 ORDERS (MULTI ITEM, 1 GROUP)
// - Create order untuk SEMUA chat_lock_items status OPEN
// - Shipping/discount/cashback apply pada order pertama sahaja
// - Return: { order_codes: [], first_order_code: "" }
// ===============================
async function createJ916OrdersForOpenItems(metaNow, opts = {}) {
  const shippingRm = (opts.shipping_rm != null && opts.shipping_rm !== "")
    ? Number(opts.shipping_rm)
    : 0;

  const discountPostageRm = (opts.discount_postage_rm != null && opts.discount_postage_rm !== "")
    ? Number(opts.discount_postage_rm)
    : 0;

  const cashbackRm = (opts.cashback_rm != null && opts.cashback_rm !== "")
    ? Number(opts.cashback_rm)
    : 0;

  if (!isFinite(shippingRm) || shippingRm < 0) throw new Error("opts.shipping_rm tak sah.");
  if (!isFinite(discountPostageRm) || discountPostageRm < 0) throw new Error("opts.discount_postage_rm tak sah.");
  if (!isFinite(cashbackRm) || cashbackRm < 0) throw new Error("opts.cashback_rm tak sah.");

  // ambil semua OPEN item
  const { data: items, error } = await supabase
    .from("chat_lock_items")
    .select("*")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .order("seq", { ascending: true });

  if (error) throw new Error(error.message);
  if (!items || !items.length) throw new Error("Tiada item lock OPEN.");

  const orderCodes = [];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];

    const itemId =
      it.j916_item_id ||
      it.item_id ||
      it.j916_item_uuid ||
      null;

    if (!itemId) {
      throw new Error(`Tiada j916_item_id (uuid) untuk item seq ${it.seq}. Pastikan masa pick/exact-match simpan uuid j916_items.id.`);
    }

    // derive per gram
    let perG = null;

    if (it.live_rm_per_g != null && it.live_rm_per_g !== "") {
      const x = Number(it.live_rm_per_g);
      if (isFinite(x) && x > 0) perG = x;
    }

    if (perG == null) {
      const w = Number(it.weight_g || 0);
      const price = Number(it.price_rm || 0);
      if (isFinite(w) && w > 0 && isFinite(price) && price > 0) {
        perG = price / w;
      }
    }

    if (perG == null) {
      throw new Error(`Tak boleh derive live_rm_per_g untuk item seq ${it.seq}. Pastikan ada price_rm + weight_g.`);
    }

    // kira amount per order:
    // - order pertama: item_price + shipping - diskaun - cashback
    // - order seterusnya: item_price sahaja
    const itemPrice = Number(it.price_rm || 0);
    if (!isFinite(itemPrice) || itemPrice <= 0) {
      throw new Error(`price_rm tak sah untuk item seq ${it.seq}.`);
    }

    const isFirst = (i === 0);

    const thisShipping = isFirst ? shippingRm : 0;
    const thisDiscPostage = isFirst ? discountPostageRm : 0;
    const thisCashback = isFirst ? cashbackRm : 0;

    const overrideAmountRm = Math.max(
      0,
      (itemPrice + thisShipping) - thisDiscPostage - thisCashback
    );

    if (!isFinite(overrideAmountRm) || overrideAmountRm <= 0) {
      throw new Error(`override_amount_rm jadi tak sah untuk item seq ${it.seq}.`);
    }

    const r = await fetch(`${siteUrl}/.netlify/functions/j916-lock-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: p.e164.replace(/^60/, "0"),
        item_id: itemId,
        live_rm_per_g: perG,
        live_upah: 0,
        shipping_rm: thisShipping,
        checkout_group: threadId,

        // paling stabil: kita override jumlah ikut item
        override_amount_rm: overrideAmountRm,

        // untuk rekod (optional, server boleh ignore)
        discount_postage_rm: thisDiscPostage,
        cashback_rm: thisCashback
      })
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || "Create order failed");

    const orderCode =
      j.order?.order_code ||
      j.order?.id ||
      j.order_code ||
      j.order_id ||
      null;

    if (!orderCode) {
      console.log("DEBUG ORDER RESPONSE:", j);
      throw new Error("Order created tapi order_code/id tak dijumpai dalam response.");
    }

    orderCodes.push(orderCode);

    // lock item ini sahaja
    const { error: updErr } = await supabase
      .from("chat_lock_items")
      .update({
        status: "LOCKED",
        order_code: orderCode // kalau column tak wujud, supabase akan error — jadi kita try/catch bawah
      })
      .eq("id", it.id);

    // kalau column order_code tak wujud, fallback update status sahaja
    if (updErr) {
      await supabase
        .from("chat_lock_items")
        .update({ status: "LOCKED" })
        .eq("id", it.id);
    }
  }

  return { order_codes: orderCodes, first_order_code: orderCodes[0] };
} 
 /* ========= LOCK_WAIT_PAY ========= */
    if (threadStatus === "LOCK_WAIT_PAY") {
      const metaNow = th.data?.meta || {};
      const low = String(msg || "").toLowerCase();

      const items = await getOpenLockItems(supabase, threadId);
const breakdown = buildItemsBreakdown(items);

const shipFee = Number(metaNow.ship_fee_rm || 0);
const total = breakdown.subtotal + shipFee;

// ✅ ambil rule dari admin: j916_payment_rules (id=1)
let rules = { postage_discount_rm: 0, cashback_percent: 0, cashback_round_mode: "FLOOR" };
try {
  rules = await getPayRules(supabase);
} catch (_) {}

// ✅ diskaun postage hanya relevan bila POS (kalau pickup shipFee=0 memang 0)
const isPost = String(metaNow.ship_mode || "").toUpperCase() === "POST";

// diskaun postage untuk QR/TRANSFER/ATOME
const postageDiscount = isPost
  ? Math.max(0, Math.min(Number(rules.postage_discount_rm || 0), shipFee)) // jangan lebih dari shipping
  : 0;

// cashback untuk QR/TRANSFER sahaja (dikira dari harga barang sahaja)
const cashbackRaw = (breakdown.subtotal * Number(rules.cashback_percent || 0)) / 100;

// ✅ ikut rule: FLOOR = floor ke RM bulat (bukan sen)
const roundMode = String(rules.cashback_round_mode || "FLOOR").toUpperCase();
const cashback = (roundMode === "FLOOR")
  ? Math.floor(cashbackRaw)
  : floorRM(cashbackRaw); // fallback kalau mode lain
// jumlah akhir ikut method
const finalPayAtome = Math.max(0, total - postageDiscount);           // ATOME: tiada cashback
const finalPayCash  = Math.max(0, total - postageDiscount - cashback); // QR/TRANSFER

// final ikut method akan ditentukan dalam branch masing-masing

      const payQR = low.includes("qr");
      const payTransfer = low.includes("transfer") || low.includes("bank");
      const payAtome = low.includes("atome") || low.includes("tomey") || low.includes("ansur");

      // helper for payment links (placeholder)
      const mkQRLink = () => `${siteUrl}/pay?thread=${encodeURIComponent(threadId)}&m=QR`;
      const mkAtomeLink = () => `${siteUrl}/qr-atome.html`;
      const mkTransferInfo = () =>
        `Bank Transfer:\n` +
        `✅ Nama akaun: Emas Amir\n` +
        `✅ (Isi nombor akaun bank dalam SOP chat_sop key: pay.transfer.details)\n` +
        `\nLepas bayar, hantar screenshot resit ya.`;

if (payAtome) {

  let orderCode = null;
  let orderCodesAll = [];

  try {
    const ord = await createJ916OrdersForOpenItems(metaNow, {
      shipping_rm: shipFee,
      discount_postage_rm: postageDiscount,
      cashback_rm: 0
    });

    orderCode = ord.first_order_code;
    orderCodesAll = ord.order_codes || [];
  } catch (e) {
    return json(500, { ok: false, error: "Gagal create order: " + e.message });
  }

  const reply =
    `Baik cik 😊✅ Pilihan: *ATOME (ansuran)*\n\n` +
    `Order code: *${orderCode}*\n\n` +
    `Ringkasan bayaran:\n` +
    breakdown.lines.map(l => `• ${l}`).join("\n") + `\n` +
    (metaNow.ship_mode === "POST"
      ? `• Caj pos: ${fmtRM(shipFee)}${metaNow.ship_label ? ` (${metaNow.ship_label})` : ""}\n`
      : `• Ambil kedai: ${metaNow.pickup_when_text ? metaNow.pickup_when_text : "-"}\n`
    ) +
    `• Jumlah asal: *${fmtRM(total)}*\n` +
    (postageDiscount ? `• Diskaun postage: *-${fmtRM(postageDiscount)}*\n` : ``) +
    `• Cashback: *-${fmtRM(0)}* (tiada untuk ATOME)\n` +
    `\n✅ Jumlah akhir perlu dibayar: *${fmtRM(finalPayAtome)}*\n\n` +
    `Cik klik link ini untuk teruskan:\n` +
    `${mkAtomeLink()}\n\n` +
    (orderCodesAll.length > 1 ? `Order lain dalam group: ${orderCodesAll.slice(1).join(", ")}\n\n` : ``) +
    `Nota:\n` +
    `• Bayaran pertama kali, cik akan terus dapat barang.\n` +
    `• Min ansuran 3 bulan dan boleh lebih dari 3 bulan (ikut kelulusan akaun cik).\n` +
    `• Cik boleh semak berapa bulan cik layak bila scan QR ATOME nanti.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Urusan cik di sini telah selesai.\n` +
    `Selepas pembayaran berjaya, mohon hantarkan bukti pembayaran ke WhatsApp kami untuk kami teruskan proses penghantaran ya 😊\n\n` +
    `Terima kasih kerana memilih dan menyokong *Emas Amir* ❤️\n\n` +
    `Jika cik ada lock barang dalam LIVE lagi, sila balas:\n` +
    `👉 "Ya, saya ada lock dalam LIVE"\n\n` +
`🧾 "Saya dah bayar (hantar slip)"\n\n` +
`Jika tiada lock, cik boleh terus tanya apa-apa soalan ya 😊`;

  const baseMeta = resetTransientMeta(metaNow || {});

  const metaAfterAtome = {
    ...baseMeta,
    lock: false,
    step: "OPEN",
    lock_id: null,
    return_to_status: "LOCK_WAIT_PAY",
    last_pay_method: "ATOME",
    last_order_code: orderCode,
    last_order_codes_all: orderCodesAll,
    last_total_rm: Number(finalPayAtome || 0),
    j916_return_at: new Date().toISOString()
  };

  const { error: updErrAtome } = await supabase
    .from("chat_threads")
    .update({ status: "OPEN", meta: metaAfterAtome })
    .eq("id", threadId);

  if (updErrAtome) return json(500, { ok: false, error: "Update meta thread gagal: " + updErrAtome.message });

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: { lock_sop: true, step: "LOCK_WAIT_PAY", method: "ATOME", total, final_pay: finalPayAtome, orderCode }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
  allow_after_pay_method: "ATOME"
});

  return json(200, { ok: true, thread_id: threadId, reply, action: "pay_atome" });
}

if (payQR) {

  let orderCode = null;
  let orderCodesAll = [];

  try {
    const ord = await createJ916OrdersForOpenItems(metaNow, {
      shipping_rm: shipFee,
      discount_postage_rm: postageDiscount,
      cashback_rm: cashback
    });

    orderCode = ord.first_order_code;
    orderCodesAll = ord.order_codes || [];
  } catch (e) {
    return json(500, { ok: false, error: "Gagal create order: " + e.message });
  }

  const bankName = process.env.BANK_NAME || "";
  const bankAccName = process.env.BANK_ACC_NAME || "";
  const bankAccNo = process.env.BANK_ACC_NO || "";
  const bankQrUrl = process.env.BANK_QR_URL || "";

  const reply =
    `Baik cik 😊✅ Pilihan: *QR*\n\n` +
    `Order code: *${orderCode}*\n\n` +
    `Ringkasan bayaran:\n` +
    breakdown.lines.map(l => `• ${l}`).join("\n") + `\n` +
    (metaNow.ship_mode === "POST"
      ? `• Caj pos: ${fmtRM(shipFee)}${metaNow.ship_label ? ` (${metaNow.ship_label})` : ""}\n`
      : `• Ambil kedai: ${metaNow.pickup_when_text ? metaNow.pickup_when_text : "-"}\n`
    ) +
    `• Jumlah asal: *${fmtRM(total)}*\n` +
    (postageDiscount ? `• Diskaun postage: *-${fmtRM(postageDiscount)}*\n` : ``) +
    (cashback ? `• Cashback: *-${fmtRM(cashback)}*\n` : `• Cashback: *-${fmtRM(0)}*\n`) +
    `\n✅ Jumlah akhir perlu dibayar: *${fmtRM(finalPayCash)}*\n\n` +
    (orderCodesAll.length > 1 ? `Order lain dalam group: ${orderCodesAll.slice(1).join(", ")}\n\n` : ``) +
    `Bank: ${bankName}\n` +
    `Nama Akaun: ${bankAccName}\n` +
    `No Akaun: ${bankAccNo}\n\n` +
    `QR:\n${bankQrUrl}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Selepas pembayaran berjaya, mohon hantarkan bukti pembayaran ke WhatsApp kami untuk kami teruskan proses penghantaran ya 🙏\n\n` +
    `Terima kasih kerana memilih dan menyokong *Emas Amir* ❤️\n\n` +
    `Jika cik ada lock barang dalam LIVE lagi, sila balas:\n` +
    `👉 "Ya, saya ada lock dalam LIVE"\n\n` +
`🧾 "Saya dah bayar (hantar slip)"\n\n` +
`Jika tiada lock, cik boleh terus tanya apa-apa soalan ya 😊`;

  const baseMeta = resetTransientMeta(metaNow || {});

  const metaAfterQR = {
    ...baseMeta,
    lock: false,
    step: "OPEN",
    lock_id: null,
    return_to_status: "LOCK_WAIT_PAY",
    last_pay_method: "QR",
    last_order_code: orderCode,
    last_order_codes_all: orderCodesAll,
    last_total_rm: Number(finalPayCash || 0),
    j916_return_at: new Date().toISOString()
  };

  const { error: updErrQR } = await supabase
    .from("chat_threads")
    .update({ status: "OPEN", meta: metaAfterQR })
    .eq("id", threadId);

  if (updErrQR) return json(500, { ok: false, error: "Update meta thread gagal: " + updErrQR.message });

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: { lock_sop: true, step: "LOCK_WAIT_PAY", method: "QR", total, final_pay: finalPayCash, orderCode }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
  allow_after_pay_method: "QR",
  file_url: bankQrUrl,
  file_name: "QR.png"
});

  return json(200, { ok: true, thread_id: threadId, reply, action: "pay_qr" });
}

if (payTransfer) {

  let orderCode = null;
  let orderCodesAll = [];

  try {
    const ord = await createJ916OrdersForOpenItems(metaNow, {
      shipping_rm: shipFee,
      discount_postage_rm: postageDiscount,
      cashback_rm: cashback
    });

    orderCode = ord.first_order_code;
    orderCodesAll = ord.order_codes || [];
  } catch (e) {
    return json(500, { ok: false, error: "Gagal create order: " + e.message });
  }

  const bankName = process.env.BANK_NAME || "";
  const bankAccName = process.env.BANK_ACC_NAME || "";
  const bankAccNo = process.env.BANK_ACC_NO || "";
  const bankQrUrl = process.env.BANK_QR_URL || "";

  const reply =
    `Baik cik 😊✅ Pilihan: *Bank Transfer*\n\n` +
    `Order code: *${orderCode}*\n\n` +
    `Ringkasan bayaran:\n` +
    breakdown.lines.map(l => `• ${l}`).join("\n") + `\n` +
    (metaNow.ship_mode === "POST"
      ? `• Caj pos: ${fmtRM(shipFee)}${metaNow.ship_label ? ` (${metaNow.ship_label})` : ""}\n`
      : `• Ambil kedai: ${metaNow.pickup_when_text ? metaNow.pickup_when_text : "-"}\n`
    ) +
    `• Jumlah asal: *${fmtRM(total)}*\n` +
    (postageDiscount ? `• Diskaun postage: *-${fmtRM(postageDiscount)}*\n` : ``) +
    (cashback ? `• Cashback: *-${fmtRM(cashback)}*\n` : `• Cashback: *-${fmtRM(0)}*\n`) +
    `\n✅ Jumlah akhir perlu dibayar: *${fmtRM(finalPayCash)}*\n\n` +
    (orderCodesAll.length > 1 ? `Order lain dalam group: ${orderCodesAll.slice(1).join(", ")}\n\n` : ``) +
    `Bank: ${bankName}\n` +
    `Nama Akaun: ${bankAccName}\n` +
    `No Akaun: ${bankAccNo}\n\n` +
    `QR (optional):\n${bankQrUrl}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Selepas pembayaran berjaya, mohon hantarkan bukti pembayaran ke WhatsApp kami untuk kami teruskan proses penghantaran ya 🙏\n\n` +
    `Terima kasih kerana memilih dan menyokong *Emas Amir* ❤️\n\n` +
    `Jika cik ada lock barang dalam LIVE lagi, sila balas:\n` +
    `👉 "Ya, saya ada lock dalam LIVE"\n\n` +
`🧾 "Saya dah bayar (hantar slip)"\n\n` +
`Jika tiada lock, cik boleh terus tanya apa-apa soalan ya 😊`;

  const baseMeta = resetTransientMeta(metaNow || {});

  const metaAfterTransfer = {
    ...baseMeta,
    lock: false,
    step: "OPEN",
    lock_id: null,
    return_to_status: "LOCK_WAIT_PAY",
    last_pay_method: "TRANSFER",
    last_order_code: orderCode,
    last_order_codes_all: orderCodesAll,
    last_total_rm: Number(finalPayCash || 0),
    awaiting_transfer_receipt: true,
    j916_return_at: new Date().toISOString()
  };

  const { error: updErrTransfer } = await supabase
    .from("chat_threads")
    .update({ status: "OPEN", meta: metaAfterTransfer })
    .eq("id", threadId);

  if (updErrTransfer) return json(500, { ok: false, error: "Update meta thread gagal: " + updErrTransfer.message });

  await supabase.from("chat_messages").insert({
    thread_id: threadId,
    role: "ai",
    text: reply,
    meta: { lock_sop: true, step: "LOCK_WAIT_PAY", method: "TRANSFER", total, final_pay: finalPayCash, orderCode }
  });

  await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
  allow_after_pay_method: "TRANSFER"
});

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

        await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
  allow_after_pay_method: "TRANSFER",
  file_url: fileUrl,
  file_name: fileName
});

if (admin) {
  await sendWAControlled(
    event,
    admin,
    `🧾 TRANSFER RECEIPT\nCustomer:${p.e164}\nThread:${threadId}\nTotal:${fmtRM(total)}\nResit:${fileUrl}`,
    {
      allow_after_pay_method: "TRANSFER"
    }
  );
}

        return json(200, { ok: true, thread_id: threadId, reply, action: "transfer_receipt_received" });
      }

      const reply =
        `Baik cik 😊\n` +
        `Cik nak bayar guna apa?\n` +
        `✅ Balas: “QR”, “TRANSFER”, atau “ATOME”`;

      const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_PAY",
  clarify: true,
  quick_replies: [
    { label: "QR", send: "QR" },
    { label: "TRANSFER", send: "TRANSFER" },
    { label: "ATOME", send: "ATOME" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

return json(200, {
  ok: true,
  thread_id: threadId,
  reply,
  meta: outMeta, // ✅ penting
  action: "pay_clarify"
});
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

      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}`);
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

      await sendWAControlled(event, p.e164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

      if (admin) {
        await sendWAControlled(
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

function parseLockCount(msg) {
  const s = String(msg || "").trim();
  if (!s) return null;
  const m = s.match(/\b([1-4])\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return (n >= 1 && n <= 4) ? n : null;
}

async function getPendingPriceSeqs(supabase, threadId) {
  const q = await supabase
    .from("chat_lock_items")
    .select("seq, price_rm")
    .eq("thread_id", threadId)
    .eq("status", "OPEN")
    .order("seq", { ascending: true });

  if (q.error) return [];
  const rows = Array.isArray(q.data) ? q.data : [];
  return rows.filter(x => x.price_rm == null).map(x => Number(x.seq));
}

async function getPayRules(supabase) {
  const q = await supabase
    .from("j916_payment_rules")
    .select("id,postage_discount_rm,cashback_percent,cashback_round_mode")
    .eq("id", 1)
    .maybeSingle();

  if (q.error) throw q.error;

  const row = q.data || null;
  if (!row) {
    return { postage_discount_rm: 0, cashback_percent: 0, cashback_round_mode: "FLOOR" };
  }

  return {
    postage_discount_rm: Number(row.postage_discount_rm || 0),
    cashback_percent: Number(row.cashback_percent || 0),
    cashback_round_mode: String(row.cashback_round_mode || "FLOOR").toUpperCase()
  };
}

async function setItemPriceBySeq(supabase, threadId, seq, price) {
  await supabase
    .from("chat_lock_items")
    .update({ price_rm: price })
    .eq("thread_id", threadId)
    .eq("seq", Number(seq))
    .eq("status", "OPEN");
}

async function afterItemRecordedMulti({ supabase, threadId, metaNow, siteUrl, event, phoneE164, fileUrl, fileName }) {
  const expected = Number(metaNow?.lock_expected_items || 0);
  const receivedBefore = Number(metaNow?.lock_received_items || 0);

  // bukan multi -> tak handle
  if (!(expected >= 2)) return { handled: false };

  const received = receivedBefore + 1;

  const metaUpd = {
    ...(metaNow || {}),
    lock_received_items: received
  };

  // belum cukup -> minta gambar seterusnya
  if (received < expected) {
    const reply =
      `Terima kasih cik 😊 Saya dah rekod *barang #${received}*.\n\n` +
      `Sekarang sila hantar *gambar tag barang #${received + 1}* pula ya.\n` +
      `📌 (1 gambar untuk 1 barang)`;

    await supabase
      .from("chat_threads")
      .update({ status: "LOCK_COLLECT_TAGS", meta: metaUpd })
      .eq("id", threadId);

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { lock_sop: true, step: "LOCK_COLLECT_TAGS", expected, received }
    });

    await sendWAControlled(event, phoneE164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`, {
      file_url: fileUrl,
      file_name: fileName
    });

    return { handled: true, action: "lock_collect_next", reply };
  }

  // cukup semua gambar -> check item mana yang tiada harga
  const pending = await getPendingPriceSeqs(supabase, threadId);

  if (pending.length) {
    const firstSeq = Number(pending[0]);

    const reply =
      `Baik cik 😊 Semua tag dah saya terima & rekod.\n\n` +
      `Kalau cik ingat, harga masa LIVE untuk *barang #${firstSeq}* berapa ya?\n` +
      `Kalau tak ingat, cik boleh balas “lupa harga barang ${firstSeq}”.`;

    const metaClean = resetTransientMeta(metaUpd || {});
    const metaFinal = { ...(metaClean || {}), price_pending_seqs: pending };

    await supabase
      .from("chat_threads")
      .update({ status: "LOCK_WAIT_PRICE", meta: metaFinal })
      .eq("id", threadId);

    await supabase.from("chat_messages").insert({
      thread_id: threadId,
      role: "ai",
      text: reply,
      meta: { lock_sop: true, step: "LOCK_WAIT_PRICE", price_pending_seqs: pending }
    });

    await sendWAControlled(event, phoneE164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

    return { handled: true, action: "lock_price_queue_start", reply };
  }

  // semua ada harga -> baru tanya pos/ambil
const reply =
  `Baik cik 😊✅ Semua barang dah direkod.\n\n` +
  `Sekarang cik nak ambil di kedai (walk-in) atau nak kami pos?`;

// ✅ kekalkan meta asas thread (reset transient sahaja)
const metaClean = resetTransientMeta(metaUpd || {});
await supabase
  .from("chat_threads")
  .update({ status: "LOCK_WAIT_SHIP", meta: metaClean })
  .eq("id", threadId);

// ✅ BUTTON untuk chat.html (WAJIB letak dalam chat_messages.meta)
const outMeta = {
  lock_sop: true,
  step: "LOCK_WAIT_SHIP",
  clarify: true,
  quick_replies: [
    { label: "Ambil Kedai", send: "ambil kedai" },
    { label: "Pos", send: "pos" }
  ]
};

await supabase.from("chat_messages").insert({
  thread_id: threadId,
  role: "ai",
  text: reply,
  meta: outMeta
});

await sendWAControlled(event, phoneE164, `Emas Amir\n\n${reply}\n\nChat: ${siteUrl}/chat`);

return {
  handled: true,
  action: "lock_multi_done_to_ship",
  reply,
  meta: outMeta // ✅ optional untuk UI immediate, tapi bagus kekalkan
};
}