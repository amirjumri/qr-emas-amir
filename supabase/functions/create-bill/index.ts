import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

function asNum(x: any): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function asStr(x: any): string {
  return typeof x === "string" ? x : (x == null ? "" : String(x));
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const BILLPLZ_API_KEY = Deno.env.get("BILLPLZ_API_KEY")!;
  const BILLPLZ_COLLECTION_ID = Deno.env.get("BILLPLZ_COLLECTION_ID")!;
  // Pastikan env ini menunjuk ke edge function callback:
  // e.g. https://<PROJECT>.functions.supabase.co/billplz-callback
  const BILLPLZ_WEBHOOK_URL = Deno.env.get("BILLPLZ_WEBHOOK_URL")!;

  let raw: any = {};
  try { raw = await req.json(); } catch {}

  const reference =
    asStr(raw["txn_id"]) || asStr(raw["reference_1"]) || asStr(raw["reference"]) || "";

  const amountSen =
    asNum(raw["amount_cents"]) ??
    (asNum(raw["amount"]) != null ? Math.round(asNum(raw["amount"])! * 100) : null);

  const name = asStr(raw["name"] || raw["customer_name"]);
  const email = asStr(raw["email"]);
  const mobile = asStr(raw["phone"] || raw["mobile"]);
  const description = asStr(raw["description"] || "Tabung emas");
  const redirect_url = asStr(raw["redirect_url"]);

  if (!reference || !amountSen || amountSen <= 0 || !redirect_url) {
    return new Response(JSON.stringify({
      ok: false, error: "MISSING_FIELDS",
      need: { reference, amountSen, redirect_url }
    }), { status: 400, headers: { ...corsHeaders, "content-type":"application/json" }});
  }

  const payload: Record<string, unknown> = {
    collection_id: BILLPLZ_COLLECTION_ID,
    amount: amountSen,
    callback_url: BILLPLZ_WEBHOOK_URL,
    reference_1: reference,
    description,
    deliver: false,
    redirect_url,
  };
  if (name) payload["name"] = name;
  if (email) payload["email"] = email;
  if (mobile) payload["mobile"] = mobile;

  const authHeader = "Basic " + btoa(BILLPLZ_API_KEY + ":");
  const r = await fetch("https://www.billplz.com/api/v3/bills", {
    method: "POST",
    headers: { Authorization: authHeader, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });

  let j: any = {};
  try { j = await r.json(); } catch {}

  if (!r.ok || !j?.id || !j?.url) {
    return new Response(JSON.stringify({ ok:false, error:"BILLPLZ_FAIL", resp:j }), {
      status: 400, headers: { ...corsHeaders, "content-type":"application/json" }
    });
  }

  // 🔒 Normalize ke lowercase bila simpan
  const bill_id: string = String(j.id).toLowerCase();
  await sb.from("tabung_txn")
    .update({ bill_id_text: bill_id })
    .or(`id.eq.${reference},reference_1.eq.${reference}`);

  return new Response(JSON.stringify({ ok:true, bill_id, bill_url:j.url }), {
    headers: { ...corsHeaders, "content-type":"application/json" }
  });
});