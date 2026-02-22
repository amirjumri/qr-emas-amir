// create-bill-j916 /index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

const asNum = (x: unknown): number | null => {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const asStr = (x: unknown): string =>
  typeof x === "string" ? x : (x == null ? "" : String(x));

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Supabase (service role – perlu untuk update j916_orders)
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 🔑 Env khas J916 (asing dari Tabung)
  const BILLPLZ_API_KEY       = Deno.env.get("BILLPLZ_API_KEY_J916")!;
  const BILLPLZ_COLLECTION_ID = Deno.env.get("BILLPLZ_COLLECTION_ID_J916")!;
  const BILLPLZ_WEBHOOK_URL   = Deno.env.get("BILLPLZ_WEBHOOK_URL_J916")!; // --> point ke billplz-webhook-j916

  // ---- Input
  let raw: Record<string, unknown> = {};
  try { raw = await req.json(); } catch {}

  // Boleh pass satu atau banyak reference (dipisah koma). Kita simpan string asal dalam reference_1
  const reference_1 = asStr(raw["reference_1"]) || asStr(raw["reference"]) || asStr(raw["txn_id"]);
  const amountSen =
    asNum(raw["amount_cents"]) ??
    (asNum(raw["amount"]) != null ? Math.round(asNum(raw["amount"])! * 100) : null);

  const name        = asStr(raw["name"] || raw["customer_name"]);
  const email       = asStr(raw["email"]);
  const mobile      = asStr(raw["phone"] || raw["mobile"]);
  const description = asStr(raw["description"] || "Bayaran pesanan J916");
  const redirectUrl = asStr(raw["redirect_url"]);

  if (!reference_1 || !amountSen || amountSen <= 0 || !redirectUrl) {
    return new Response(
      JSON.stringify({ ok:false, error:"MISSING_FIELDS", need:{ reference_1, amountSen, redirectUrl } }),
      { status:400, headers:{ ...corsHeaders, "content-type":"application/json" } }
    );
  }

  // ---- Call Billplz
  const payload: Record<string, unknown> = {
    collection_id: BILLPLZ_COLLECTION_ID,
    amount: amountSen,
    callback_url: BILLPLZ_WEBHOOK_URL, // webhook J916
    reference_1,                       // simpan group ref (boleh ada koma)
    description,
    deliver: false,
    redirect_url: redirectUrl,
  };
  if (name)   payload["name"]   = name;
  if (email)  payload["email"]  = email;
  if (mobile) payload["mobile"] = mobile;

  const authHeader = "Basic " + btoa(BILLPLZ_API_KEY + ":");
  const r = await fetch("https://www.billplz.com/api/v3/bills", {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  let bj: any = {};
  try { bj = await r.json(); } catch {}
  if (!r.ok || !bj?.id || !bj?.url) {
    return new Response(JSON.stringify({ ok:false, error:"BILLPLZ_FAIL", resp:bj }), {
      status:400, headers:{ ...corsHeaders, "content-type":"application/json" }
    });
  }

  // ---- Attach bill_id ke j916_orders (semua reference yang dihantar)
  const bill_id: string = String(bj.id).toLowerCase();
  const refs = reference_1.split(",").map(s => s.trim()).filter(Boolean);

  // best-effort: update semua order yang wujud
  for (const ref of refs) {
    try {
      await sb
        .from("j916_orders")
        .update({ bill_id_text: bill_id, updated_at: new Date().toISOString() })
        .eq("reference", ref);
    } catch {
      // abaikan jika tiada – webhook akan handle semasa paid
    }
  }

  return new Response(JSON.stringify({ ok:true, bill_id, bill_url: bj.url }), {
    headers: { ...corsHeaders, "content-type":"application/json" }
  });
});