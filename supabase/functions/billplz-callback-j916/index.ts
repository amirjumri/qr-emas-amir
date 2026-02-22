// billplz-callback-j916 / index.ts
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
const XSIGN_SECRET = Deno.env.get("BILLPLZ_XSIGN_KEY_J916") || "";   // optional waktu UAT
const ENFORCE_SIG  = (Deno.env.get("ENFORCE_XSIGN") || "false").toLowerCase() === "true";

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

// ---- utils
async function hmacHex(secret: string, data: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}
const ok  = (t="OK")   => new Response(t, { headers: { ...cors, "content-type":"text/plain" }});
const bad = (t="BAD")  => new Response(t, { status:400, headers: { ...cors, "content-type":"text/plain" }});

const toBoolPaid = (v?: unknown) => {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "paid" || s === "success" || s === "yes";
};

// ---- HYBRID body reader (sama konsep Tabung)
async function readHybridBody(req: Request): Promise<Record<string, string>> {
  const raw = await req.text();                       // WAJIB: ambil raw dulu (untuk signature)
  const ct  = (req.headers.get("content-type") || "").toLowerCase();

  // 1) Billplz real: x-www-form-urlencoded
  if (ct.includes("application/x-www-form-urlencoded")) {
    const p = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    p.forEach((v,k)=> out[k]=v);
    (out as any).__raw = raw;                         // simpan untuk log
    return out;
  }

  // 2) Manual JSON
  if (ct.includes("application/json")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<string, string> = {};
      Object.entries(j).forEach(([k,v]) => out[k] = String(v ?? ""));
      (out as any).__raw = raw;
      return out;
    } catch {
      throw new Error("invalid json");
    }
  }

  // 3) Fallback: string "k=v&k2=v2"
  if (raw.includes("=")) {
    const p = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    p.forEach((v,k)=> out[k]=v);
    (out as any).__raw = raw;
    return out;
  }

  return { __raw: raw } as any;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return ok("ok");
  if (req.method !== "POST")    return new Response("ONLY_POST", { status:405, headers: cors });

  // --- Baca & verify signature (jika ON)
  let body: Record<string,string>;
  try {
    body = await readHybridBody(req);
  } catch (e) {
    return bad(String(e?.message || e));
  }
  const raw = (body as any).__raw ?? "";

  if (ENFORCE_SIG) {
    const hdr = req.headers.get("X-Signature") || req.headers.get("x-signature") || "";
    const expected = await hmacHex(XSIGN_SECRET, raw);
    if (!hdr || hdr.toLowerCase() !== expected) {
      console.warn("Invalid signature", { hdr, expected });
      return bad("invalid signature");
    }
  }

  // --- Normalise fields (alias support)
  const bill_id = String(
    body["bill_id"] || body["id"] || body["billid"] || body["billId"] || ""
  ).toLowerCase();

  const reference_1 = String(
    body["reference_1"] || body["reference"] || body["txn_id"] || body["ref1"] || ""
  ).trim();

  const paid         = toBoolPaid(body["paid"] || body["state"] || body["status"]);
  const amount_cents = Number(body["amount_cents"] ?? body["amount"] ?? 0) | 0;
  const customer_name= String(body["name"] || body["customer_name"] || "");
  const phone        = String(body["phone"] || body["reference_2"] || body["mobile"] || "");

  if (!bill_id)     return bad("MISSING_BILL_ID");
  if (!reference_1) return bad("MISSING_REFERENCE_1");

  // --- Log callback (best-effort)
  try {
    await sb.from("billplz_callback_j916").insert({
      bill_id_text: bill_id,
      reference_1,
      paid_bool: paid,
      amount_cents,
      raw_body: raw || JSON.stringify(body),
      created_at: new Date().toISOString(),
    });
  } catch {}

  // --- Jika belum paid: jangan ubah order
  if (!paid) return ok("OK (not paid)");

 // --- Update order J916 mengikut reference (boleh multi)
const refs = reference_1.split(",").map(s => s.trim()).filter(Boolean);
const nowIso = new Date().toISOString();

for (const ref of refs) {
  const { error } = await sb
    .from("j916_orders")
    .update({
      status: "PAID",
      paid_at: nowIso,
      bill_id_text: bill_id,
      amount_cents,
      pay_method: "FPX",
      customer_name,
      phone,
      updated_at: nowIso,
    })
    .eq("reference", ref)   // ✅ GANTI .eq → .ilike = case-insensitive & trimmed match
    .neq("status", "COMPLETED"); // ✅ Avoid override
  if (error) console.error("update j916_orders fail", { ref, error });
}

  return ok("OK (J916)");
});