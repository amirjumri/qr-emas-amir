// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-signature",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Per-environment keys for j999
const XSIGN_SECRET = Deno.env.get("BILLPLZ_XSIGN_KEY_J999") || "";
const ENFORCE_SIG = (Deno.env.get("ENFORCE_XSIGN") || "true").toLowerCase() !== "false";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// helpers
const ok = (m = "OK") =>
  new Response(m, { headers: { ...CORS, "content-type": "text/plain" } });
const bad = (m = "BAD") =>
  new Response(m, { status: 400, headers: { ...CORS, "content-type": "text/plain" } });

const toBool = (v?: string | null) => {
  const s = (v || "").toString().trim().toLowerCase();
  return s === "true" || s === "1" || s === "paid" || s === "success" || s === "yes";
};

async function hmacHex(secret: string, data: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseFormUrlencoded(raw: string) {
  const p = new URLSearchParams(raw);
  const obj: Record<string, any> = {};
  for (const [k, v] of p.entries()) obj[k] = v;
  return obj;
}

function toCentsFromPossible(body: any) {
  // billplz may send amount_cents (int) OR amount (RM as string/float)
  if (body.amount_cents != null && String(body.amount_cents).trim() !== "") {
    const n = Number(body.amount_cents);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (body.amount != null && String(body.amount).trim() !== "") {
    const n = Number(body.amount);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  // maybe sent as amount_rm or total
  if (body.amount_rm != null) {
    const n = Number(body.amount_rm);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  return 0;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return ok("ok");
  if (req.method !== "POST") return new Response("ONLY_POST", { status: 405, headers: CORS });

  // read raw body (for signature check and for parsing form)
  const raw = await req.text();

  // verify signature if enforced
  if (ENFORCE_SIG) {
    const hdr = req.headers.get("X-Signature") || req.headers.get("x-signature") || "";
    const expected = XSIGN_SECRET ? await hmacHex(XSIGN_SECRET, raw) : "";
    if (!hdr || !expected || hdr.toLowerCase() !== expected) {
      console.warn("[j999] invalid signature", { hdr, expected });
      return bad("invalid signature");
    }
  }

  // parse body: detect content-type
  const ct = (req.headers.get("content-type") || "").split(";")[0].trim();
  let body: any = {};
  if (ct === "application/x-www-form-urlencoded" || raw.includes("=")) {
    try { body = parseFormUrlencoded(raw); } catch (e) { body = {}; }
  } else {
    try { body = JSON.parse(raw || "{}"); } catch (e) { body = {}; }
  }

  // Normalise fields (common keys)
  const bill_id_raw = String(body.id || body.bill_id || body.billid || "").trim();
  const bill_id = bill_id_raw ? bill_id_raw.toLowerCase() : "";
  const referenceRaw = (body.reference_1 || body.reference || body.txn_id || body.reference1 || "") + "";
  const references = String(referenceRaw).split(",").map((s) => s.trim()).filter(Boolean);

  const paid = toBool(String(body.paid || body.state || body.status || ""));
  const amount_cents = toCentsFromPossible(body);

  const customer_name = (body.name || body.customer_name || body.payer_name || "") + "";
  const phone = (body.phone || body.customer_phone || body.reference_2 || "") + "";

  if (!bill_id) return bad("no bill id");
  if (!references.length) return bad("no reference_1 / txn_id");

  // log the callback to callback table (best-effort)
  try {
    await sb.from("billplz_callback_goldbar").insert({
      bill_id_text: bill_id,
      reference_1: references.join(","),
      raw_body: raw,
      paid_bool: paid,
      amount_cents,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[j999] insert callback log failed", e);
    // do not abort; continue
  }

  // if not paid -> return early (we still logged)
  if (!paid) return ok("OK not paid");

  // For each reference, best-effort update order
  const now = new Date().toISOString();
  for (const ref of references) {
    if (!ref) continue;

    try {
      // read existing order (to compare total and set amount_mismatch)
      const sel = await sb
        .from("goldbar_order")
        .select("id, reference_1, total_rm, status")
        .eq("reference_1", ref)
        .limit(1)
        .maybeSingle();

      let expected_cents: number | null = null;
      if (sel && sel.data) {
        const t = sel.data.total_rm;
        expected_cents = (t != null && t !== "") ? Math.round(Number(t) * 100) : null;
      }

      const amount_mismatch = (expected_cents != null) ? (expected_cents !== amount_cents) : null;

      // update fields
      const updateData: any = {
        status: "PAID",
        paid_at: now,
        bill_id_text: bill_id,
        amount_cents,
        pay_method: "FPX",
        customer_name: customer_name || undefined,
        phone: phone || undefined,
        updated_at: now,
      };

      if (amount_mismatch !== null) updateData.amount_mismatch = amount_mismatch;

      // Only update rows that are not COMPLETED (best-effort)
      const { error: updErr } = await sb
        .from("goldbar_order")
        .update(updateData)
        .eq("reference_1", ref)
        .neq("status", "COMPLETED");

      if (updErr) {
        console.error("[j999] update goldbar_order failed", { ref, updErr });
      } else {
        console.log("[j999] updated goldbar_order", { ref, bill_id, amount_cents, amount_mismatch });
      }
    } catch (e) {
      console.error("[j999] exception updating order", { ref, e });
    }
  }

  return ok("OK (J999)");
});