// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function txt(body: string, status = 200) {
  return new Response(body, { status, headers: { ...cors, "content-type": "text/plain" } });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BILLPLZ_XSIGN_KEY_J916 = Deno.env.get("BILLPLZ_XSIGN_KEY_J916")!;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// HMAC SHA-256 (hex) — digunakan untuk verify X-Signature
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
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// Billplz hantar form-encoded. Kita tetap sokong JSON untuk testing sahaja.
function toObjectFromRaw(raw: string, req: Request): Record<string, string> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  const p = new URLSearchParams(raw);
  return Object.fromEntries(p.entries());
}

function toBoolPaid(v?: string) {
  const s = (v || "").toLowerCase().trim();
  return s === "true" || s === "paid" || s === "1" || s === "success" || s === "yes";
}

serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST")    return txt("Method not allowed", 405);
    if (!BILLPLZ_XSIGN_KEY_J916)  return txt("Missing BILLPLZ_XSIGN_KEY_J916", 500);

    // 1) Ambil raw body & verify X-Signature (WAJIB ikut Billplz)
    const raw = await req.text();
    const sigHdr = req.headers.get("X-Signature") || req.headers.get("x-signature") || "";
    const expected = await hmacHex(BILLPLZ_XSIGN_KEY_J916, raw);
    if (!sigHdr || sigHdr.toLowerCase() !== expected) {
      console.warn("Invalid X-Signature", { sigHdr, expected });
      return txt("Invalid signature", 400);
    }

    // 2) Parse payload → normalise key penting
    const body = toObjectFromRaw(raw, req);

    const paid =
      toBoolPaid(body["paid"]) ||
      (body["state"] || "").toLowerCase() === "paid" ||
      (body["status"] || "").toLowerCase() === "completed";

    // Bill ID (Billplz hantar sebagai "id")
    const billIdRaw =
      body["id"] || body["bill_id"] || body["billid"] || body["billId"] || "";
    const billId = String(billIdRaw || "").toLowerCase();

    // Reference 1 (kita guna untuk order uuid; boleh multi, comma-separated)
    const ref1 =
      body["reference_1"] || body["reference"] || body["ref1"] || body["txn_id"] || "";

    // Amount (sen)
    const amountCents = Number(
      body["amount_cents"] ??
      (body["amount"] ? Math.round(Number(body["amount"]) * 100) : 0)
    ) | 0;

    const name  = body["name"]  || body["customer_name"] || "";
    const phone = body["phone"] || body["mobile"] || body["reference_2"] || "";

    if (!billId) return txt("no bill id", 400);
    if (!ref1)   return txt("no reference", 400);

    // 3) J916 processing
    const refs = ref1.split(",").map(s => s.trim()).filter(Boolean);
    if (!refs.length) return txt("no reference", 400);

    if (!paid) {
      // Jika bukan paid, tandakan FAILED untuk rujukan berkenaan (optional)
      try {
        await sb.from("j916_orders")
          .update({ status: "FAILED", bill_id_text: billId, updated_at: new Date().toISOString() })
          .in("reference", refs);
      } catch (e) {
        console.warn("mark FAILED error:", e);
      }
      return txt("OK (not paid)");
    }

    // Paid: call RPC untuk setiap reference
    const errs: any[] = [];
    for (const ref of refs) {
      const { error } = await sb.rpc("j916_order_mark_paid_v1", {
        p_reference: ref,
        p_bill_id_text: billId,
        p_method: "FPX",
        p_amount_cents: amountCents,
        p_customer_name: name,
        p_phone: phone,
      });
      if (error) {
        console.error("RPC j916_order_mark_paid_v1 failed:", { ref, error });
        errs.push({ ref, error: String(error?.message || error) });
      }
    }

    if (errs.length) return txt("Partial OK (some failed)", 207);
    return txt("OK");
  } catch (e: any) {
    console.error("Webhook J916 error:", e);
    return txt("Error: " + (e?.message || String(e)), 400);
  }
});