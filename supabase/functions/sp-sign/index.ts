// supabase/functions/sp-sign/index.ts
// ✅ Versi BETUL (COPY–PASTE TERUS)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

/* =================================
   Konfigurasi melalui Secret (ENV)
   ================================= */
const MERCHANT_ID = Deno.env.get("SENANGPAY_MERCHANT_ID") ?? "";
const SECRET_KEY  = Deno.env.get("SENANGPAY_SECRET_KEY") ?? "";
const SP_BASE     = (Deno.env.get("SP_BASE") ?? "").replace(/\/+$/,"") + "/";
const RETURN_URL  = Deno.env.get("RETURN_URL") ?? ""; // fallback jika client tak hantar

/* =================================
   Utiliti
   ================================= */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json; charset=utf-8",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}
function badRequest(msg: string) {
  return json(400, { ok: false, error: msg });
}

function toAmount2(n: unknown): string | null {
  const num = Number(n);
  if (!isFinite(num)) return null;
  return num.toFixed(2);
}

async function hmacSha256Hex(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

const enc = encodeURIComponent;

/* =================================
   Handler
   ================================= */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST")    return badRequest("ONLY_POST_ALLOWED");

  try {
    if (!MERCHANT_ID || !SECRET_KEY || !SP_BASE) {
      return json(500, { ok: false, error: "CONFIG_MISSING" });
    }

    const body = await req.json().catch(() => ({}));

    const detail       = String(body.detail ?? "").trim() || "Checkout";
    const amountS      = toAmount2(body.amount);
    const order_id_in  = String(body.order_id ?? body.orderid ?? body.order ?? "").trim();
    const name         = String(body.name  ?? "").trim() || "Customer";
    const email        = String(body.email ?? "").trim() || "customer@example.com";
    const phone        = String(body.phone ?? "").trim();

    // ✅ AMBIL return_url client DULU – jika kosong baru fallback ENV
    const returnUrlIn =
      String(body.return_url ?? body.redirect_url ?? "").trim()
      || String(RETURN_URL || "").trim();

    if (!amountS)               return badRequest("INVALID_AMOUNT");
    if (Number(amountS) < 2.00) return badRequest("MIN_AMOUNT_2");
    if (!order_id_in)           return badRequest("MISSING_ORDER_ID");
    if (!phone)                 return badRequest("MISSING_PHONE");

    const signingStr = SECRET_KEY + detail + amountS + order_id_in;
    const hash = await hmacSha256Hex(signingStr, SECRET_KEY);

    let url = `${SP_BASE}${MERCHANT_ID}?`
      + `detail=${enc(detail)}`
      + `&amount=${enc(amountS)}`
      + `&order_id=${enc(order_id_in)}`
      + `&orderid=${enc(order_id_in)}`
      + `&name=${enc(name)}`
      + `&email=${enc(email)}`
      + `&phone=${enc(phone)}`
      + `&hash=${enc(hash)}`;

    // ✅ SenangPay expect field: return_url
    if (returnUrlIn) {
      url += `&return_url=${enc(returnUrlIn)}`;
    }

    console.log("[SP-SIGN] PAY URL →", url);

    return json(200, { ok: true, pay_url: url });

  } catch (err) {
    return json(500, { ok: false, error: "SERVER_ERROR", message: String(err?.message || err) });
  }
});