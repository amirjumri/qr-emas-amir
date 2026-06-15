// netlify/functions/j916-lock-order.js
const { createClient } = require("@supabase/supabase-js");

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function buildOrderPhoneCandidates(raw) {
  let d = digitsOnly(raw);
  if (!d) return [];

  if (d.startsWith("00")) d = d.slice(2);

  const out = [];
  const add = (v) => {
    const s = String(v || "").trim();
    if (s && !out.includes(s)) out.push(s);
  };

  add(d);

  if (d.startsWith("0")) {
    add("60" + d.slice(1));
  }

  if (d.startsWith("60")) {
    add("0" + d.slice(2));
  }

  if (!d.startsWith("0") && !d.startsWith("60") && d.length >= 9) {
    add("0" + d);
    add("60" + d);
  }

  return out;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: ""
      };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { ok: false, error: "Missing Supabase ENV" });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Body JSON tak sah" });
    }

    const {
      phone,
      item_id,                 // ✅ MESTI j916_items.id (uuid)
      live_rm_per_g,           // ✅ wajib (per gram)
      live_upah = 0,           // ✅ default 0
      shipping_rm = 0,         // ✅ default 0
      checkout_group = null,   // ✅ threadId (uuid) kalau nak group

      // ✅ untuk harga akhir (lepas diskaun/cashback)
      override_amount_rm = null,

      // ✅ kalau tak guna override, boleh hantar diskaun/cashback
      discount_postage_rm = 0,
      cashback_rm = 0
    } = body;

    const phoneCandidates = buildOrderPhoneCandidates(phone);

    console.log("LOCK BODY:", {
      phone,
      phoneCandidates,
      item_id,
      live_rm_per_g,
      live_upah,
      shipping_rm,
      checkout_group,
      override_amount_rm,
      discount_postage_rm,
      cashback_rm
    });

    if (!phoneCandidates.length || !item_id || live_rm_per_g == null) {
      return json(400, { ok: false, error: "Missing required fields" });
    }

    const upah = Number(live_upah || 0);
    const ship = Number(shipping_rm || 0);
    const perG = Number(live_rm_per_g);

    if (!isFinite(perG) || perG <= 0) {
      return json(400, { ok: false, error: "Invalid live_rm_per_g" });
    }
    if (!isFinite(upah) || upah < 0) {
      return json(400, { ok: false, error: "Invalid live_upah" });
    }
    if (!isFinite(ship) || ship < 0) {
      return json(400, { ok: false, error: "Invalid shipping_rm" });
    }

    // ✅ ambil weight + code dari j916_items
    const { data: it, error: itErr } = await sb
      .from("j916_items")
      .select("id, code, weight_g")
      .eq("id", item_id)
      .single();

    if (itErr) return json(500, { ok: false, error: itErr.message });
    if (!it?.id) return json(400, { ok: false, error: "Item not found" });

    const weightG = Number(it.weight_g || 0);
    if (!isFinite(weightG) || weightG <= 0) {
      return json(400, { ok: false, error: "Invalid item weight_g" });
    }

    // ✅ kira amount BASE (sebelum diskaun/cashback)
    const baseAmountRm = (perG * weightG) + upah + ship;

    // ✅ kira final amount (lepas diskaun/cashback / override)
    const discPost = Number(discount_postage_rm || 0);
    const cash = Number(cashback_rm || 0);

    if (!isFinite(discPost) || discPost < 0) {
      return json(400, { ok: false, error: "Invalid discount_postage_rm" });
    }
    if (!isFinite(cash) || cash < 0) {
      return json(400, { ok: false, error: "Invalid cashback_rm" });
    }

    let finalAmountRm = null;

    if (override_amount_rm !== null && override_amount_rm !== undefined && override_amount_rm !== "") {
      const ov = Number(override_amount_rm);
      if (!isFinite(ov) || ov <= 0) {
        return json(400, { ok: false, error: "Invalid override_amount_rm" });
      }
      finalAmountRm = ov;
    } else {
      finalAmountRm = baseAmountRm - discPost - cash;
      if (!isFinite(finalAmountRm)) finalAmountRm = baseAmountRm;

      if (finalAmountRm <= 0) {
        return json(400, {
          ok: false,
          error: "Jumlah akhir <= 0. Semak discount_postage_rm / cashback_rm."
        });
      }
    }

    // ✅ amount cents ikut jumlah akhir
    const amountCents = Math.round(finalAmountRm * 100);

    // ✅ cuba beberapa variant phone sampai RPC terima
    let orderRes = null;
    let orderErr = null;
    let orderPhoneUsed = null;

    for (const cand of phoneCandidates) {
      const res = await sb.rpc("j916_live_manual_order_v1", {
        p_item_id: it.id,
        p_code: String(it.code || it.id),
        p_weight_g: weightG,
        p_price_per_g: perG,
        p_upah_rm: upah,
        p_amount_cents: amountCents,
        p_customer_phone: cand,
        p_shipping_rm: ship,
        p_checkout_group: checkout_group
      });

      if (!res.error) {
        orderRes = res.data;
        orderErr = null;
        orderPhoneUsed = cand;
        break;
      }

      orderErr = res.error;

      console.log("RPC try fail:", {
        cand,
        message: res.error?.message || null
      });

      // kalau error selain PHONE_INVALID, stop terus
      if (!String(res.error?.message || "").includes("PHONE_INVALID")) {
        break;
      }
    }

    if (orderErr) {
      return json(500, {
        ok: false,
        error: orderErr.message,
        phone_candidates: phoneCandidates
      });
    }

    console.log("ORDER RES:", orderRes);

    // ============================
    // ✅ PATCH: BETULKAN COLUMN TOTALS DALAM j916_orders
    // Mapping Amir:
    // grand_total_rm = finalAmountRm (jumlah akhir bayar)
    // pay_disc_rm    = discPost + cash
    // subtotal_rm    = grand_total_rm + pay_disc_rm   (jumlah asal sebelum diskaun)
    // shipping_rm    = ship
    // ============================
    const payDiscRm = Number((discPost + cash).toFixed(2));
    const grandTotalRm = Number(Number(finalAmountRm).toFixed(2));
    const subtotalRm = Number((grandTotalRm + payDiscRm).toFixed(2));

    // cuba cari id/order_code dari response RPC (ikut mana yang ada)
    const orderId =
      (orderRes && (orderRes.id || orderRes.order_id || orderRes.order_code)) ||
      null;

    // update row supaya field masuk tempat betul
    // (try eq("id") dulu, kalau tak match, try eq("order_code"))
    if (orderId) {
  try {
    const paymentDeadlineAt = new Date(Date.now() + (30 * 60 * 1000)).toISOString();

    const patchTotals = {
      subtotal_rm: subtotalRm,
      shipping_rm: ship,
      pay_disc_rm: payDiscRm,
      grand_total_rm: grandTotalRm
    };

    const patchTimer = {
      payment_deadline_at: paymentDeadlineAt,
      payment_timer_disabled: false,
      payment_timer_note: "Auto 30 minit dari LIVE lock"
    };

    // 1) Update totals dulu — ini sentiasa boleh update
    const u1 = await sb
      .from("j916_orders")
      .update(patchTotals)
      .eq("id", orderId);

    let timerUpdated = false;

    // 2) Set timer hanya kalau payment_deadline_at masih kosong
    //    Supaya kalau admin dah tambah masa, tak overwrite balik ke 30 minit
    if (!u1.error) {
      const t1 = await sb
        .from("j916_orders")
        .update(patchTimer)
        .eq("id", orderId)
        .is("payment_deadline_at", null);

      if (!t1.error) timerUpdated = true;
    }

    if (u1.error) {
      const u2 = await sb
        .from("j916_orders")
        .update(patchTotals)
        .eq("order_code", orderId);

      if (u2.error) {
        console.log("WARN j916_orders update (order_code) fail:", u2.error.message);
      } else {
        const t2 = await sb
          .from("j916_orders")
          .update(patchTimer)
          .eq("order_code", orderId)
          .is("payment_deadline_at", null);

        if (!t2.error) timerUpdated = true;
      }
    }

    console.log("j916 order timer patch:", {
      orderId,
      paymentDeadlineAt,
      timerUpdated
    });

  } catch (e) {
    console.log("WARN j916_orders update exception:", e?.message || String(e));
  }
} else {
  console.log("WARN: orderRes tiada id/order_code untuk update totals.");
}

    // ✅ lock item status ke PENDING
    const { error: lockErr } = await sb.rpc("j916_admin_item_status_v1", {
      p_item_id: it.id,
      p_status: "PENDING"
    });

    if (lockErr) return json(500, { ok: false, error: lockErr.message });

    // Debug breakdown
    const impliedDiscountRm = Number((baseAmountRm - finalAmountRm).toFixed(2));
    const debug = {
      code: it.code,
      order_phone: orderPhoneUsed,
      phone_candidates: phoneCandidates,
      weight_g: weightG,
      price_per_g: perG,
      upah_rm: upah,
      shipping_rm: ship,

      base_amount_rm: Number(baseAmountRm.toFixed(2)),
      override_amount_rm: (override_amount_rm !== null && override_amount_rm !== undefined && override_amount_rm !== "")
        ? Number(Number(override_amount_rm).toFixed(2))
        : null,
      discount_postage_rm: Number(discPost.toFixed(2)),
      cashback_rm: Math.floor(cash),
      final_amount_rm: Number(finalAmountRm.toFixed(2)),
      implied_discount_total_rm: Number(impliedDiscountRm.toFixed(2)),

      mapped_subtotal_rm: subtotalRm,
      mapped_pay_disc_rm: payDiscRm,
      mapped_grand_total_rm: grandTotalRm,

      amount_cents: amountCents
    };

    return json(200, {
      ok: true,
      order: orderRes,
      debug
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "Server error" });
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}