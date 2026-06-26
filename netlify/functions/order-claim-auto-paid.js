const { createClient } = require("@supabase/supabase-js");

const SB_URL = process.env.SUPABASE_URL;
const SB_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = createClient(SB_URL, SB_SERVICE_KEY);

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || "{}");

    const token = String(body.token || "").trim();
    const code = String(body.code || "").trim().toUpperCase();
    const phone = String(body.phone || "").replace(/\D/g, "");
    const amount = Number(body.amount || 0);

    if (!token || !code || !phone) {
      return json(400, { ok:false, error:"Missing token/code/phone" });
    }

    const { data: claim, error: claimErr } = await sb
      .from("order_claim_links")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (claimErr) throw claimErr;
    if (!claim) return json(404, { ok:false, error:"Claim link tidak jumpa" });

    const phones = phoneVariants(phone);

    const { data: orders, error: orderErr } = await sb
      .from("j916_orders")
      .select("*")
      .in("phone", phones)
      .eq("code", code)
      .eq("status", "PENDING")
      .order("created_at", { ascending:false })
      .limit(5);

    if (orderErr) throw orderErr;

    const order = (orders || []).find(o => {
      const total =
        Number(o.grand_total_rm || 0) ||
        Number(o.total_rm || 0) ||
        Number(o.amount_cents || 0) / 100;

      return !amount || Math.abs(total - amount) < 1;
    }) || (orders || [])[0];

    if (!order) {
      return json(404, {
        ok:false,
        error:"Order PENDING tak jumpa untuk code/phone ini"
      });
    }

const orderId = order.id;
const reference = order.reference || order.reference_1 || order.id;

const snap = claim?.item_snapshot || {};

const hasCut =
  String(
    snap.cut_status ||
    claim.cut_status ||
    "NO"
  ).toUpperCase() === "YES";
if (hasCut) {

  await safeUpdate("j916_orders", {
    payment_timer_disabled: true,
    payment_timer_note: "Bayar melalui Order Link (Ada Potong)",
    updated_at: new Date().toISOString()
  }, "id", orderId);

} else {

  const paidPatch = {
    status: "PAID",
    paid_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  await safeUpdate("j916_orders", paidPatch, "id", orderId);

  if (order.reference) {
    await safeUpdate("j916_orders", paidPatch, "reference", order.reference);
  }

  if (order.reference_1) {
    await safeUpdate("j916_orders", paidPatch, "reference_1", order.reference_1);
  }

  await safeUpdate("j916_items", {
    status: "PAID",
    updated_at: new Date().toISOString()
  }, "code", code);

}

await safeUpdate("order_claim_links", {
  status: "CLAIMED",
  order_code: reference,
  claimed_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
}, "token", token);

return json(200, {
  ok:true,
  order_id: orderId,
  reference,
  has_cut: hasCut
});

  } catch (e) {
    return json(500, {
      ok:false,
      error: e.message || String(e)
    });
  }
};

function phoneVariants(raw){
  const d = String(raw || "").replace(/\D/g, "");
  const p60 = d.startsWith("60") ? d : (d.startsWith("0") ? "6" + d : "60" + d);
  const p0 = p60.startsWith("60") ? "0" + p60.slice(2) : d;
  return Array.from(new Set([d, p60, "+" + p60, p0].filter(Boolean)));
}

async function safeUpdate(table, patch, col, val){
  if (!val) return;
  const { error } = await sb.from(table).update(patch).eq(col, val);
  if (error) console.warn(table, error.message);
}

function json(statusCode, body){
  return {
    statusCode,
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  };
}