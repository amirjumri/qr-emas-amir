// deno run -A main.ts   (Supabase Edge Function)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/* ====================== Helpers ====================== */

// Balas tepat "OK" (text/plain)
function ok() {
  return new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
}

// Parse x-www-form-urlencoded
function parseFormURLEncoded(raw: string) {
  const p = new URLSearchParams(raw);
  const obj: Record<string, string> = {};
  for (const [k, v] of p.entries()) obj[k] = v;
  return obj;
}

// Ambil amaun (string/number) → sen (int)
// - Bersih: buang huruf (MYR), spasi, koma. Kekalkan titik perpuluhan
function toCentsLoose(val: unknown): number | null {
  if (val == null) return null;
  let s = String(val).trim();
  if (!s) return null;
  // "MYR 2,345.60" -> "2345.60"
  s = s.replace(/[a-zA-Z]/g, "").replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// Cuba baca amaun daripada pelbagai nama field SenangPay
function extractAmountCents(body: Record<string, unknown>): number | null {
  const candidates = [
    "amount", "amount_cents", "total", "price", "grand_total", "grandtotal",
    "transaction_amount", "transactionAmount", "amount_paid", "paid_amount",
    "order_amount"
  ];
  for (const key of candidates) {
    if (body[key] != null) {
      const c = toCentsLoose(body[key]);
      if (c != null) return c;
    }
  }
  return null;
}

/* ====================== Server ====================== */

serve(async (req) => {
  // SenangPay caller: kita tetap balas OK walaupun method pelik — elak retry
  if (req.method !== "POST") return ok();

  try {
    // 1) Baca body (JSON atau FORM)
    const raw = await req.text();
    let body: Record<string, any> = {};
    try {
      if (raw.trim().startsWith("{")) body = JSON.parse(raw);
      else body = parseFormURLEncoded(raw);
    } catch {
      body = parseFormURLEncoded(raw);
    }

    // 2) Medan penting
    const statusId      = body.status_id ?? body.statusId ?? body.status ?? "";
    const orderRefRaw   = body.order_id  ?? body.orderId  ?? body.order_code ?? body.orderRef ?? "";
    const transactionId = body.transaction_id ?? body.txn ?? body.transactionId ?? "";
    const msg           = body.msg ?? body.message ?? "";
    const paid          = String(statusId) === "1";

    // Boleh banyak ID dipisahkan koma
    const ids = String(orderRefRaw || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);

    // Tiada order_id → tetap balas OK (biar SP tak retry)
    if (!ids.length) {
      console.warn("[SP] missing order_id. Raw:", body);
      return ok();
    }

    // 3) Setup Supabase (service role)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 4) Cuba dapatkan amount_cents daripada payload
    let amount_cents: number | null = extractAmountCents(body);

    // 5) Fallback: jika masih null, kira dari j916_orders (unit_rm * qty) untuk semua id
    if (amount_cents == null) {
      const { data: rows, error } = await supabase
        .from("j916_orders")
        .select("unit_rm, qty")
        .in("reference", ids);

      if (!error && rows?.length) {
        let sum = 0;
        for (const r of rows) {
          const unit = Number(r.unit_rm || 0);
          const qty  = Number(r.qty || 0);
          sum += unit * qty;
        }
        amount_cents = Math.round(sum * 100);
        console.info("[SP] amount_cents fallback from j916_orders =", amount_cents);
      } else if (error) {
        console.warn("[SP] fallback query error:", error);
      }
    }

    // 6) Payload kemas kini asas (UNTUK j916 — KEKAL ADA pay_method)
    const updateBase: Record<string, any> = {
      status: paid ? "PAID" : "PENDING",
      pay_method: "senangpay",
      paid_at: paid ? new Date().toISOString() : null,
      bill_id_text: transactionId || msg || null,
    };
    if (amount_cents != null) updateBase.amount_cents = amount_cents;

    // 7) Update j916_orders (cuba by reference → reference_1 → id), elak overwrite PAID
    async function updateJ916By(col: "reference" | "reference_1" | "id") {
      const { data, error } = await supabase
        .from("j916_orders")
        .update(updateBase)
        .in(col, ids)
        .eq("status", "PENDING")
        .select(col);
      if (error) {
        console.error(`[SP] j916 update by ${col} error:`, error);
        return [] as string[];
      }
      const touched = (data ?? []).map((r: any) => String(r[col]));
      if (touched.length) console.info(`[SP] j916 updated by ${col}:`, touched);
      return touched;
    }
    let touched: string[] = [];
    touched = touched.concat(await updateJ916By("reference"));
    if (!touched.length) touched = touched.concat(await updateJ916By("reference_1"));
    if (!touched.length) touched = touched.concat(await updateJ916By("id"));

    // 8) Update goldbar_order (TANPA pay_method) — padan reference_1, elak overwrite PAID
    const gbUpdate: Record<string, any> = {
      status: paid ? "PAID" : "PENDING",
      paid_at: paid ? new Date().toISOString() : null,
      bill_id_text: transactionId || msg || null,
    };
    if (amount_cents != null) gbUpdate.amount_cents = amount_cents;

    const { data: gbRows, error: gbErr } = await supabase
      .from("goldbar_order")
      .update(gbUpdate)              // <<< penting: JANGAN guna updateBase
      .in("reference_1", ids)       // goldbar guna reference_1
      .eq("status", "PENDING")      // jangan sentuh yang dah PAID
      .select("reference_1");

    if (gbErr) console.error("[SP] goldbar update error:", gbErr);
    else if (gbRows?.length) console.info("[SP] goldbar updated:", gbRows.map((r: any) => r.reference_1));

    // 9) (Opsyenal) log
    try {
      await supabase.from("webhook_logs").insert({
        source: "senangpay",
        status_id: String(statusId),
        order_ids: ids.join(","),
        transaction_id: transactionId || null,
        amount_cents,
        raw_json: body,
        ok: true,
      } as any);
    } catch { /* abaikan jika tiada jadual */ }

    // 10) Sentiasa balas OK supaya SenangPay puas hati
    return ok();

  } catch (e) {
    console.error("[SP] exception:", e);
    return ok(); // tetap OK, jangan bagi retry
  }
});