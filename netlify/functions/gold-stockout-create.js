// netlify/functions/gold-stockout-create.js
// Create Gold Stock Out (header + lines)
// ENV required:
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require("@supabase/supabase-js");

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  try {
    const SB_URL = process.env.SUPABASE_URL;
    const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });

    const sb = createClient(SB_URL, SB_KEY);

    const payload = JSON.parse(event.body || "{}");
    const reason = String(payload.reason || "LEBUR").trim() || "LEBUR";
    const note = (payload.note == null) ? null : String(payload.note);
    const created_by_phone = (payload.created_by_phone == null) ? null : String(payload.created_by_phone);

    const linesIn = Array.isArray(payload.lines) ? payload.lines : [];
    if (!linesIn.length) return json(400, { ok: false, error: "Tiada item dipilih untuk stok out." });

    // normalize lines
    const lines = linesIn.map((l) => ({
      source_type: String(l.source_type || "").trim(),
      source_pk: String(l.source_pk || "").trim(),
      source_ref: (l.source_ref == null) ? null : String(l.source_ref),
      weight_g: Number(safeNum(l.weight_g).toFixed(4)),
    })).filter(l => l.source_type && l.source_pk && l.weight_g > 0);

    if (!lines.length) return json(400, { ok: false, error: "Line item tidak sah." });

    const total = lines.reduce((s, l) => s + Number(l.weight_g || 0), 0);

    // create header
    const { data: hdr, error: e1 } = await sb
      .from("gold_stock_out")
      .insert([{
        reason,
        note,
        total_weight_g: Number(total.toFixed(4)),
        created_by_phone,
      }])
      .select("id,created_at,out_at,reason,note,total_weight_g,created_by_phone")
      .single();

    if (e1) return json(500, { ok: false, error: e1.message || e1 });

    // create lines (with unique constraint protection)
    const linesToInsert = lines.map(l => ({
      stock_out_id: hdr.id,
      source_type: l.source_type,
      source_pk: l.source_pk,
      source_ref: l.source_ref,
      weight_g: l.weight_g,
    }));

    const { error: e2 } = await sb
      .from("gold_stock_out_lines")
      .insert(linesToInsert);

    if (e2) {
      // rollback header if lines fail
      try { await sb.from("gold_stock_out").delete().eq("id", hdr.id); } catch (_) {}
      return json(500, { ok: false, error: e2.message || e2 });
    }

    return json(200, { ok: true, stock_out: hdr, lines_count: linesToInsert.length });
  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};