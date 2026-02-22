// netlify/functions/auth-reset.js

// Netlify Node18 ada fetch. Kalau runtime lama, fallback node-fetch.
let _fetch = globalThis.fetch;
if (!_fetch) {
  _fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

exports.handler = async (event) => {
  try {
    // Preflight CORS
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const SUPABASE_URL =
      process.env.SUPABASE_URL ||
      process.env.URL;

    const SERVICE_ROLE =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      process.env.SERVICE_ROLE_KEY ||
      process.env.SERVICE_ROLE;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, {
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
        has_url: !!SUPABASE_URL,
        has_service_role: !!SERVICE_ROLE
      });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    const phone = String(body.phone || "").replace(/\D+/g, "");
    const newPassword = String(body.new_password || "");

    if (!phone || phone.length < 9 || phone.length > 12) {
      return json(400, { ok: false, error: "Invalid phone" });
    }
    if (!newPassword || newPassword.length < 6) {
      return json(400, { ok: false, error: "Invalid new_password (min 6)" });
    }

    const email = `${phone}@emasamir.app`;

    // ===== 1) Cari user dengan paging (lebih selamat dari limit 1000) =====
    const found = await findUserByEmail(SUPABASE_URL, SERVICE_ROLE, email);

    if (!found?.id) {
      // ===== 2) Kalau belum ada user auth → create user =====
      const createUrl = `${SUPABASE_URL}/auth/v1/admin/users`;
      const createRes = await _fetch(createUrl, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password: newPassword,
          email_confirm: true,
          user_metadata: { phone },
        }),
      });

      const createJson = await safeJson(createRes);

      if (!createRes.ok) {
        return json(500, {
          ok: false,
          error: `Create user failed: ${createRes.status}`,
          details: createJson,
        });
      }

      return json(200, { ok: true, mode: "created", user_id: createJson?.id || null });
    }

    // ===== 3) Kalau ada → update password =====
    const updateUrl = `${SUPABASE_URL}/auth/v1/admin/users/${found.id}`;
    const updRes = await _fetch(updateUrl, {
      method: "PUT",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: newPassword }),
    });

    const updJson = await safeJson(updRes);

    if (!updRes.ok) {
      return json(500, {
        ok: false,
        error: `Update user failed: ${updRes.status}`,
        details: updJson,
      });
    }

    return json(200, { ok: true, mode: "updated", user_id: found.id });

  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};

async function findUserByEmail(SUPABASE_URL, SERVICE_ROLE, email) {
  const target = String(email || "").toLowerCase();

  // cuba sampai 10 page (10,000 user max kalau per_page 1000)
  for (let page = 1; page <= 10; page++) {
    const listUrl = `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`;

    const listRes = await _fetch(listUrl, {
      method: "GET",
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        "Content-Type": "application/json",
      },
    });

    const listJson = await safeJson(listRes);

    if (!listRes.ok) {
      // stop terus — key/URL salah akan kena sini
      throw new Error(`List users failed: ${listRes.status}`);
    }

    const users = Array.isArray(listJson?.users) ? listJson.users : [];
    const found = users.find(u => String(u?.email || "").toLowerCase() === target);

    if (found?.id) return found;

    // kalau kurang dari per_page, maksudnya habis
    if (users.length < 1000) break;
  }

  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}