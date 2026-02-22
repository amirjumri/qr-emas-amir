import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AnyObj = Record<string, any>;

function formDataToObject(fd: FormData): AnyObj {
  const o: AnyObj = {};
  for (const [k, v] of fd.entries()) o[k] = v;
  return o;
}
async function readBody(req: Request): Promise<AnyObj> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      return formDataToObject(fd);
    }
    if (ct.includes("application/json")) return await req.json();
    try { return await req.json(); }
    catch { const fd = await req.formData(); return formDataToObject(fd); }
  } catch { return {}; }
}
function pickBillId(body: AnyObj): string | null {
  return body?.id || body?.bill_id || body?.bill?.id || body?.data?.id || body?.bill_id_text || null;
}
function isPaid(body: AnyObj): boolean {
  const paidVal = String(body?.paid ?? "").toLowerCase();
  const stateVal = String(body?.state ?? body?.status ?? body?.bill?.state ?? "").toLowerCase();
  return paidVal === "true" || paidVal === "1" || stateVal === "paid" || stateVal === "success";
}

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const body = await readBody(req);
  const billIdRaw = pickBillId(body);
  if (!billIdRaw) {
    return new Response(JSON.stringify({ ok:false, error:"no bill id", body }), {
      status:400, headers:{ "content-type":"application/json" }
    });
  }

  const billIdLower = String(billIdRaw).toLowerCase(); // 🔒 normalize
  const paid = isPaid(body);

  if (paid) {
    // Padanan case-insensitive dengan .ilike (tanpa wildcard)
    const { error } = await supabase
      .from("tabung_txn")
      .update({ status: "PAID", paid_at: new Date().toISOString(), meta: body })
      .ilike("bill_id_text", billIdLower); // akan match walaupun DB atau payload huruf besar

    if (error) console.error("Update PAID error:", error);
  }

  return new Response("OK", { status:200, headers:{ "content-type":"text/plain" }});
});