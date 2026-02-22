// FILE: billplz-hook/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

// Helpers
const asStr = (x: unknown) => (typeof x === "string" ? x : (x == null ? "" : String(x)));
const toBool = (x: unknown) => `${x}`.toLowerCase() === "true";
const money = (sen?: number) => "RM " + ((sen ?? 0) / 100).toFixed(2);
const lc = (s: string) => s?.toLowerCase?.() ?? s;

// OnSend WhatsApp
async function sendWA(phone: string, text: string) {
  const token = Deno.env.get("ONSEND_TOKEN") || "";
  if (!token) return false;
  // normalize to 60…
  const msisdn = phone.replace(/\D/g, "").replace(/^0/, "60").replace(/^6(?=[1-9])/, "60");
  try {
    const r = await fetch("https://onsend.io/api/v1/send", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({ phone_number: msisdn, message: text, type: "text" }),
    });
    const j = await r.json().catch(() => ({}));
    console.log("[OnSend]", r.status, j);
    return r.ok && j?.success === true;
  } catch (e) {
    console.warn("[OnSend] error:", e);
    return false;
  }
}

// Supabase client (service role)
const SB_URL  = Deno.env.get("SUPABASE_URL") || Deno.env.get("URL")!;
const SB_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SERVICE_ROLE_KEY")!;
const sb = createClient(SB_URL, SB_KEY);

// Billplz secrets (support *_J916 or generic)
const BP_API_KEY =
  Deno.env.get("BILLPLZ_API_KEY_J916") || Deno.env.get("BILLPLZ_API_KEY") || "";
const ADMIN_WA = Deno.env.get("ADMIN_WA") || "601113230198";

// optional: skip x-sign verification during dev
const SKIP_VERIFY = (Deno.env.get("BILLPLZ_SKIP_VERIFY") || "").toLowerCase() === "true";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Billplz callback datang sebagai x-www-form-urlencoded
    const text = await req.text();
    const form = new URLSearchParams(text);

    // Log awal
    console.log("[HOOK] raw:", text);

    const bill_id = lc(asStr(form.get("id") || form.get("bill[id]")));
    const paid    = toBool(form.get("paid") || form.get("bill[paid]"));
    const paid_at = asStr(form.get("paid_at") || form.get("bill[paid_at]") || "");

    if (!bill_id) {
      return json({ ok: false, error: "NO_BILL_ID" }, 400);
    }

    // (OPTIONAL) Verify x-signature — skip jika tiada key / SKIP_VERIFY:true
    if (!SKIP_VERIFY) {
      const sig = asStr(form.get("x_signature") || form.get("bill[x_signature]") || "");
      if (!sig) {
        console.warn("[HOOK] No x_signature provided; continuing (not strict).");
      }
      // Anda boleh tambah verifikasi khas Billplz di sini jika mahu strict.
    }

    // Tarik butiran bil dari Billplz API (untuk nama & mobile customer)
    let cName = "-";
    let cPhone = "-";
    let amountSen = 0;
    try {
      const auth = "Basic " + btoa(BP_API_KEY + ":");
      const r = await fetch(`https://www.billplz.com/api/v3/bills/${bill_id}`, {
        headers: { "Authorization": auth, "Accept": "application/json" },
      });
      const j = await r.json();
      console.log("[HOOK] bill detail:", j);
      cName = asStr(j?.name || j?.customer?.name || "-");
      cPhone = asStr(j?.mobile || j?.customer?.phone || "-");
      amountSen = Number(j?.amount || 0);
    } catch (e) {
      console.warn("[HOOK] fetch bill detail fail:", e);
    }

    // Cari transaksi kita ikut bill_id_text
    const { data: rows, error } = await sb
      .from("tabung_txn")
      .select("id, kind, status, units, price_per_unit, total, user_id, created_at")
      .eq("bill_id_text", bill_id)
      .limit(1);

    if (error) throw error;
    const txn = rows?.[0];
    if (!txn) {
      console.warn("[HOOK] No txn matched bill_id_text:", bill_id);
    }

    // Jika paid=true → update status PAID
    if (paid) {
      const upd = await sb.from("tabung_txn")
        .update({ status: "PAID", paid_at: paid_at || new Date().toISOString() })
        .eq("bill_id_text", bill_id);
      if (upd.error) throw upd.error;
    }

    // Sediakan mesej WhatsApp (admin + customer)
    const unitStr = txn?.units ? `${txn.units} unit (0.1g)` : "";
    const totalStr = txn?.total ? money(Math.round(Number(txn.total) * 100)) :
                     amountSen ? money(amountSen) : "—";
    const kind = (txn?.kind || "BUY").toUpperCase();

    const msgAdmin = [
      "*Pembayaran Tabung Emas (PAID)*",
      `Jenis: ${kind}`,
      `Bill: ${bill_id}`,
      `Nama: ${cName}`,
      `No: ${cPhone}`,
      unitStr ? `Unit: ${unitStr}` : undefined,
      `Jumlah: ${totalStr}`,
      paid_at ? `Tarikh: ${paid_at}` : undefined,
    ].filter(Boolean).join("\n");

    const msgCust = [
      "Terima kasih! Pembelian tabung anda telah berjaya (PAID).",
      unitStr ? `Unit: ${unitStr}` : undefined,
      `Jumlah: ${totalStr}`,
      paid_at ? `Tarikh: ${paid_at}` : undefined,
      "Teruskan konsisten menabung ✨"
    ].filter(Boolean).join("\n");

    // Hantar WA — admin sentiasa, customer jika ada nombor
    const sendA = await sendWA(ADMIN_WA, msgAdmin);
    const sendC = cPhone.replace(/\D/g,"").length >= 10 ? await sendWA(cPhone, msgCust) : false;

    console.log("[HOOK] WA admin:", sendA, "WA cust:", sendC);

    return json({ ok: true, bill_id, paid, sent_admin: sendA, sent_customer: sendC }, 200);

  } catch (e) {
    console.error("[HOOK] error:", e);
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}