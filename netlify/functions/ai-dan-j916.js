// netlify/functions/ai-dan-j916.js
// AI-Dan J916 (Budget -> Choose -> Lock -> Ask delivery) + session continuity (minimal patch)
//
// ENV needed:
// - OPENAI_API_KEY
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY  (server-side key)
// Optional:
// - OPENAI_MODEL  (default: "gpt-4.1-mini")

const OpenAI = require("openai");
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
  return Number.isFinite(n) ? n : null;
}

function normText(s) {
  return String(s || "").trim();
}

function extractLikelyPhone(payload) {
  // try common fields (Amir boleh adjust kemudian)
  return (
    payload?.phone ||
    payload?.customer_phone ||
    payload?.from ||
    payload?.actor_phone ||
    null
  );
}

function extractLikelyName(payload) {
  return payload?.name || payload?.customer_name || null;
}

/** detect a "code" like RT0012345 / RL0004442 etc */
function findCodeInText(text) {
  const t = String(text || "").toUpperCase();
  // matches: 2 letters + 5-10 digits (Amir boleh longgarkan)
  const m = t.match(/\b[A-Z]{2}\d{5,10}\b/);
  return m ? m[0] : null;
}

/** detect budget "rm 300" */
function findBudgetInText(text) {
  const t = String(text || "").toLowerCase();
  // rm300 / rm 300 / bajet 300 / budget 300
  const m =
    t.match(/\brm\s?(\d{1,6})\b/) ||
    t.match(/\b(bajet|budget)\s?(\d{1,6})\b/);
  if (!m) return null;
  const val = m[1] && /^\d+$/.test(m[1]) ? m[1] : m[2];
  const n = safeNum(val);
  return n;
}

/** map user reply like "1", "1 dah la", "no 2", "yang 3" -> number */
function findChoiceNumber(text) {
  const t = String(text || "").toLowerCase().trim();

  // "1"
  let m = t.match(/^\s*([1-9][0-9]?)\s*$/);
  if (m && m[1]) return Number(m[1]);

  // "no 2" / "yang 2"
  m = t.match(/\b(?:no|nombor|number|yang)\s*([1-9][0-9]?)\b/i);
  if (m && m[1]) return Number(m[1]);

  // "1 dah la" / "2 je"
  m = t.match(/^\s*([1-9][0-9]?)\b.*\b(dah|la|je|ja)\b/i);
  if (m && m[1]) return Number(m[1]);

  return null;
}

/** detect follow-up ask types */
function isAskWeight(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("berat") || t.includes("gram") || /\b(\d+(?:\.\d+)?)\s*g\b/i.test(t);
}
function isAskLength(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("panjang") || t.includes("size") || t.includes("saiz") || /\bcm\b/i.test(t);
}
function isAskWidth(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("lebar") || t.includes("width");
}
function isAskPrice(text) {
  const t = String(text || "").toLowerCase();
  // "161 tu" pun kadang-kadang bila kita sebut harga
  return t.includes("harga") || t.includes("rm");
}

/* =========================
   AI-DAN SESSION STATE (minimal)
   table: ai_dan_sessions (phone text primary key, state jsonb, updated_at timestamptz)
   - fail silently if table not exist
========================= */

async function getAiDanState(supabase, phone) {
  if (!phone) return {};
  try {
    const q = await supabase
      .from("ai_dan_sessions")
      .select("phone,state,updated_at")
      .eq("phone", phone)
      .limit(1)
      .maybeSingle();
    if (q.error) return {};
    return q.data?.state || {};
  } catch (_) {
    return {};
  }
}

async function saveAiDanState(supabase, phone, patch = {}) {
  if (!phone) return false;
  try {
    const cur = (await getAiDanState(supabase, phone)) || {};
    const next = {
      ...(cur || {}),
      ...(patch || {}),
      _updated_at: new Date().toISOString(),
    };

    const up = await supabase
      .from("ai_dan_sessions")
      .upsert(
        { phone, state: next, updated_at: new Date().toISOString() },
        { onConflict: "phone" }
      );

    if (up.error) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function pickCodeFromLastList(state, idx1based) {
  const list = Array.isArray(state?.last_list) ? state.last_list : [];
  const i = Number(idx1based) - 1;
  if (!Number.isFinite(i) || i < 0 || i >= list.length) return null;
  const it = list[i];
  return it?.code ? String(it.code).toUpperCase().trim() : null;
}

function compactListForPrompt(state, maxN = 8) {
  const list = Array.isArray(state?.last_list) ? state.last_list : [];
  const sliced = list.slice(0, Math.max(0, Math.min(maxN, list.length)));
  if (!sliced.length) return "";
  const lines = sliced.map((it, i) => {
    const code = it?.code ? String(it.code).toUpperCase() : "";
    const nm = it?.design_name ? ` ${String(it.design_name)}` : "";
    const pr = it?.price_rm != null ? ` • RM${Number(it.price_rm).toFixed(2)}` : "";
    const w = it?.weight_g != null ? ` • ${it.weight_g}g` : "";
    const l = it?.length_cm != null ? ` • ${it.length_cm}cm` : "";
    return `${i + 1}. ${code}${nm}${w}${l}${pr}`.trim();
  });
  return lines.join("\n");
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    }
    if (!OPENAI_API_KEY) {
      return json(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    }

    const payload = JSON.parse(event.body || "{}");
    const userText = normText(payload?.text || payload?.message || payload?.input || "");
    const phone = extractLikelyPhone(payload);
    const customerName = extractLikelyName(payload);

    if (!userText) return json(200, { ok: true, reply: "Tulis soalan cik ya 😊 Contoh: “Ada tak bajet RM300?”" });

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ✅ Load session state (minimal continuity)
    const state = await getAiDanState(supabase, phone);

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // --- Tools (function calling) ---
    // The model MUST not reveal internal formula. It only uses returned price_rm.
    const tools = [
      {
        type: "function",
        name: "list_j916_categories",
        description: "List kategori J916 yang ada (code dan nama).",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },

      // ✅ NEW: list design unik (bukan per code)
      {
        type: "function",
        name: "list_j916_designs",
        description:
          "List design unik J916 ikut kategori/bajet/carian. Sesuai untuk soalan: 'design apa ada' / 'list design'.",
        parameters: {
          type: "object",
          properties: {
            cat_code: { type: ["string", "null"], description: "Kod kategori (contoh RT, CC, RL, SB...)." },
            max_price_rm: { type: ["number", "null"], description: "Had maksimum bajet RM." },
            query_text: { type: ["string", "null"], description: "Carian teks (contoh: engraving, sauh, love...)." },
            limit: { type: ["integer", "null"], description: "Bilangan design untuk dipaparkan (1-30).", minimum: 1, maximum: 30 },
            sort: { type: ["string", "null"], enum: ["PRICE_ASC", "PRICE_DESC", "NEWEST", null] },
          },
          additionalProperties: false,
        },
      },

      {
        type: "function",
        name: "search_j916_items",
        description:
          "Cari item J916 AVAILABLE ikut bajet/kategori/panjang. Pulangkan senarai ringkas untuk customer pilih code.",
        parameters: {
          type: "object",
          properties: {
            max_price_rm: { type: ["number", "null"], description: "Had maksimum bajet RM." },
            cat_code: { type: ["string", "null"], description: "Kod kategori (contoh RT, CC, RL, SB...).", maxLength: 8 },
            min_length_cm: { type: ["number", "null"], description: "Minimum panjang cm." },
            max_length_cm: { type: ["number", "null"], description: "Maksimum panjang cm." },
            limit: { type: ["integer", "null"], description: "Bilangan item untuk dipaparkan (1-12).", minimum: 1, maximum: 12 },
            sort: { type: ["string", "null"], enum: ["PRICE_ASC", "PRICE_DESC", "NEWEST", null] },
          },
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "get_j916_item_detail",
        description: "Ambil detail item J916 berdasarkan code.",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", description: "Code item seperti RT0012345.", minLength: 3, maxLength: 32 },
          },
          required: ["code"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "lock_j916_item",
        description:
          "Lock item J916 berdasarkan code + phone customer. Akan tukar status item ke LOCKED jika masih AVAILABLE.",
        parameters: {
          type: "object",
          properties: {
            code: { type: "string", minLength: 3, maxLength: 32 },
            customer_phone: { type: "string", description: "Phone customer dalam format +60..." },
            customer_name: { type: ["string", "null"] },
            notes: { type: ["string", "null"] },
          },
          required: ["code", "customer_phone"],
          additionalProperties: false,
        },
      },
    ];

    // --- System instructions (lebih "bebas", tapi masih selamat) ---
    const instructions = `
Awak ialah "AI-Dan" untuk Emas Amir (J916).
Tugas: jawab customer secara natural, cari item dalam database, bagi pilihan, dan lock bila customer setuju.

Peraturan penting:
- Jangan dedahkan formula/kiraan dalaman (contoh 1.08, upah, harga/gram). Hanya sebut harga siap (price_rm).
- Semua jawapan berkaitan stok/harga MESTI berpandukan hasil tools (database). Jangan mengarang.
- Jika customer tanya "design apa ada" / "list design", WAJIB guna list_j916_designs (bukan search_j916_items).
- Bila customer nak cari barang (bajet/kategori/size/panjang) dan nak pilih ikut CODE, gunakan search_j916_items.
- Bila customer tanya detail (berat/panjang/lebar/harga), gunakan get_j916_item_detail.
- Bila customer pilih dengan nombor (contoh "1", "1 dah la"), anggap merujuk senarai terakhir (Last List) jika ada.
- Bila customer tanya sambungan tanpa code (contoh "berat dia berapa"), guna konteks last_code/last_list kalau diberi.
- Bila customer confirm nak ambil/lock, guna lock_j916_item.
- Lepas lock berjaya, tanya: "Nak pos atau ambil di kedai?".

Hint kategori (jika customer sebut):
- "cincin" -> CC, "loket" -> LK, "rantai tangan" -> RT, "rantai leher" -> RL, "rantai kaki" -> RK, "subang" -> SB, "bead/charm" -> BC

Gaya bahasa: mesra, ringkas, Bahasa Melayu santai. Jangan ulang soalan yang sama jika customer dah jawab.
    `.trim();

    // --- Minimal continuity hints ---
    const hintCodeRaw = findCodeInText(userText);
    const hintBudget = findBudgetInText(userText);
    const choiceNo = findChoiceNumber(userText);

    // If user replies with "1/2/3" and no explicit code, map to last_list
    let hintCode = hintCodeRaw;
    if (!hintCode && choiceNo != null) {
      const mapped = pickCodeFromLastList(state, choiceNo);
      if (mapped) hintCode = mapped;
    }

    // If user asks follow-up detail without code, provide last_code as hint (OpenAI decide)
    const followUpNoCode =
      !hintCodeRaw &&
      (isAskWeight(userText) || isAskLength(userText) || isAskWidth(userText) || isAskPrice(userText));

    if (!hintCode && followUpNoCode && state?.last_code) {
      hintCode = String(state.last_code).toUpperCase().trim();
    }

    const lastListText = compactListForPrompt(state, 8);

    const inputParts = [
      { role: "system", content: instructions },
      {
        role: "user",
        content:
          `Mesej customer: ${userText}\n` +
          (phone ? `Phone: ${phone}\n` : "") +
          (customerName ? `Nama: ${customerName}\n` : "") +
          (hintBudget != null ? `Hint budget_rm: ${hintBudget}\n` : "") +
          (hintCode ? `Hint code (context): ${hintCode}\n` : "") +
          (state?.last_code ? `Last code: ${String(state.last_code).toUpperCase()}\n` : "") +
          (state?.last_budget_rm != null ? `Last budget_rm: ${state.last_budget_rm}\n` : "") +
          (state?.last_cat_code ? `Last cat_code: ${state.last_cat_code}\n` : "") +
          (lastListText ? `\nLast List (rujukan jika customer jawab nombor):\n${lastListText}\n` : ""),
      },
    ];

    // --- Tool executor ---
    async function runTool(name, args) {
      if (name === "list_j916_categories") {
        const { data, error } = await supabase.rpc("openai_list_j916_categories");
        if (error) return { ok: false, error: error.message };
        return { ok: true, categories: data || [] };
      }

      // ✅ NEW: list design unik
      if (name === "list_j916_designs") {
        const max_price_rm = args?.max_price_rm ?? hintBudget ?? state?.last_budget_rm ?? null;
        const cat_code = args?.cat_code ?? state?.last_cat_code ?? null;
        const query_text = args?.query_text ?? null;
        const limit = Math.max(1, Math.min(Number(args?.limit ?? 12), 30));
        const sort = args?.sort ?? "PRICE_ASC";

        const { data, error } = await supabase.rpc("openai_list_j916_designs", {
          p_cat_code: cat_code,
          p_max_price_rm: max_price_rm,
          p_query_text: query_text,
          p_limit: limit,
          p_sort: sort,
        });

        if (error) return { ok: false, error: error.message };

        const designs = (data || []).map((x) => ({
          cat_code: x.cat_code,
          category_name: x.category_name,
          design_id: x.design_id,
          design_name: x.design_name,
          variants_count: x.variants_count,
          min_price_rm: x.min_price_rm,
          max_price_rm: x.max_price_rm,
          sample_code: x.sample_code,
          img_urls: x.img_urls || [],
          newest_created_at: x.newest_created_at || null,
        }));

        // optional: simpan last_cat_code/last_budget untuk continuity
        if (phone) {
          await saveAiDanState(supabase, phone, {
            last_budget_rm: max_price_rm ?? null,
            last_cat_code: cat_code ?? null,
          });
        }

        return { ok: true, count: designs.length, designs };
      }

      if (name === "search_j916_items") {
        const max_price_rm = args?.max_price_rm ?? hintBudget ?? state?.last_budget_rm ?? null;
        const cat_code = args?.cat_code ?? state?.last_cat_code ?? null;
        const min_length_cm = args?.min_length_cm ?? null;
        const max_length_cm = args?.max_length_cm ?? null;
        const limit = Math.max(1, Math.min(Number(args?.limit ?? 8), 12));
        const sort = args?.sort ?? "PRICE_ASC";

        const { data, error } = await supabase.rpc("openai_search_j916_items", {
          p_max_price_rm: max_price_rm,
          p_cat_code: cat_code,
          p_min_length_cm: min_length_cm,
          p_max_length_cm: max_length_cm,
          p_limit: limit,
          p_sort: sort,
        });

        if (error) return { ok: false, error: error.message };

        const items = (data || []).map((x) => ({
          code: x.code,
          design_name: x.design_name,
          cat_code: x.cat_code,
          category_name: x.category_name,
          weight_g: x.weight_g,
          length_cm: x.length_cm,
          width_cm: x.width_cm,
          price_rm: x.price_rm,
          img_urls: x.img_urls || [],
        }));

        // ✅ Save continuity: last_list + last_code
        if (phone) {
          await saveAiDanState(supabase, phone, {
            last_budget_rm: max_price_rm ?? null,
            last_cat_code: cat_code ?? null,
            last_list: items.map((it) => ({
              code: it.code,
              design_name: it.design_name || null,
              cat_code: it.cat_code || null,
              weight_g: it.weight_g ?? null,
              length_cm: it.length_cm ?? null,
              width_cm: it.width_cm ?? null,
              price_rm: it.price_rm ?? null,
            })),
            last_code: items[0]?.code || state?.last_code || null,
          });
        }

        return { ok: true, count: items.length, items };
      }

      if (name === "get_j916_item_detail") {
        const code = String(args?.code || hintCode || "").toUpperCase().trim();
        if (!code) return { ok: false, error: "Missing code" };

        const { data, error } = await supabase.rpc("openai_get_j916_item_detail", { p_code: code });
        if (error) return { ok: false, error: error.message };

        const row = Array.isArray(data) ? data[0] : null;
        if (!row) return { ok: false, error: "Not found" };

        const item = {
          code: row.code,
          design_id: row.design_id,
          design_name: row.design_name,
          cat_code: row.cat_code,
          category_name: row.category_name,
          weight_g: row.weight_g,
          length_cm: row.length_cm,
          width_cm: row.width_cm,
          price_rm: row.price_rm,
          img_urls: row.img_urls || [],
          status: row.status,
        };

        // ✅ Save continuity: last_code
        if (phone) {
          await saveAiDanState(supabase, phone, {
            last_code: item.code,
            last_item: {
              code: item.code,
              design_name: item.design_name || null,
              cat_code: item.cat_code || null,
              weight_g: item.weight_g ?? null,
              length_cm: item.length_cm ?? null,
              width_cm: item.width_cm ?? null,
              price_rm: item.price_rm ?? null,
            },
          });
        }

        return { ok: true, item };
      }

      if (name === "lock_j916_item") {
        const code = String(args?.code || hintCode || "").toUpperCase().trim();
        const customer_phone = String(args?.customer_phone || phone || "").trim();
        const customer_name = args?.customer_name ?? customerName ?? null;
        const notes = args?.notes ?? null;

        if (!code) return { ok: false, error: "Missing code" };
        if (!customer_phone) return { ok: false, error: "Missing customer_phone" };

        const { data, error } = await supabase.rpc("openai_lock_j916_item", {
          p_code: code,
          p_customer_phone: customer_phone,
          p_customer_name: customer_name,
          p_notes: notes,
        });

        if (error) return { ok: false, error: error.message };

        const row = Array.isArray(data) ? data[0] : null;
        const out = row || { ok: false, error: "Lock failed" };

        // ✅ Save continuity: last_code + last_locked
        if (phone && out?.ok) {
          await saveAiDanState(supabase, phone, {
            last_code: code,
            last_locked: { code, at: new Date().toISOString() },
          });
        }

        return out;
      }

      return { ok: false, error: `Unknown tool: ${name}` };
    }

    // --- Agentic loop using Responses API ---
    let resp = await openai.responses.create({
      model: MODEL,
      instructions,
      tools,
      input: inputParts,
    });

    for (let step = 0; step < 6; step++) {
      const calls = (resp.output || []).filter((it) => it.type === "function_call");
      if (!calls.length) break;

      const toolOutputs = [];
      for (const c of calls) {
        const name = c.name;
        let args = {};
        try {
          args = c.arguments ? JSON.parse(c.arguments) : {};
        } catch (e) {
          args = {};
        }

        const result = await runTool(name, args);

        toolOutputs.push({
          type: "function_call_output",
          call_id: c.call_id || c.id,
          output: JSON.stringify(result),
        });
      }

      resp = await openai.responses.create({
        model: MODEL,
        instructions,
        tools,
        previous_response_id: resp.id,
        input: toolOutputs,
      });
    }

    const reply = (resp.output_text || "").trim() || "Maaf cik, boleh ulang soalan sikit? 😊";
    return json(200, { ok: true, reply });
  } catch (err) {
    return json(500, { ok: false, error: String(err?.message || err) });
  }
};