// create-bill-j999.ts
// Purpose: CIPTA BILL Billplz untuk Goldbar/Coin (J999) SAHAJA
// I/O: JSON { txn_id|reference_1|reference, amount( RM ), name, email, phone, redirect_url }
// Out: { ok:true, bill_id, bill_url }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

const ok  = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { ...CORS, "content-type":"application/json" }
  });

const bad = (code: number, data: unknown) =>
  new Response(JSON.stringify(data), {
    status: code,
    headers: { ...CORS, "content-type":"application/json" }
  });

const asStr = (x: unknown) => (typeof x === "string" ? x : (x == null ? "" : String(x)));
const asNum = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : NaN; };
const toMsisdn60 = (s: string) => {
  const d = (s||"").toString().replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("60")) return d;
  if (d.startsWith("0"))  return "6" + d;
  return "60" + d;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return bad(405, { ok:false, error: "ONLY_POST" });

  // Supabase (service role)
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Billplz env untuk J999
  // ⚠️ Pastikan BILLPLZ_WEBHOOK_URL_J999 menunjuk ke endpoint GABUNG:
  //     https://<PROJECT>.functions.supabase.co/billplz-callback   (tanpa slash hujung)
  const BILLPLZ_API_KEY        = Deno.env.get("BILLPLZ_API_KEY")!;
  const BILLPLZ_COLLECTION_ID  = Deno.env.get("BILLPLZ_COLLECTION_ID_J999")!;
  const BILLPLZ_WEBHOOK_URL    = Deno.env.get("BILLPLZ_WEBHOOK_URL_J999")!;

  // ---- input ----
  let body: any = {};
  try { body = await req.json(); } catch {}

  // terima txn_id / reference_1 / reference (CSV dibenarkan)
  const referenceRaw =
    asStr(body.txn_id) || asStr(body.reference_1) || asStr(body.reference) || "";
  // normalize + dedup + guard panjang
  const references =
    Array.from(
      new Set(
        referenceRaw
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.slice(0, 64)) // hard cap utk elak dipotong oleh gateway
      )
    );

  const amountRM     = asNum(body.amount); // RM (bukan sen)
  const redirect_url = asStr(body.redirect_url);
  const name         = asStr(body.name);
  const email        = asStr(body.email) || "";
  const phone60      = toMsisdn60(asStr(body.phone) || "");

  if (!references.length)                       return bad(400, { ok:false, error:"MISSING_REFERENCE" });
  if (!Number.isFinite(amountRM) || amountRM<=0) return bad(400, { ok:false, error:"BAD_AMOUNT", amount: body.amount });
  if (!redirect_url)                             return bad(400, { ok:false, error:"MISSING_REDIRECT_URL" });

  // Billplz payload (amount dalam SEN)
  const payload = {
    collection_id: BILLPLZ_COLLECTION_ID,
    description  : `Goldbar/Coin Checkout (${references.join(",")})`,
    reference_1  : references.join(","),     // kekal CSV → webhook akan split
    reference_2  : phone60 || undefined,     // optional (mudah dilihat di dashboard)
    amount       : Math.round(amountRM * 100), // SEN (integer)
    callback_url : BILLPLZ_WEBHOOK_URL,
    redirect_url,
    deliver      : false,
    name         : name  || undefined,
    email        : email || undefined,
    mobile       : phone60 || undefined,
  };

  const authHeader = "Basic " + btoa(BILLPLZ_API_KEY + ":");
  const r = await fetch("https://www.billplz.com/api/v3/bills", {
    method: "POST",
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.id || !j?.url) {
    return bad(400, { ok:false, error:"BILLPLZ_FAIL", resp:j });
  }

  const bill_id = String(j.id).toLowerCase();
  const nowIso  = new Date().toISOString();

  // Attach bill_id ke semua goldbar_order ikut reference_1 (bulk)
  try {
    await sb.from("goldbar_order")
      .update({ bill_id_text: bill_id, updated_at: nowIso })
      .in("reference_1", references)
      .neq("status","COMPLETED");
  } catch (e) {
    console.warn("[J999] attach bill_id_text (bulk) failed", e);
    // jangan gagalkan bill creation
  }

  // Seed ke log callback (untuk backfill bila webhook tak hantar reference_1)
  const seed = {
    created_at: nowIso,
    bill_id_text: bill_id,
    reference_1: references.join(","),
    paid_bool: false,
    amount_cents: Math.round(amountRM * 100),
    raw_body: JSON.stringify({ seed_from: "create-bill-j999" })
  };
  try { await sb.from("billplz_callback").insert(seed as any); } catch {}
  try { await sb.from("billplz_callback_goldbar").insert(seed as any); } catch {}

  return ok({ ok:true, bill_id, bill_url: j.url });
});