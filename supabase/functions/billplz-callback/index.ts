// Supabase Edge Function: billplz-callback (Gabung Tabung + J916 + Goldbar/J999)
// URL: https://<PROJECT>.functions.supabase.co/billplz-callback
// Menyokong: x-www-form-urlencoded (Billplz) & application/json (manual test)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- CORS ----------
const ALLOW_ORIGIN = "*";
const cors = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-signature",
  "Access-Control-Max-Age": "86400",
};

// ---------- Supabase (service key) ----------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- (J999 only) optional X-Sign verify ----------
const XSIGN_J999 = Deno.env.get("BILLPLZ_XSIGN_KEY_J999") || "";

// ---------- OnSend (WA) ----------
const ONSEND_BASE = Deno.env.get("ONSEND_BASE") || "https://onsend.io/api/v1";
const ONSEND_TOKEN = Deno.env.get("ONSEND_TOKEN") || "";        // <-- set dalam ENV
const ONSEND_ADMIN_WA = Deno.env.get("ONSEND_ADMIN_WA") || "601113230198"; // <-- set dalam ENV jika perlu

function normalize60(msisdn?: string) {
  const d = String(msisdn || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("60")) return d;
  if (d.startsWith("0")) return "6" + d;
  if (/^[1-9]/.test(d)) return "60" + d;
  return d;
}

async function sendOnSend(msisdn: string, message: string): Promise<boolean> {
  if (!ONSEND_TOKEN) return false; // kalau tak set, jangan hantar
  const phone_number = normalize60(msisdn);
  if (!phone_number) return false;
  try {
    const r = await fetch(`${ONSEND_BASE}/send`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ONSEND_TOKEN}`,
      },
      body: JSON.stringify({ phone_number, message, type: "text" }),
    });
    const j = await r.json().catch(() => ({}));
    console.log("[OnSend]", r.status, j);
    return r.ok && j?.success === true;
  } catch (e) {
    console.warn("[OnSend] error:", e);
    return false;
  }
}

// ---------- Utils ----------
async function hmacHex(secret: string, data: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function readHybridBody(req: Request): Promise<{ raw: string; data: Record<string, string> }> {
  const ct = (req.headers.get("content-type") || "").toLowerCase();

  if (ct.includes("application/x-www-form-urlencoded")) {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    params.forEach((v, k) => (out[k] = v));
    return { raw, data: out };
  }

  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const out: Record<string, string> = {};
    Object.entries(j).forEach(([k, v]) => (out[k] = String(v ?? "")));
    return { raw: JSON.stringify(j), data: out };
  }

  const raw = await req.text().catch(() => "");
  if (raw && raw.includes("=")) {
    const params = new URLSearchParams(raw);
    const out: Record<string, string> = {};
    params.forEach((v, k) => (out[k] = v));
    return { raw, data: out };
  }
  return { raw: "", data: {} };
}

const toBoolPaid = (v?: string) => {
  const s = (v || "").toLowerCase().trim();
  return s === "true" || s === "paid" || s === "1" || s === "success" || s === "yes";
};
const isoOrNow = (v?: string) => {
  try {
    if (!v) return new Date().toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch { return new Date().toISOString(); }
};

function money(n?: number) {
  return "RM " + Number(n || 0).toFixed(2);
}
function gramsFromUnits(units?: number) {
  return (Number(units || 0) / 10).toFixed(1);
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ ok:false, error:"ONLY_POST" }), { status:405, headers:{ ...cors, "content-type":"application/json" }});

  try {
    const { raw, data: body } = await readHybridBody(req);

    // (J999 only) Verify X-Signature jika ada
    const hdrSig = (req.headers.get("X-Signature") || req.headers.get("x-signature") || "").toLowerCase();
    if (hdrSig && XSIGN_J999) {
      const expect = (await hmacHex(XSIGN_J999, raw)).toLowerCase();
      if (hdrSig !== expect) {
        console.warn("J999 signature mismatch");
        return new Response("invalid signature", { status: 400, headers: cors });
      }
    }

    // --- extract common fields ---
    const bill_id = String(body["id"] || body["bill_id"] || body["billid"] || body["billId"] || "").toLowerCase();
    const reference_1 = String(body["reference_1"] || body["reference"] || body["ref1"] || body["txn_id"] || "").trim();
    const paid = toBoolPaid(body["paid"] || body["state"] || body["status"]);
    const paid_at = isoOrNow(body["paid_at"]);
    const amount_cents = Number(body["amount_cents"] || body["amount"] || 0) | 0;
    const customer_name = String(body["name"] || body["customer_name"] || "");
    const phone = String(body["phone"] || body["reference_2"] || body["mobile"] || "");

    if (!bill_id) return new Response("MISSING_BILL_ID", { status:400, headers: cors });

    // --- log ke mana-mana jadual yang wujud (kekal) ---
    for (const logTable of ["billplz_callback_j916", "billplz_callback", "billplz_callback_goldbar"]) {
      try {
        await sb.from(logTable).insert({
          created_at: new Date().toISOString(),
          bill_id_text: bill_id,
          bill_id,
          reference_1,
          paid_bool: paid,
          paid,
          amount_cents,
          payload: body,
          raw_body: raw || JSON.stringify(body),
        } as any);
      } catch {/* ignore if table missing */}
    }

    // ---------- BELUM PAID: attach bill id & tamat ----------
    if (!paid) {
      try {
        await sb.from("tabung_txn")
          .update({ bill_id_text: bill_id, updated_at: new Date().toISOString() })
          .or(reference_1 ? `reference_1.eq.${reference_1},bill_id_text.eq.${bill_id}` : `bill_id_text.eq.${bill_id}`)
          .eq("status","PENDING");
      } catch {}
      if (reference_1) {
        try {
          await sb.from("j916_orders")
            .update({ bill_id_text: bill_id, updated_at: new Date().toISOString() })
            .eq("reference", reference_1)
            .neq("status","COMPLETED")
            .neq("status","PAID");
        } catch {}
        try {
          await sb.from("goldbar_order")
            .update({ bill_id_text: bill_id, updated_at: new Date().toISOString() })
            .eq("reference_1", reference_1)
            .eq("status","PENDING");
        } catch {}
      }
      return new Response("OK (not paid)", { status:200, headers: cors });
    }

   // ---------- SUDAH PAID ----------
const nowIso = paid_at;

// TABUNG BUY — dua langkah (by reference_1 → by bill_id_text), idempotent
try {
  let updatedBuy = 0;

  // 1) Match tepat ikut reference_1 (jika ada)
  if (reference_1) {
    const { count } = await sb
      .from("tabung_txn")
      .update({
        status: "PAID",
        paid_at: nowIso,
        updated_at: nowIso,
        bill_id_text: bill_id || null,
      })
      .eq("reference_1", reference_1.trim())
      .eq("kind", "BUY")
      .eq("status", "PENDING")
      .select("*", { head: true, count: "exact" });
    updatedBuy += count || 0;
  }

  // 2) Jika belum kena & ada bill id → match tepat ikut bill_id_text
  if (updatedBuy === 0 && bill_id) {
    const { count } = await sb
      .from("tabung_txn")
      .update({
        status: "PAID",
        paid_at: nowIso,
        updated_at: nowIso,
        bill_id_text: bill_id,
      })
      .eq("bill_id_text", bill_id)   // tepat (case-insensitive dah sebab kita lowercased)
      .eq("kind", "BUY")
      .eq("status", "PENDING")
      .select("*", { head: true, count: "exact" });
    updatedBuy += count || 0;
  }
} catch (e) {
  console.warn("tabung BUY update error", e);
}

    // 1) J916 (kekal)
    let updatedJ916 = 0;
    if (reference_1) {
      try {
        const { error, count } = await sb.from("j916_orders").update({
          status:"PAID", paid_at: nowIso, bill_id_text: bill_id,
          amount_cents, pay_method:"FPX", customer_name, phone, updated_at: nowIso
        }).eq("reference", reference_1).neq("status","COMPLETED")
          .select("*",{ head:true, count:"exact" });
        if (!error) updatedJ916 += count || 0;
      } catch {}
    }
    if (updatedJ916 === 0) {
      try {
        const { error, count } = await sb.from("j916_orders").update({
          status:"PAID", paid_at: nowIso, amount_cents, pay_method:"FPX",
          customer_name, phone, updated_at: nowIso
        }).ilike("bill_id_text", bill_id).neq("status","COMPLETED")
          .select("*",{ head:true, count:"exact" });
        if (!error) updatedJ916 += count || 0;
      } catch {}
    }

    // 2) GOLD BAR / COIN (J999) — fokus (kekal)
    let updatedGoldbar = 0;
    const amount_rm = Number((amount_cents || 0) / 100);

    let refs: string[] = [];
    if (reference_1 && reference_1.trim()) {
      refs = reference_1.split(",").map(s => s.trim()).filter(Boolean);
    } else {
      try {
        const look = await sb
          .from("goldbar_order")
          .select("reference_1")
          .ilike("bill_id_text", bill_id)
          .limit(20);
        refs = (look.data || [])
          .map(r => String((r as any).reference_1 || "").trim())
          .filter(s => s.length > 0);
      } catch (e) {
        console.warn("goldbar lookup by bill id failed", e);
      }
    }

    try {
      if (refs.length) {
        await sb.from("billplz_callback")
          .update({ reference_1: refs.join(",") })
          .ilike("bill_id_text", bill_id)
          .is("reference_1", null);
      }
    } catch {}

    if (refs.length) {
      for (const r of refs) {
        try {
          const { error, count } = await sb.from("goldbar_order").update({
            status: "PAID",
            paid_at: nowIso,
            bill_id_text: bill_id,
            amount_cents,
            total_rm: amount_rm,
            customer_name: customer_name || null,
            customer_phone: phone || null,
            phone: phone || null,
            updated_at: nowIso
          } as any)
          .eq("reference_1", r)
          .neq("status","COMPLETED")
          .neq("status","PAID")
          .select("*", { head:true, count:"exact" });
          if (!error) updatedGoldbar += count || 0;
        } catch (e) {
          console.error("goldbar update by ref fail", r, e);
        }
      }
    }

    if (updatedGoldbar === 0) {
      try {
        const { error, count } = await sb.from("goldbar_order").update({
          status: "PAID",
          paid_at: nowIso,
          amount_cents,
          total_rm: amount_rm,
          customer_name: customer_name || null,
          customer_phone: phone || null,
          phone: phone || null,
          updated_at: nowIso
        } as any)
        .ilike("bill_id_text", bill_id)
        .neq("status","COMPLETED")
        .neq("status","PAID")
        .select("*", { head:true, count:"exact" });
        if (!error) updatedGoldbar += count || 0;
      } catch (e) {
        console.error("goldbar update by bill fail", e);
      }
    }

    if (updatedGoldbar === 0) {
      try {
        const { error, count } = await sb
          .from("goldbar_order")
          .update({
            status: "PAID",
            paid_at: nowIso,
            bill_id_text: bill_id,
            total_rm: amount_rm,
            amount_cents: amount_cents ?? null,
            customer_name: customer_name || null,
            phone: phone || null,
            customer_phone: phone || null,
            updated_at: nowIso
          } as any)
          .ilike("bill_id_text", bill_id)
          .neq("status", "COMPLETED")
          .neq("status", "PAID")
          .select("*", { head: true, count: "exact" });

        if (!error) updatedGoldbar += (count || 0);
        else console.error("goldbar update by bill fail", error);
      } catch (e) {
        console.error("goldbar exception updating by bill", e);
      }
    }

    // 3) TABUNG fallback (kekal)
    let updatedTabung = 0;
    if (updatedJ916 === 0 && updatedGoldbar === 0) {
      try {
        let { error: e1, count } = await sb.from("tabung_txn").update({
          status:"PAID", paid_at: nowIso, updated_at: nowIso, bill_id_text: bill_id
        }).eq("reference_1", reference_1).eq("status","PENDING")
          .select("*",{ head:true, count:"exact" });
        if (e1) console.error("tabung by reference_1 failed", e1);
        updatedTabung += count || 0;

        if (!count || count === 0) {
  const { error: e2, count: c2 } = await sb.from("tabung_txn")
    .update({
      status: "PAID",
      paid_at: nowIso,
      updated_at: nowIso,
      bill_id_text: bill_id,
    })
    .ilike("bill_id_text", bill_id)
    .eq("status", "PENDING")
    .select("*", { head: true, count: "exact" });

  if (e2) console.error("tabung by bill_id_text failed", e2);
  updatedTabung += c2 || 0;
}
      } catch (e) {
        console.error("tabung fallback error", e);
        return new Response("FAIL", { status:500, headers: cors });
      }
    }

    // ---------- OnSend WA untuk TABUNG: BUY sahaja (selepas PAID) ----------
    try {
      // Cari transaksi BUY yang sudah PAID & berkaitan bil/rujukan & belum wa_sent
      const filterOr = reference_1
        ? `reference_1.eq.${reference_1},bill_id_text.ilike.${bill_id}`
        : `bill_id_text.ilike.${bill_id}`;

      const { data: buyRows } = await sb
        .from("tabung_txn")
        .select("id, units, total, created_at, user_name, user_phone, status, kind, wa_sent")
        .or(filterOr)
        .eq("status","PAID")
        .or("kind.eq.BUY,type.eq.BUY")
        .limit(20);

      const targets = (buyRows || []).filter(r => !r.wa_sent);

      if (targets.length && (ONSEND_TOKEN && (ONSEND_ADMIN_WA || true))) {
        for (const r of targets) {
          const nama  = r.user_name || customer_name || "-";
          const fon   = normalize60(r.user_phone || phone || "");
          const units = Number(r.units || 0);
          const gram  = gramsFromUnits(units);
          const jumlah= r.total || (amount_cents ? amount_cents/100 : undefined);
          const when  = (() => { try { return new Date(r.created_at).toLocaleString("ms-MY",{hour12:false}); } catch { return r.created_at; } })();

          // mesej — sama gaya di tabung.html afterPaidFlow
          const msgAdmin = [
            "*Pembayaran Tabung Emas (PAID)*",
            `Nama: ${nama}`,
            `No: ${fon || "-"}`,
            `Unit dibeli: ${units} (0.1g) = ${gram} g`,
            `Jumlah: ${money(jumlah)}`,
            `Tarikh: ${when}`
          ].join("\n");

          const msgCust = [
            "Terima kasih! Pembelian tabung anda telah berjaya (PAID).",
            `Unit: ${units} (0.1g) = ${gram} g`,
            `Jumlah: ${money(jumlah)}`,
            `Tarikh: ${when}`,
            "Teruskan konsisten menabung ✨"
          ].join("\n");

          // hantar (best-effort)
          const okA = await sendOnSend(ONSEND_ADMIN_WA, msgAdmin);
          let okC = false;
          if (fon) okC = await sendOnSend(fon, msgCust);

          // tanda wa_sent = true (best-effort)
          try {
            await sb.from("tabung_txn").update({ wa_sent: true }).eq("id", r.id);
          } catch {}

          // cuba juga tanda pada log callback (jika ruangan wujud)
          try {
            await sb.from("billplz_callback")
              .update({ wa_buy_sent: true })
              .ilike("bill_id_text", bill_id);
          } catch {}
        }
      }
    } catch (e) {
      console.warn("[WA BUY] skip / error:", e);
    }

    return new Response("OK", { status:200, headers: cors });
  } catch (err) {
    console.error("❌ billplz-callback error:", err);
    return new Response("FAIL", { status:500, headers: cors });
  }
});