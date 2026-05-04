// netlify/functions/match-engine.js
// Rule-based matching: customer_slips (PENDING_MATCH) <-> bank_statement_rows (unused)
// ✅ Update: guna schema baru bank_statement_rows (dc, debit_rm, credit_rm, row_no, extracted_reference)
// ✅ Match hanya CREDIT (dc='C')
// ✅ NEW: lepas MATCH, hantar WhatsApp guna OnSend
// ✅ FIX: slip.order_code Amir simpan UUID order (id) -> cari order guna (id OR order_code)
// ✅ IMPROVE: jika candidate (amount+date) hanya 1 -> auto match walau ref/name tak match
// Requires ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require("@supabase/supabase-js");

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

function isUUID(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function nowIso() {
  return new Date().toISOString();
}

function toDateOnly(s) {
  const t = String(s || "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

function dateDiffDays(a, b) {
  // a,b are YYYY-MM-DD
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  const diff = Math.round((da - db) / (24 * 3600 * 1000));
  return diff;
}

function normText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function upper(s) {
  return String(s || "").trim().toUpperCase();
}

function amount2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 100) / 100;
}

function fmtRM(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return "RM 0.00";
  return "RM " + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function strongRefMatch(slipRef, stmtRef, stmtDesc) {
  const A = digitsOnly(slipRef);
  if (A && A.length >= 6) {
    const B = digitsOnly(stmtRef);
    const C = digitsOnly(stmtDesc);
    if (B.includes(A) || C.includes(A)) return true;
  }
  // fallback text contains
  const t1 = upper(slipRef);
  if (t1 && t1.length >= 6) {
    const t2 = upper(stmtRef);
    const t3 = upper(stmtDesc);
    if (t2.includes(t1) || t3.includes(t1)) return true;
  }
  return false;
}

function strongNameMatch(slipName, stmtName, stmtDesc) {
  const a = upper(slipName).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!a || a.length < 4) return false;

  const b = upper(stmtName).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const c = upper(stmtDesc).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  // require at least 1 token (>=4 chars) appears
  const tokens = a.split(" ").filter(x => x.length >= 4).slice(0, 4);
  if (!tokens.length) return false;

  for (const t of tokens) {
    if (b.includes(t) || c.includes(t)) return true;
  }
  return false;
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

async function columnExists(sb, table, col) {
  const { data, error } = await sb
    .rpc("ea_col_exists_v1", { p_table: table, p_col: col })
    .catch(() => ({ data: null, error: "rpc_missing" }));
  if (!error && data === true) return true;
  return false;
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
   2) ORDER LOOKUP (FIX UUID vs order_code)
========================= */
async function getOrderRowByAny(sb, key) {
  const k = String(key || "").trim();
  if (!k) return null;

  // Try by id or order_code (fallback). This covers:
  // - slip.order_code = UUID order.id
  // - slip.order_code = actual order_code string
  const { data, error } = await sb
    .from("j916_orders")
    .select("id,order_code,status")
    .or(`id.eq.${k},order_code.eq.${k}`)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

    const SB_URL = process.env.SUPABASE_URL;
    const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SB_URL || !SRK) return json(500, { ok: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });

    const sb = createClient(SB_URL, SRK, { auth: { persistSession: false } });
    const payload = safeJsonParse(event.body || "{}") || {};

    const auth = await requireAdmin(sb, payload.admin_phone || payload.phone || payload.msisdn || null);
    if (!auth.ok) return json(403, { ok: false, error: auth.error });

    const limit = Number(payload.limit || 200);

    // 1) Fetch pending slips (include group/order)
    const { data: slips, error: eS } = await sb
      .from("customer_slips")
      .select("id,thread_id,customer_phone,order_code,pay_group_id,status,amount_rm,transfer_date,reference_text,extracted_name,created_at,file_url")
      .eq("status", "PENDING_MATCH")
      .order("created_at", { ascending: true })
      .limit(limit);

    if (eS) throw eS;
    const pendingSlips = Array.isArray(slips) ? slips : [];

    if (!pendingSlips.length) {
      return json(200, { ok: true, matched: 0, note: "No pending slips" });
    }

    // 2) Fetch unused statement rows (✅ ONLY CREDIT)
    const days = Number(payload.days || 7);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceISO = since.toISOString().slice(0, 10); // YYYY-MM-DD

    const { data: stmtRows, error: eR } = await sb
      .from("bank_statement_rows")
      .select("id,transaction_date,amount_rm,description,extracted_reference,extracted_name,is_used,dc,row_no,credit_rm,debit_rm")
      .eq("is_used", false)
      .eq("dc", "C") // ✅ match engine cari duit masuk sahaja
      .gte("transaction_date", sinceISO)
      .order("transaction_date", { ascending: true })
      .order("row_no", { ascending: true })
      .limit(3000);

    if (eR) throw eR;
    const unusedRows = Array.isArray(stmtRows) ? stmtRows : [];

    // Helper: load order status for slip.order_code (id OR order_code)
    async function isOrderStillPending(orderKey) {
      if (!orderKey) return true;
      const row = await getOrderRowByAny(sb, orderKey);
      if (!row) return false;
      return String(row.status || "").toUpperCase() === "PENDING";
    }

    // Helper: load group expected total
    async function getGroupExpected(groupId) {
      const { data, error } = await sb
        .from("payment_groups")
        .select("id,expected_total_rm,status")
        .eq("id", groupId)
        .maybeSingle();
      if (error || !data) return null;
      return amount2(data.expected_total_rm);
    }

    // Helper: get order short code for message
    async function getOrderDisplay(orderKey) {
      if (!orderKey) return "";
      const row = await getOrderRowByAny(sb, orderKey);
      if (!row) return String(orderKey).slice(0, 6);
      const code = String(row.order_code || row.id || orderKey);
      return code.slice(0, 6);
    }

    // attempt detect if j916_orders has payment_status/prepaid fields
    let hasPaymentStatus = true;
    let hasVerifiedAt = true;
    try {
      hasPaymentStatus = await columnExists(sb, "j916_orders", "payment_status");
      hasVerifiedAt = await columnExists(sb, "j916_orders", "payment_verified_at");
    } catch (_) {}

    // 3) Matching loop
    let matchedCount = 0;
    const matchedPairs = [];

    for (const slip of pendingSlips) {
      const slipId = slip.id;

      // Amir simpan UUID order (id) dalam customer_slips.order_code — tapi kita support dua2 (id atau order_code)
      const slipOrderKey = slip.order_code ? String(slip.order_code).trim() : null;

      const slipGroup = slip.pay_group_id && isUUID(slip.pay_group_id) ? slip.pay_group_id : null;

      // Decide target amount/date
      let targetAmount = amount2(slip.amount_rm);
      let targetDate = slip.transfer_date ? toDateOnly(slip.transfer_date) : null;

      // If slip for group and amount not stored, use expected total
      if (slipGroup && (!targetAmount || targetAmount <= 0)) {
        const exp = await getGroupExpected(slipGroup);
        if (exp && exp > 0) targetAmount = exp;
      }

      // If still no amount => cannot match
      if (!targetAmount || targetAmount <= 0) continue;

      // Rule: order must be pending (for single order)
      if (slipOrderKey) {
        const okPending = await isOrderStillPending(slipOrderKey);
        if (!okPending) continue;
      }

      // Find candidate statement rows with EXACT amount
      const candidates = unusedRows.filter(r => amount2(r.amount_rm) === targetAmount);
      if (!candidates.length) continue;

      // Filter by date ±1 if slip has date
      const dateFiltered = candidates.filter(r => {
        const d = toDateOnly(r.transaction_date);
        if (!d) return false;
        if (targetDate) {
          const dd = Math.abs(dateDiffDays(d, targetDate));
          return dd <= 1;
        }
        return true;
      });

      const pool = dateFiltered.length ? dateFiltered : candidates;

      // NEW SAFETY: kalau pool cuma 1 row (amount+date match) -> auto match
      const slipRef = normText(slip.reference_text || "");
      const slipName = normText(slip.extracted_name || "");

      let best = null;

      if (pool.length === 1) {
        best = { row: pool[0], score: 1, refOk: false, nameOk: false, auto: "unique_amount_date" };
      } else {
        // Strong indicator: reference OR name match (at least one) — untuk kes multiple candidates sahaja
        for (const r of pool) {
          const stmtRef = normText(r.extracted_reference || "");
          const stmtDesc = normText(r.description || "");
          const stmtName = normText(r.extracted_name || "");

          const refOk = slipRef ? strongRefMatch(slipRef, stmtRef, stmtDesc) : false;
          const nameOk = slipName ? strongNameMatch(slipName, stmtName, stmtDesc) : false;

          if (!(refOk || nameOk)) continue;

          // score to choose best if multiple
          const d = toDateOnly(r.transaction_date);
          const dd = (targetDate && d) ? Math.abs(dateDiffDays(d, targetDate)) : 0;

          // bonus kecil untuk row_no kecil
          const rowNo = Number.isFinite(Number(r.row_no)) ? Number(r.row_no) : 9999;

          const score =
            (refOk ? 100 : 0) +
            (nameOk ? 40 : 0) -
            (dd * 5) -
            Math.min(10, Math.floor(rowNo / 10));

          if (!best || score > best.score) best = { row: r, score, refOk, nameOk };
        }

        // kalau masih tak jumpa best, jangan match (kes amount sama banyak kali)
        if (!best) continue;
      }

      const stmt = best.row;

      // resolve order row (for storing matched_order_code + updating order)
      let orderRow = null;
      if (slipOrderKey) {
        orderRow = await getOrderRowByAny(sb, slipOrderKey);
        if (!orderRow) continue; // safety: order mesti wujud
      }

      const matchedAt = nowIso();

      // Decide what to store into bank_statement_rows.matched_order_code
      // - Prefer actual order_code if available
      const matchedOrderCodeValue = orderRow
        ? String(orderRow.order_code || orderRow.id || slipOrderKey)
        : null;

      // a) mark statement row used
      await sb
        .from("bank_statement_rows")
        .update({
          is_used: true,
          matched_order_code: matchedOrderCodeValue,
          matched_slip_id: slipId,
          matched_group_id: slipGroup,
          matched_at: matchedAt,
        })
        .eq("id", stmt.id);

      // b) update slip
      await sb
        .from("customer_slips")
        .update({
          status: "MATCHED",
          matched_statement_row_id: stmt.id,
          matched_at: matchedAt,
        })
        .eq("id", slipId);

      // c) update group if exists
      if (slipGroup) {
        await sb
          .from("payment_groups")
          .update({
            status: "MATCHED",
            matched_statement_row_id: stmt.id,
            matched_at: matchedAt,
          })
          .eq("id", slipGroup);
      }

      // d) update order if single order
      if (orderRow && orderRow.id) {
        const patch = {};
        if (hasPaymentStatus) patch.payment_status = "PREPAID";
        if (hasVerifiedAt) patch.payment_verified_at = matchedAt;

        if (Object.keys(patch).length) {
          // ✅ update by id (most correct)
          const r1 = await sb.from("j916_orders").update(patch).eq("id", orderRow.id);
          if (r1?.error && String(r1.error.message || "").toLowerCase().includes("column")) {}
        }
      }

      // remove matched stmt from unusedRows pool to prevent reuse in same run
      const idx = unusedRows.findIndex(x => x.id === stmt.id);
      if (idx >= 0) unusedRows.splice(idx, 1);

      matchedCount += 1;

      // ✅ NEW: WhatsApp notify customer (sekali sahaja sebab slip dah jadi MATCHED)
      const custPhone = normalize60(slip.customer_phone || "");
      if (custPhone) {
        const shortOrder = slipOrderKey
          ? await getOrderDisplay(slipOrderKey)
          : (slipGroup ? String(slipGroup).slice(0, 6) : "");

        const msgWA =
          `✅ Pembayaran diterima.\n\n` +
          (shortOrder ? `Order: *${shortOrder}*\n` : ``) +
          `Jumlah: *${fmtRM(targetAmount)}*\n` +
          `Tarikh: ${stmt.transaction_date || "-"}\n\n` +
          `Terima kasih 🙏 Kami akan teruskan proses pesanan cik.`;

        await sendWA(event, custPhone, msgWA, { file_url: slip.file_url || "", file_name: "slip" });
      }

      matchedPairs.push({
        slip_id: slipId,
        statement_row_id: stmt.id,
        order_key: slipOrderKey,
        matched_order_code: matchedOrderCodeValue,
        pay_group_id: slipGroup,
        amount_rm: targetAmount,
        tx_date: stmt.transaction_date,
        row_no: stmt.row_no ?? null,
        score: best.score,
        ref_ok: !!best.refOk,
        name_ok: !!best.nameOk,
        auto: best.auto || null
      });
    }

    return json(200, { ok: true, matched: matchedCount, pairs: matchedPairs });
  } catch (e) {
    console.error("match-engine error:", e);
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};