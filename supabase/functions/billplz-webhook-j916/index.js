// billplz-webhook-j916 / index.ts
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-signature",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const XSIGN_SECRET = Deno.env.get("BILLPLZ_XSIGN_KEY_J916") || "";
const ENFORCE_SIG  = (Deno.env.get("ENFORCE_XSIGN") || "true").toLowerCase() !== "false";

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ---------- helpers ----------
async function hmacHex(secret: string, data: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
const ok  = (m="OK")  => new Response(m, { headers: { ...cors, "content-type":"text/plain" } });
const bad = (m="BAD") => new Response(m, { status:400, headers: { ...cors, "content-type":"text/plain" } });

const toBool = (v?: string|null) => {
  const s = (v||"").trim().toLowerCase();
  return s === "true" || s === "1" || s === "paid" || s === "success" || s === "yes";
};

// ===========================================================
serve(async (req) => {
  if (req.method === "OPTIONS") return ok("ok");
  if (req.method !== "POST")    return new Response("ONLY_POST", { status:405, headers: cors });

  // 1) Baca RAW body (untuk verify signature)
  const raw = await req.text();

  // 2) Verify X-Signature (optional tapi ON secara default)
  if (ENFORCE_SIG) {
    const hdr = req.headers.get("X-Signature") || req.headers.get("x-signature") || "";
    const expected = XSIGN_SECRET ? await hmacHex(XSIGN_SECRET, raw) : "";
    if (!hdr || !expected || hdr.toLowerCase() !== expected) {
      console.warn("Invalid signature", { hdr, expected });
      return bad("invalid signature");
    }
  }

  // 3) Parse x-www-form-urlencoded (format Billplz)
  const p = new URLSearchParams(raw);

  // 4) Normalise field
  const bill_id_raw  = p.get("id") || p.get("bill_id") || p.get("billid") || "";
  const bill_id      = String(bill_id_raw || "").toLowerCase();

  const reference_1  = (p.get("reference_1") || p.get("reference") || p.get("txn_id") || "").trim();
  const paid         = toBool(p.get("paid")) || toBool(p.get("state")) || toBool(p.get("status"));

  // Billplz `amount` adalah SEN (integer)
  const amount_cents = Number(p.get("amount_cents") ?? p.get("amount") ?? 0) | 0;

  const customer_name = p.get("name")  || "";
  const phone         = p.get("phone") || p.get("reference_2") || "";

  if (!bill_id)     return bad("no bill id");
  if (!reference_1) return bad("no reference_1 / txn_id");

  // 5) Log callback mentah
  try {
    await sb.from("billplz_callback_j916").insert({
      bill_id_text: bill_id,
      reference_1,
      raw_body: raw,
      paid_bool: paid,
      amount_cents,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("log billplz_callback_j916 fail", e);
  }

  // 6) Jika belum paid → berhenti
  if (!paid) return ok("OK not paid");

  // 7) Update orders mengikut reference (idempotent; tak kacau selain PENDING)
  const refs = reference_1.split(",").map(s => s.trim()).filter(Boolean);
  const now  = new Date().toISOString();

  // — update order hanya jika PENDING
  const { error: upErr } = await sb
    .from("j916_orders")
    .update({
      status: "PAID",
      paid_at: now,
      bill_id_text: bill_id,
      amount_cents,
      pay_method: "FPX",
      customer_name,
      phone,
      updated_at: now,
    })
    .in("reference", refs)
    .eq("status", "PENDING");  // <-- penting: jangan sentuh CANCEL/COMPLETED/PAID

  if (upErr) console.error("update j916_orders fail", upErr);

  // 8) Tandakan item berkaitan sebagai PAID (kalau ia sedang PENDING/AVAILABLE)
  try {
    const { data: rows, error: selErr } = await sb
      .from("j916_orders")
      .select("item_id")
      .in("reference", refs)
      .eq("status", "PAID");
    if (selErr) throw selErr;

    const itemIds = (rows || []).map(r => r.item_id).filter(Boolean);
    if (itemIds.length) {
      const { error: updItemErr } = await sb
        .from("j916_items")
        .update({ status: "PAID", updated_at: now })
        .in("id", itemIds)
        .neq("status", "PAID"); // elak overwrite kalau dah paid
      if (updItemErr) console.error("update j916_items fail", updItemErr);
    }
  } catch (e) {
    console.error("items mark paid fail", e);
  }

  return ok("OK (J916)");
});