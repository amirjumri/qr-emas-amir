// netlify/functions/admin-bank-upload.js
// Admin upload bank statement image/pdf -> AI extract rows -> insert bank_statement_rows
// Requires ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
// Optional ENV: BANK_BUCKET (default "bank-statements"), OPENAI_MODEL (default "gpt-4.1-mini")

const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const crypto = require("crypto");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function isUUID(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function normalize60(msisdn) {
  const d = digitsOnly(msisdn);
  if (!d) return null;
  if (d.startsWith("60")) return d;
  if (d.startsWith("0")) return "6" + d;
  return "60" + d;
}

function nowIso() {
  return new Date().toISOString();
}

function pickAttachment(payload) {
  const a0 = Array.isArray(payload.attachments) ? payload.attachments[0] : null;
  if (a0 && (a0.url || a0.base64)) {
    return {
      url: a0.url || null,
      base64: a0.base64 || null,
      name: a0.name || "statement",
      mime: a0.mime || "application/octet-stream",
    };
  }

  const url = payload.file_url || payload.image_url || payload.attachment_url || null;
  if (url) return { url, base64: null, name: "statement", mime: "application/octet-stream" };

  const base64 = payload.file_base64 || payload.base64 || null;
  if (base64) {
    return {
      url: null,
      base64,
      name: payload.file_name || payload.filename || "statement",
      mime: payload.file_mime || payload.mime || "application/octet-stream",
    };
  }

  return null;
}

function isPdfMime(mime) {
  const m = String(mime || "").toLowerCase();
  return m === "application/pdf" || m.includes("pdf");
}

async function uploadBase64(sb, bucket, path, base64, mime) {
  let b64 = String(base64 || "");
  const m = b64.match(/^data:([^;]+);base64,(.*)$/i);
  if (m) {
    mime = mime || m[1];
    b64 = m[2];
  }
  const buf = Buffer.from(b64, "base64");

  const { error } = await sb.storage.from(bucket).upload(path, buf, {
    contentType: mime || "application/octet-stream",
    upsert: true,
  });
  if (error) throw error;

  const { data: pub } = sb.storage.from(bucket).getPublicUrl(path);
  return pub?.publicUrl || null;
}

function toDateOnly(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

function normText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function coerceAmount(n) {
  if (n === null || n === undefined || n === "") return null;
  // support "RM345.00", "345.00", "2,474.00"
  let s = String(n).trim();
  s = s.replace(/rm/ig, "");
  s = s.replace(/,/g, "");
  s = s.replace(/[^\d.]+/g, "");
  if (!s) return null;
  const x = Number(s);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function toInt(v) {
  const n = parseInt(String(v || "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function hashRowKey(obj) {
  // hash untuk dedupe dalam satu upload
  const s = [
    obj.transaction_date || "",
    String(obj.debit_rm ?? ""),
    String(obj.credit_rm ?? ""),
    (obj.description || "").toUpperCase().replace(/\s+/g, " ").trim(),
    (obj.reference_found || "").toUpperCase().replace(/\s+/g, " ").trim(),
  ].join("|");

  return crypto.createHash("sha1").update(s).digest("hex");
}

async function requireAdmin(sb, adminPhoneRaw) {
  const phone = normalize60(adminPhoneRaw);
  if (!phone) return { ok: false, error: "Missing admin phone" };

  const { data, error } = await sb
    .from("admin_users")
    .select("phone,is_active")
    .eq("phone", phone)
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) return { ok: false, error: "Access denied (not admin)" };
  return { ok: true, phone };
}

/**
 * AI extraction:
 * - Extract rows with BOTH debit & credit (OCR lebih stabil)
 * - MUST preserve order top-to-bottom: row_no 1..N
 *
 * return array rows:
 * [
 *  {
 *    row_no: 1,
 *    transaction_date:"YYYY-MM-DD",
 *    description:"...",
 *    debit_rm: number|null,
 *    credit_rm: number|null,
 *    reference_found:"..."|null,
 *    extracted_name:"..."|null
 *  }
 * ]
 */
async function extractStatementRows(openai, fileUrl, hintDate) {
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const system =
`Anda extractor penyata bank Malaysia. Tugas:
- Baca imej penyata bank / statement yang ada SENARAI transaksi (table).
- Extract SETIAP baris transaksi yang nampak.
- PENTING: KELUARKAN ikut TURUTAN yang muncul dalam gambar (atas -> bawah).
- Wajib letak "row_no" bermula 1,2,3... mengikut turutan atas->bawah.
- Output JSON SAHAJA (tanpa markdown) format:
{
  "rows":[
    {
      "row_no": 1,
      "transaction_date":"YYYY-MM-DD",
      "description":"text",
      "debit_rm": null,
      "credit_rm": 345.00,
      "reference_found":"text_or_null",
      "extracted_name":"text_or_null"
    }
  ]
}

Rules penting:
- transaction_date MESTI YYYY-MM-DD.
  - Jika statement guna format "3-Mar-2026" / "03 Mar 2026", tukar ke "2026-03-03".
  - Jika tarikh tak jelas, guna hint statement_date.
- debit_rm/credit_rm: nombor RM 2 decimal atau null.
  - Jika kolum kosong, letak null.
  - Jika ada "RM2,474.00" keluarkan 2474.00.
- description: ambil teks Description (ringkas tapi lengkap).
- reference_found: apa-apa nombor rujukan/Ref/Receipt/ID/FPX/Atome/Transaction id yang nampak dalam baris (kalau ada).
- extracted_name: nama pengirim/penerima jika jelas dalam description (contoh "Qairawanis", "NOR ATIKAH..."). Kalau tak pasti, null.
- Jangan reka data. Kalau tak nampak, null.
- Elak duplicate baris yang sama (kalau nampak dua kali dalam gambar).`;

  const user =
`Ini URL fail statement: ${fileUrl}
Hint statement_date (fallback): ${hintDate || "null"}

Sila extract semua baris transaksi dalam gambar (table) ikut turutan atas->bawah.`;

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: fileUrl } }
        ]
      }
    ],
  });

  const txt = resp?.choices?.[0]?.message?.content || "";
  const obj = safeJsonParse(txt);
  const rows = Array.isArray(obj?.rows) ? obj.rows : [];

  // normalize: ensure row_no numeric if possible
  const normalized = rows.map(r => ({
    row_no: toInt(r?.row_no),
    transaction_date: r?.transaction_date,
    description: r?.description,
    debit_rm: r?.debit_rm,
    credit_rm: r?.credit_rm,
    reference_found: r?.reference_found,
    extracted_name: r?.extracted_name,
    amount_rm: r?.amount_rm, // fallback support
  }));

  // sort by row_no if exists; else keep as-is
  const hasAnyRowNo = normalized.some(x => x.row_no !== null);
  if (hasAnyRowNo) {
    normalized.sort((a, b) => {
      const ra = a.row_no ?? 999999;
      const rb = b.row_no ?? 999999;
      return ra - rb;
    });
  }

  return normalized;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

    const SB_URL = process.env.SUPABASE_URL;
    const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OAI = process.env.OPENAI_API_KEY;
    const BANK_BUCKET = process.env.BANK_BUCKET || "bank-statements";

    if (!SB_URL || !SRK) return json(500, { ok: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    if (!OAI) return json(500, { ok: false, error: "Missing OPENAI_API_KEY" });

    const sb = createClient(SB_URL, SRK, { auth: { persistSession: false } });
    const openai = new OpenAI({ apiKey: OAI });

    const payload = safeJsonParse(event.body || "{}") || {};
    const admin_phone = payload.admin_phone || payload.phone || payload.msisdn || null;
    const source_bank = normText(payload.source_bank || payload.bank || "MAYBANK");
    const statement_date = toDateOnly(payload.statement_date || payload.ddate || "") || null;

    const auth = await requireAdmin(sb, admin_phone);
    if (!auth.ok) return json(403, { ok: false, error: auth.error });

    const attachment = pickAttachment(payload);
    if (!attachment) return json(400, { ok: false, error: "No file uploaded (attachment missing)" });

    // 1) create upload record first
    const { data: up, error: eUp } = await sb
      .from("bank_statement_uploads")
      .insert({
        uploaded_by_phone: auth.phone,
        file_url: null,
        source_bank,
        statement_date,
        extracted_ok: false,
        extract_error: null,
        created_at: nowIso(),
      })
      .select("id")
      .maybeSingle();

    if (eUp) throw eUp;
    const uploadId = up?.id;
    if (!isUUID(uploadId)) throw new Error("upload_id not created");

    // 2) store file (prefer URL if already public)
    let fileUrl = attachment.url || null;
    const fileMime = attachment.mime || "application/octet-stream";

    if (!fileUrl && attachment.base64) {
      const ext =
        (fileMime || "").includes("pdf") ? "pdf" :
        (fileMime || "").includes("png") ? "png" :
        (fileMime || "").includes("jpeg") ? "jpg" :
        (fileMime || "").includes("jpg") ? "jpg" :
        "bin";

      const path = `statements/${statement_date || "unknown"}/${uploadId}.${ext}`;
      fileUrl = await uploadBase64(sb, BANK_BUCKET, path, attachment.base64, fileMime);
    }

    // update upload file url
    const { error: eUp2 } = await sb
      .from("bank_statement_uploads")
      .update({ file_url: fileUrl })
      .eq("id", uploadId);

    if (eUp2) throw eUp2;

    // 2.5) If PDF -> minta screenshot (vision PDF tak stabil)
    if (isPdfMime(fileMime)) {
      await sb
        .from("bank_statement_uploads")
        .update({
          extracted_ok: false,
          extract_error: "PDF uploaded. Please upload statement screenshots/images for extraction."
        })
        .eq("id", uploadId);

      return json(200, {
        ok: false,
        upload_id: uploadId,
        file_url: fileUrl,
        error: "PDF tidak terus dibaca.",
        hint: "Tolong upload screenshot/imej statement (gambar table debit/credit) untuk extract automatik."
      });
    }

    // 3) AI extract rows (ikut turutan atas->bawah)
    let rows = [];
    try {
      rows = await extractStatementRows(openai, fileUrl, statement_date);
    } catch (aiErr) {
      await sb
        .from("bank_statement_uploads")
        .update({ extracted_ok: false, extract_error: String(aiErr?.message || aiErr) })
        .eq("id", uploadId);

      return json(200, {
        ok: false,
        upload_id: uploadId,
        file_url: fileUrl,
        error: "AI extract failed",
        detail: String(aiErr?.message || aiErr)
      });
    }

    // 4) normalize + insert rows
    //    ✅ kita simpan DEBIT+KREDIT untuk stabilkan OCR,
    //    ✅ tapi yang masuk ke bank_statement_rows kekal CREDIT sahaja (duit masuk) macam flow match Amir
    //    ✅ dedupe sebelum insert (elak dua kali)
 const clean = [];
const seen = new Set();
let idx = 0;

for (const r of rows) {
  const d = toDateOnly(r?.transaction_date) || statement_date || null;
  if (!d) { idx++; continue; }

  const rowNo = toInt(r?.row_no) ?? (idx + 1);
  const debit = coerceAmount(r?.debit_rm);
  const credit = coerceAmount(r?.credit_rm);

  // fallback untuk model lama (amount_rm) — kalau ada amount dan tiada debit/credit
  const fallbackAmount = coerceAmount(r?.amount_rm);
  const creditFinal = (credit !== null ? credit : null);
  const debitFinal  = (debit !== null ? debit : null);

  const hasMoney =
    (creditFinal !== null && creditFinal > 0) ||
    (debitFinal !== null && debitFinal > 0) ||
    (fallbackAmount !== null && fallbackAmount > 0);

  if (!hasMoney) { idx++; continue; }

  // kalau fallbackAmount wujud dan credit null & debit null -> anggap credit
  const creditStore =
    (creditFinal !== null ? creditFinal :
      (debitFinal === null && fallbackAmount !== null ? fallbackAmount : null)
    );

  const debitStore =
    (debitFinal !== null ? debitFinal : null);

  const desc = normText(r?.description || "");
  const ref = normText(r?.reference_found || r?.extracted_reference || "") || null;
  const name = normText(r?.extracted_name || "") || null;

  const rowKey = hashRowKey({
    transaction_date: d,
    debit_rm: debitStore,
    credit_rm: creditStore,
    description: desc,
    reference_found: ref,
  });

  if (seen.has(rowKey)) { idx++; continue; }
  seen.add(rowKey);

  clean.push({
    upload_id: uploadId,
    row_no: rowNo,
    transaction_date: d,
    debit_rm: debitStore,
    credit_rm: creditStore,

    // kalau Amir nak kekal amount_rm untuk “duit masuk”, boleh biar null/creditStore.
    amount_rm: (creditStore !== null ? creditStore : (debitStore !== null ? debitStore : 0)),
dc: (creditStore !== null ? "C" : "D"), 

    description: desc,
    extracted_reference: ref,
    extracted_name: name,

    is_used: false,
    matched_order_code: null,
    matched_slip_id: null,
    matched_group_id: null,
    matched_at: null,
    created_at: nowIso(),
  });

  if (clean.length >= 600) break;
  idx++;
}

    if (clean.length) {
      const { error: eIns } = await sb.from("bank_statement_rows").insert(clean);
      if (eIns) throw eIns;
    }

    await sb
      .from("bank_statement_uploads")
      .update({ extracted_ok: true, extract_error: null })
      .eq("id", uploadId);

    return json(200, {
      ok: true,
      upload_id: uploadId,
      file_url: fileUrl,
      inserted_rows: clean.length,
    });
  } catch (e) {
    console.error("admin-bank-upload error:", e);
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};