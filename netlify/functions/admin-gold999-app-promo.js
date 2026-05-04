const { createClient } = require("@supabase/supabase-js");

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}

function num(v, fallback = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
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
    const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      return json(500, { ok: false, error: "Missing Supabase env" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "").trim().toLowerCase();

    if (!action) {
      return json(400, { ok: false, error: "Missing action" });
    }

    if (action === "get") {
      const { data, error } = await supabase
        .from("gold999_app_platform_promo")
        .select("id, appstore_rm, playstore_rm, updated_at")
        .eq("id", 1)
        .maybeSingle();

      if (error) {
        return json(500, { ok: false, error: error.message || "Failed to load promo" });
      }

      if (!data) {
        const seed = {
          id: 1,
          appstore_rm: 0,
          playstore_rm: 0
        };

        const { data: inserted, error: insertError } = await supabase
          .from("gold999_app_platform_promo")
          .upsert(seed, { onConflict: "id" })
          .select("id, appstore_rm, playstore_rm, updated_at")
          .single();

        if (insertError) {
          return json(500, { ok: false, error: insertError.message || "Failed to seed promo" });
        }

        return json(200, { ok: true, row: inserted });
      }

      return json(200, { ok: true, row: data });
    }

    if (action === "save") {
      const row = body.row || {};

      const appstore_rm = Math.max(0, num(row.appstore_rm, 0));
      const playstore_rm = Math.max(0, num(row.playstore_rm, 0));

      const payload = {
        id: 1,
        appstore_rm,
        playstore_rm,
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from("gold999_app_platform_promo")
        .upsert(payload, { onConflict: "id" })
        .select("id, appstore_rm, playstore_rm, updated_at")
        .single();

      if (error) {
        return json(500, { ok: false, error: error.message || "Failed to save promo" });
      }

      return json(200, { ok: true, row: data });
    }

    return json(400, { ok: false, error: "Unknown action" });
  } catch (err) {
    return json(500, {
      ok: false,
      error: err && err.message ? err.message : "Unexpected server error"
    });
  }
};