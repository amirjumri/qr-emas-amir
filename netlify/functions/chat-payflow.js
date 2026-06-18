// netlify/functions/chat-payflow.js
// Payflow module (dipanggil dari chat-send.js) — SINGLE ORDER FIRST
// export: { handle(ctx) }
//
// Optional ENV:
// - OPENAI_API_KEY
// - OPENAI_MODEL (default: "gpt-4o-mini")

function upper(s) {
  return String(s || "").trim().toUpperCase();
}

function fmtRM(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return "RM 0.00";
  return "RM " + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function nowIso() {
  return new Date().toISOString();
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalizeMsisdnVariants(raw) {
  // variants biasa: 013..., 6013..., +6013...
  const d = digitsOnly(raw);
  if (!d) return [];

  let core = d;

  // 0xxxxxxxxx -> 60xxxxxxxxx
  if (core.startsWith("0")) core = "6" + core;

  // fallback kalau user bagi 13xxxxxx
  if (!core.startsWith("60")) core = "60" + core;

  const withPlus = "+" + core;
  const withoutPlus = core;
  const withZero = "0" + core.slice(2);

  const out = [];
  [withZero, withoutPlus, withPlus].forEach(v => {
    if (v && !out.includes(v)) out.push(v);
  });
  return out;
}

function safeObj(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(String(v)); } catch (_) { return {}; }
}

function looksLikePaidProof(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("dah bayar") ||
    t.includes("sudah bayar") ||
    t.includes("bayar dah") ||
    t.includes("saya dah bayar") ||
    t.includes("dah transfer") ||
    t.includes("slip") ||
    t.includes("bukti bayar") ||
    t.includes("bukti bayaran") ||
    t.includes("resit") ||
    t.includes("receipt") ||
    t.includes("payment proof") ||
    t.includes("proof bayar")
  );
}

function orderAmountRM(o) {
  const cents = Number(o?.amount_cents || 0);
  if (Number.isFinite(cents) && cents > 0) return cents / 100;

  const rm = Number(o?.grand_total_rm || 0);
  if (Number.isFinite(rm) && rm > 0) return rm;

  return 0;
}

// ambil 1 order PENDING paling latest ikut phone variants
async function fetchLatestPendingOrderByPhone(sb, phoneRaw) {
  const variants = normalizeMsisdnVariants(phoneRaw);
  if (!variants.length) return null;

  const { data, error } = await sb
    .from("j916_orders")
    .select("id, order_code, created_at, status, phone, amount_cents, grand_total_rm, pay_method, checkout_group")
    .eq("status", "PENDING")
    .in("phone", variants)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function insertAiMessage(sb, threadId, text, metaObj) {
  const row = {
    thread_id: threadId,
    role: "ai",
    text: String(text || ""),
    meta: metaObj || {},
    lock_id: null
  };
  const { error } = await sb.from("chat_messages").insert(row);
  if (error) throw error;
}

async function updateThread(sb, threadId, patch) {
  const { error } = await sb
    .from("chat_threads")
    .update({ ...(patch || {}), last_message_at: nowIso() })
    .eq("id", threadId);

  if (error) throw error;
}

async function createSlipRow(sb, payload) {
  // NOTE: column "order_code" dalam customer_slips Amir guna UUID order (id) — kekalkan macam lama
  const row = {
    thread_id: payload.thread_id,
    order_code: payload.order_id_uuid || null, // ✅ simpan UUID order id
    pay_group_id: null,
    customer_phone: payload.customer_phone,
    status: "PENDING_UPLOAD",
    created_at: nowIso()
  };

  const { data, error } = await sb
    .from("customer_slips")
    .insert(row)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  return data?.id || null;
}

async function updateSlipWithFile(sb, slipId, patch) {
  const { error } = await sb
    .from("customer_slips")
    .update(patch)
    .eq("id", slipId);

  if (error) throw error;
}

function isProofAttachment(att) {
  if (!att || !att.url) return false;
  const m = String(att.mime || "").toLowerCase();
  return m.startsWith("image/") || m === "application/pdf" || m.includes("pdf");
}

function isProbablyImageMime(m) {
  const s = String(m || "").toLowerCase();
  return s.startsWith("image/");
}
function isPdfMime(m) {
  const s = String(m || "").toLowerCase();
  return s === "application/pdf" || s.includes("pdf");
}

function cleanText(x) {
  return String(x || "").replace(/\s+/g, " ").trim();
}

function tryParseJsonLoose(s) {
  try {
    return JSON.parse(s);
  } catch (_) {}

  // fallback: cari blok {...}
  try {
    const t = String(s || "");
    const i = t.indexOf("{");
    const j = t.lastIndexOf("}");
    if (i >= 0 && j > i) {
      return JSON.parse(t.slice(i, j + 1));
    }
  } catch (_) {}
  return null;
}

async function toDataUrlFromImageUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`image fetch failed: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const ct = resp.headers.get("content-type") || "image/jpeg";
  const b64 = buf.toString("base64");
  return `data:${ct};base64,${b64}`;
}

/**
 * Baca slip guna OpenAI Vision (GAMBAR SAHAJA)
 * Return:
 * { ok:true, data:{amount_rm, bank, ref_no, date_time, payer_name, receiver_name, receiver_account_last4, other_payment_details, notes} }
 */
async function analyzeSlipWithOpenAI({ fileUrl, mime }) {
  const key = process.env.OPENAI_API_KEY || "";
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  if (!key || !fileUrl) return { ok: false, reason: "no_key_or_url" };
  if (!isProbablyImageMime(mime || "")) return { ok: false, reason: "not_image" };

  // stabilkan: convert to dataURL (kalau link private/expire)
  let dataUrl = null;
  try {
    dataUrl = await toDataUrlFromImageUrl(fileUrl);
  } catch (e) {
    return { ok: false, reason: "fetch_image_fail" };
  }

  const instruction =
    "Anda pembantu kedai emas. Tugas: baca slip bank/FPX/online transfer dalam gambar.\n" +
    "Keluarkan JSON SAHAJA dengan field:\n" +
    "{\n" +
    '  "amount_rm": number|null,\n' +
    '  "bank": string|null,\n' +
    '  "ref_no": string|null,\n' +
    '  "date_time": string|null,\n' +
    '  "payer_name": string|null,\n' +
    '  "receiver_name": string|null,\n' +
    '  "receiver_account_last4": string|null,\n' +
    '  "other_payment_details": string|null,\n' +
    '  "notes": string|null\n' +
    "}\n" +
    "Makna 'other_payment_details': teks pada slip seperti 'Other Payment Details', 'Payment Details', 'Recipient Reference', 'Remarks', dll.\n" +
    "Jika tak pasti, letak null. Jangan reka. Jangan tambah teks lain.";

  const payload = {
    model,
    messages: [
      { role: "system", content: instruction },
      {
        role: "user",
        content: [
          { type: "text", text: "Baca slip dan pulangkan JSON sahaja." },
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
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const e = await r.text().catch(() => "");
      return { ok: false, reason: `http_${r.status}`, raw: cleanText(e).slice(0, 300) };
    }

    const j = await r.json().catch(() => ({}));
    txt = cleanText(j?.choices?.[0]?.message?.content || "");
  } catch (e) {
    return { ok: false, reason: "fetch_openai_fail" };
  }

  const parsed = tryParseJsonLoose(txt);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "parse_fail", raw: cleanText(txt).slice(0, 300) };
  }

  const out = {
    amount_rm: (parsed.amount_rm == null || parsed.amount_rm === "" ? null : Number(parsed.amount_rm)),
    bank: parsed.bank == null ? null : cleanText(parsed.bank),
    ref_no: parsed.ref_no == null ? null : cleanText(parsed.ref_no),
    date_time: parsed.date_time == null ? null : cleanText(parsed.date_time),
    payer_name: parsed.payer_name == null ? null : cleanText(parsed.payer_name),
    receiver_name: parsed.receiver_name == null ? null : cleanText(parsed.receiver_name),
    receiver_account_last4: parsed.receiver_account_last4 == null ? null : cleanText(parsed.receiver_account_last4),
    other_payment_details: parsed.other_payment_details == null ? null : cleanText(parsed.other_payment_details),
    notes: parsed.notes == null ? null : cleanText(parsed.notes)
  };

  if (out.amount_rm != null && !isFinite(out.amount_rm)) out.amount_rm = null;

  // normalize empty -> null
  Object.keys(out).forEach(k => {
    if (out[k] === "" || out[k] === "null" || out[k] === "undefined") out[k] = null;
  });

  return { ok: true, data: out };
}

function formatSlipDetails(d) {
  if (!d || typeof d !== "object") return "";
  const lines = [];

  if (d.amount_rm != null && isFinite(Number(d.amount_rm))) lines.push(`• Jumlah dibaca: *${fmtRM(Number(d.amount_rm))}*`);
  if (d.bank) lines.push(`• Bank/Platform: *${d.bank}*`);
  if (d.ref_no) lines.push(`• No. Rujukan: *${d.ref_no}*`);
  if (d.date_time) lines.push(`• Tarikh/Masa: *${d.date_time}*`);
  if (d.payer_name) lines.push(`• Nama pengirim: *${d.payer_name}*`);
  if (d.receiver_name) lines.push(`• Nama penerima: *${d.receiver_name}*`);
  if (d.receiver_account_last4) lines.push(`• Akaun penerima (last4): *${d.receiver_account_last4}*`);
  if (d.other_payment_details) lines.push(`• Other Payment Details: *${d.other_payment_details}*`);
  if (d.notes) lines.push(`• Nota: ${d.notes}`);

  if (!lines.length) return "";
  return (
    "\n\n📌 *Butiran slip (bacaan automatik)*\n" +
    lines.join("\n") +
    "\n\n_(Nota: Bacaan automatik. Staff akan semak & padankan dengan statement.)_"
  );
}

function parseDateOnlyFromAny(s) {
  const t = String(s || "").trim();
  if (!t) return null;

  // already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  // try Date parse (handles many formats)
  const d = new Date(t);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // try "03 Mar 2026" etc
  const m = t.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (m) {
    const day = String(m[1]).padStart(2, "0");
    const monStr = String(m[2]).toLowerCase();
    const year = String(m[3]);
    const map = {
      jan: "01", january: "01",
      feb: "02", february: "02",
      mar: "03", march: "03",
      apr: "04", april: "04",
      may: "05",
      jun: "06", june: "06",
      jul: "07", july: "07",
      aug: "08", august: "08",
      sep: "09", sept: "09", september: "09",
      oct: "10", october: "10",
      nov: "11", november: "11",
      dec: "12", december: "12"
    };
    const mm = map[monStr] || map[monStr.slice(0, 3)];
    if (mm) return `${year}-${mm}-${day}`;
  }

  return null;
}

exports.handle = async function handle(ctx = {}) {
  const {
    supabase: sb,
    threadId,
    thread,
    phone,
    msg,
    attachment,
    siteUrl
  } = ctx;

  if (!sb || !threadId || !thread) return { pass: true };

  const threadStatus = upper(thread.status || "OPEN");
  const metaNow = safeObj(thread.meta);

  // ===== EXIT PAYFLOW (optional) =====
  {
    const low = String(msg || "").toLowerCase().trim();
    const wantsExit =
      low === "keluar" ||
      low === "reset" ||
      low.includes("batal payflow") ||
      low.includes("keluar payflow");

    if (wantsExit) {
      const nextMeta = { ...(metaNow || {}) };
      delete nextMeta.payflow;
      delete nextMeta.pay_step;
      delete nextMeta.pay_slip_id;
      delete nextMeta.pay_order_id;
      delete nextMeta.pay_order_code_display;
      delete nextMeta.pay_amount_rm;

      await updateThread(sb, threadId, { status: "OPEN", meta: nextMeta });

      const reply =
        `Baik 😊 Payflow dibatalkan.\n` +
        `Kita kembali ke chat biasa.`;

      return { reply, action: "payflow_exit", meta: { payflow: true, exit: true } };
    }
  }

  const inPay = threadStatus.startsWith("PAY_");
  const wantsPay = looksLikePaidProof(msg) || isProofAttachment(attachment);

  // ✅ kalau bukan payflow & tak ada signal bukti bayar -> pass
  if (!inPay && !wantsPay) return { pass: true };

  // ===== STEP 1: START (SINGLE ORDER) =====
  if (!inPay) {
    const order = await fetchLatestPendingOrderByPhone(sb, phone);

    if (!order || !order.id) {
      const reply =
        `Baik cik 😊\n\n` +
        `Saya tak jumpa order yang masih *PENDING* untuk nombor ini.\n` +
        `Kalau cik ada *Order code*, cik paste sini ya.`;

      return { reply, action: "payflow_no_pending", meta: { payflow: true, no_pending: true } };
    }

    const slipId = await createSlipRow(sb, {
      thread_id: threadId,
      order_id_uuid: order.id,
      customer_phone: phone
    });

    const displayCode = String(order.order_code || "").trim() || String(order.id).split("-")[0];
    const amountRm = orderAmountRM(order);

    const nextMeta = {
      ...(metaNow || {}),
      payflow: true,
      pay_step: "PAY_WAIT_UPLOAD",
      pay_slip_id: slipId,
      pay_order_id: String(order.id),
      pay_order_code_display: displayCode,
      pay_amount_rm: amountRm,
      pay_started_at: nowIso()
    };

   await updateThread(sb, threadId, { status: "PAY_WAIT_UPLOAD", meta: nextMeta });

// ✅ Jika customer tekan "Saya dah bayar nak hantar slip"
// dan terus upload gambar/PDF sekali,
// jangan suruh upload lagi. Terus proses attachment itu.
if (attachment && attachment.url) {
  return await exports.handle({
    ...ctx,
    thread: {
      ...(thread || {}),
      status: "PAY_WAIT_UPLOAD",
      meta: nextMeta
    }
  });
}

const reply =
  `Baik cik ✅ Saya jumpa 1 order yang masih *PENDING*.\n\n` +
  `• Order: *${displayCode}*\n` +
  (amountRm > 0 ? `• Jumlah: *${fmtRM(amountRm)}*\n\n` : `\n`) +
  `Sekarang sila *upload slip bayaran* di sini (gambar / PDF).`;

return { reply, action: "payflow_start_single", meta: { payflow: true, step: "PAY_WAIT_UPLOAD", slip_id: slipId } };
  }

  // ===== STEP 2: WAIT UPLOAD =====
  if (threadStatus === "PAY_WAIT_UPLOAD") {
    const slipId = String(metaNow?.pay_slip_id || "").trim();
    if (!slipId) {
      const nextMeta = { ...(metaNow || {}) };
      delete nextMeta.payflow;
      delete nextMeta.pay_step;
      delete nextMeta.pay_slip_id;

      await updateThread(sb, threadId, { status: "OPEN", meta: nextMeta });

      const reply =
        `⚠️ Sesi slip hilang.\n` +
        `Sila taip semula: *saya dah bayar*`;

      return { reply, action: "payflow_missing_slip_id", meta: { payflow: true, err: "missing_slip_id" } };
    }

    if (!attachment || !attachment.url) {
      const reply =
        `Sila *upload slip bayaran* ya (gambar screen shot).\n` +
        `Lepas upload, saya akan jawab “Slip diterima”.`;

      return { reply, action: "payflow_prompt_upload", meta: { payflow: true, step: "PAY_WAIT_UPLOAD" } };
    }

    // (A) simpan file dulu + set PENDING_MATCH
    await updateSlipWithFile(sb, slipId, {
      file_url: attachment.url,
      status: "PENDING_MATCH",
      created_at: nowIso()
    });

    // tutup payflow & balik OPEN (staff verify manual)
    const nextMeta = { ...(metaNow || {}) };
    nextMeta.pay_step = "PAY_WAIT_VERIFY";
    nextMeta.pay_proof_received_at = nowIso();
    nextMeta.pay_proof_file = { url: attachment.url, name: attachment.name || "slip", mime: attachment.mime || "" };

    await updateThread(sb, threadId, { status: "OPEN", meta: nextMeta });

    // ===== BACA DETAIL SLIP (auto) + TERUS ISI customer_slips =====
    let slipDetailText = "";
    let slipExtract = null;

    const mime = String(attachment.mime || "").toLowerCase();

    if (attachment.url && isProbablyImageMime(mime) && process.env.OPENAI_API_KEY) {
      try {
        const ana = await analyzeSlipWithOpenAI({ fileUrl: attachment.url, mime });
        if (ana && ana.ok && ana.data) {
          slipExtract = ana.data;
          slipDetailText = formatSlipDetails(ana.data);

          const amt = (slipExtract.amount_rm != null && isFinite(Number(slipExtract.amount_rm)))
            ? Number(slipExtract.amount_rm)
            : null;

          const dateOnly = parseDateOnlyFromAny(slipExtract.date_time);
          const refText = slipExtract.ref_no ? cleanText(slipExtract.ref_no) : null;

          // ✅ extracted_name: priority = payer_name -> other_payment_details -> notes
          const nameText =
            slipExtract.payer_name ? cleanText(slipExtract.payer_name)
              : (slipExtract.other_payment_details ? cleanText(slipExtract.other_payment_details)
                : (slipExtract.notes ? cleanText(slipExtract.notes) : null));

          const rawText = cleanText(JSON.stringify(slipExtract || {}));

          const patch2 = {};
          if (amt != null) patch2.amount_rm = amt;
          if (dateOnly) patch2.transfer_date = dateOnly;
          if (refText) patch2.reference_text = refText;
          if (nameText) patch2.extracted_name = nameText; // ✅ untuk name match engine
          if (rawText) patch2.raw_text = rawText;

          if (Object.keys(patch2).length) {
            await updateSlipWithFile(sb, slipId, patch2);
          }
        }
      } catch (_) {}
    }

    let pdfHint = "";
    if (attachment.url && isPdfMime(mime)) {
      pdfHint =
        `\n\n📎 Saya nampak cik hantar *PDF*.\n` +
        `Kalau cik nak saya *baca butiran slip secara automatik*, tolong hantar *screenshot/imej* slip tu ya (gambar lebih mudah dibaca).`;
    }

 const reply =
      `✅ Baik cik, slip bayaran telah diterima.\n` +
      `Kami akan semak & padankan bayaran (statement) ya. Terima kasih 🙏` +
      (slipDetailText || "") +
      (pdfHint || "");

    

    return {
      reply,
      action: "payflow_received_slip",
      meta: { payflow: true, slip_id: slipId, file_url: attachment.url, slip_extract: slipExtract || null }
    };
  }
  if (threadStatus.startsWith("PAY_")) {
    const displayCode = String(metaNow?.pay_order_code_display || "").trim();
    const reply =
      `Baik cik 😊\n` +
      `Bukti bayaran cik sedang diproses ya.` +
      (displayCode ? `\nOrder: *${displayCode}*` : "");

    return { reply, action: "payflow_in_progress", meta: { payflow: true, step: threadStatus } };
  }

  return { pass: true };
};