// netlify/functions/chat-gold999.js
// Flow khas untuk Gold 999.9 (Gold Coin / Gold Bar / Dinar)
// Semua logic diletakkan di sini.
// chat-send.js nanti hanya perlu require + pass request masuk sini.

const MARKUP_RATE = 0.08;
const RPC_PRICE_LIST = "goldbar_price_list_v1";
const ORDER_PREPARE_RPC = "goldbar_order_prepare_v1";
const GOLD999_DISCOUNT_TABLE = "gold999_discount_rules";

const APP_PLATFORM_PROMO = {
  APPSTORE: 10,
  PLAYSTORE: 0
};
const DEFAULT_PAYMENT_DISCOUNTS = {
  FPX: { type: "PERCENT", value: 6 },
  CARD_EWALLET: { type: "PERCENT", value: 5 },
  QR: { type: "PERCENT", value: 5 },
  TRANSFER: { type: "PERCENT", value: 5 },
  BNPL: { type: "PERCENT", value: 0 }
};

const DEFAULT_SHIPPING = {
  code: "PU",
  label: "Pick Up di Kedai",
  rm: 0
};

const SHIPPING_OPTIONS = {
  PU:  { code: "PU",  label: "Pick Up di Kedai",     rm: 0  },
  MY:  { code: "MY",  label: "Semenanjung Malaysia", rm: 10 },
  MYE: { code: "MYE", label: "Sabah/Sarawak",        rm: 20 },
  SG:  { code: "SG",  label: "Singapore",            rm: 45 }
};

// ===== OnSend (WhatsApp) =====
const ADMIN_WA = "601113230198"; // nombor admin
const ONSEND_BASE  = "https://onsend.io/api/v1";
const ONSEND_TOKEN = "";

function norm(s) {
  return String(s || "").trim();
}

function lower(s) {
  return norm(s).toLowerCase();
}

function upper(s) {
  return norm(s).toUpperCase();
}

function money(n) {
  const x = Number(n || 0);
  if (!isFinite(x)) return "RM 0.00";
  return "RM " + x.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtG(g) {
  const x = Number(g || 0);
  let s = String(x);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s + "g";
}

function dinarLabel(g) {
  const map = {
    "1.0625": "1/4 dinar (1.0625g)",
    "2.125": "1/2 dinar (2.125g)",
    "4.25": "1 dinar (4.25g)"
  };
  return map[String(Number(g || 0))] || fmtG(g);
}

function jsonClone(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (_) {
    return null;
  }
}

function parseNumberLoose(text) {
  const m = String(text || "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseQty(text) {
  const x = parseNumberLoose(text);
  if (!isFinite(x)) return null;
  const n = Math.floor(x);
  if (n < 1) return null;
  if (n > 99) return 99;
  return n;
}

function isExitCommand(text) {
  const t = lower(text);
  return [
    "batal",
    "cancel",
    "x jadi",
    "tak jadi",
    "clear",
    "kosongkan"
  ].includes(t);
}

function isRestartCommand(text) {
  const t = lower(text);
  return [
    "reset",
    "mula semula",
    "start over"
  ].includes(t);
}

function isShowListCommand(text) {
  const t = lower(text);
  return [
    "senarai",
    "cart",
    "list",
    "tengok senarai",
    "lihat senarai",
    "order saya",
    "pesanan saya"
  ].includes(t);
}

function isCheckoutAllCommand(text) {
  const t = lower(text);
  return [
    "checkout semua",
    "checkout all",
    "bayar semua",
    "teruskan semua",
    "confirm semua"
  ].includes(t);
}

function isCheckoutSingleCommand(text) {
  const t = lower(text);
  return [
    "checkout item ini sahaja",
    "checkout item ini saja",
    "checkout item ni sahaja",
    "checkout item ni saja",
    "checkout item",
    "bayar item ini sahaja",
    "bayar item ni sahaja"
  ].includes(t);
}

function isAddMoreCommand(text) {
  const t = lower(text);
  return [
    "tambah lagi",
    "add more",
    "lagi",
    "nak tambah lagi",
    "terus tambah"
  ].includes(t);
}

function detect999Intent(text) {
  const t = lower(text);

  const include = [
    "999",
    "999.9",
    "gold coin",
    "goldcoin",
    "gold bar",
    "goldbar",
    "dinar",
    "coin emas",
    "bar emas",
    "emas 999",
    "emas 999.9",
    "syiling emas",
    "gold 999"
  ];

  const exclude = [
    "916",
    "tabung",
    "trade in",
    "tradein",
    "jual emas",
    "repair",
    "cuci"
  ];

  if (exclude.some(x => t.includes(x))) return false;
  return include.some(x => t.includes(x));
}

function detectKindFromText(text) {
  const t = lower(text);

  if (
    t === "1" ||
    t.includes("coin") ||
    t.includes("gold coin") ||
    t.includes("coin emas") ||
    t.includes("syiling")
  ) return "coin";

  if (
    t === "2" ||
    t.includes("dinar")
  ) return "dinar";

  if (
    t === "3" ||
    t.includes("bar") ||
    t.includes("gold bar") ||
    t.includes("jongkong")
  ) return "bar";

  return null;
}
function detectCardType(text) {
  const t = lower(text);

  if (
    t.includes("ready") ||
    t.includes("ready card") ||
    t.includes("kad ready")
  ) return "READY";

  if (
    t.includes("custom") ||
    t.includes("custom card") ||
    t.includes("kad custom")
  ) return "CUSTOM";

  return null;
}function detectShipMode(text) {
  const t = lower(text);

  const wantPickup =
    t === "1" ||
    t.includes("ambil") ||
    t.includes("pickup") ||
    t.includes("kedai") ||
    t.includes("datang");

  const wantPost =
    t === "2" ||
    t.includes("pos") ||
    t.includes("post") ||
    t.includes("delivery") ||
    t.includes("hantar") ||
    t.includes("courier");

  if (wantPickup && !wantPost) return "PICKUP";
  if (wantPost && !wantPickup) return "POST";
  return null;
}

function isAddressBetul(text) {
  const t = lower(text);
  return (
    t === "alamat betul" ||
    t === "betul" ||
    t.includes("alamat betul") ||
    t.includes("betul")
  );
}

function isAddressSalah(text) {
  const t = lower(text);
  return (
    t === "alamat salah" ||
    t === "salah" ||
    t.includes("alamat salah") ||
    t.includes("tukar alamat") ||
    t.includes("ubah alamat") ||
    t.includes("alamat baru")
  );
}

function detectPaymentChoice(text) {
  const t = lower(text);

  const isQR =
    t === "1" ||
    t.includes("qr");

  const isTransfer =
    t === "2" ||
    t.includes("transfer") ||
    t.includes("bank");

  if (isQR && !isTransfer) return "QR";
  if (isTransfer && !isQR) return "TRANSFER";
  return null;
}

function normalizeKindForDb(kind) {
  const k = lower(kind);
  if (k === "goldbar" || k === "bar") return "bar";
  if (k === "dinar") return "dinar";
  return "coin";
}

function normalizeKindForOrder(kind) {
  const k = lower(kind);
  if (k === "goldbar" || k === "bar") return "bar";
  if (k === "dinar") return "dinar";
  return "coin";
}

function kindLabel(kind) {
  const k = normalizeKindForDb(kind);
  if (k === "bar") return "Gold Bar";
  if (k === "dinar") return "Koleksi Dinar";
  return "Gold Coin";
}
function detectCountryFromPhone(phone) {
  const d = String(phone || "").replace(/\D+/g, "");
  if (d.startsWith("65")) return "SG";
  return "MY";
}

function normalizePhoneVariants(rawPhone) {
  let d = String(rawPhone || "").replace(/\D+/g, "");
  if (!d) return [];

  const out = new Set();

  out.add(d);

  if (d.startsWith("00")) d = d.slice(2);
  out.add(d);

  if (d.startsWith("60")) {
    out.add("+" + d);
    out.add("0" + d.slice(2));
  }

  if (d.startsWith("0")) {
    out.add("60" + d.slice(1));
  }

  return Array.from(out).filter(Boolean);
}

function toOnsendPhone(msisdn) {
  const d = String(msisdn || "").replace(/\D+/g, "");
  if (!d) return "";

  if (d.startsWith("60")) return d;
  if (d.startsWith("0")) return "60" + d.slice(1);
  if (d.startsWith("+" )) return d.replace(/\D+/g, "");
  return "60" + d;
}

async function sendOnsendText(msisdn, text) {
  const phone_number = toOnsendPhone(msisdn);
  const message = String(text || "").trim();

  if (!phone_number || !message) return false;
  if (!ONSEND_TOKEN) {
    console.warn("[chat-gold999] ONSEND_TOKEN kosong. Skip send OnSend.");
    return false;
  }

  try {
    const res = await fetch(`${ONSEND_BASE}/send`, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ONSEND_TOKEN}`
      },
      body: JSON.stringify({
        phone_number,
        message,
        type: "text"
      })
    });

    const json = await res.json().catch(() => ({}));
    console.log("[chat-gold999] OnSend response:", res.status, json);

    return !!(res.ok && json && json.success === true);
  } catch (err) {
    console.warn("[chat-gold999] sendOnsendText error:", err);
    return false;
  }
}

function buildOnsendCustomerText(items, totals, refs, flow, payMethod, threadRow) {
  const bankName = process.env.BANK_NAME || "Maybank";
  const bankAccName = process.env.BANK_ACC_NAME || "EMAS AMIR SDN. BHD.";
  const bankAccNo = process.env.BANK_ACC_NO || "552031155695";
  const bankQrUrl =
    process.env.BANK_QR_URL ||
    process.env.QR_DUITNOW_URL ||
    "https://emasamir.app/qr-maybank.html";

  const customerName =
    norm(flow?.customer_profile?.name) ||
    norm(threadRow?.customer_name) ||
    "Pelanggan";

  const shipLine =
    String(flow?.ship_mode || "").toUpperCase() === "POST"
      ? `Penghantaran: ${flow?.ship_label || "Pos"} (${money(flow?.ship_fee_rm || 0)})\nAlamat: ${flow?.addr_text || "-"}`
      : `Penghantaran: Ambil di Kedai\nBila ambil: ${flow?.pickup_when_text || "-"}`;

  const itemLines = (items || []).map((it) => {
    const amount = Number(it.unit || 0) * Number(it.qty || 0);
    return `• ${kindLabel(it.kind)} — ${it.weight_label} — ${it.design_name} (${it.cardType === "CUSTOM" ? "Custom Card" : "Ready Card"}) × ${it.qty} = ${money(amount)}`;
  });

  const summaryLines = [
    `Subtotal: ${money(totals?.subtotal || 0)}`,
    `Caj pos: ${money(totals?.ship || 0)}`,
    `Diskaun kaedah bayaran: -${money(totals?.payDisc || 0)}`
  ];

  if (Number(totals?.promoDisc || 0) > 0) {
    summaryLines.push(`${totals?.promoLabel || "Diskaun promo"}: -${money(totals?.promoDisc || 0)}`);
  }

  if (Number(totals?.appDisc || 0) > 0) {
    summaryLines.push(`${totals?.appDiscLabel || "Promo App"}: -${money(totals?.appDisc || 0)}`);
  }

  summaryLines.push(`Jumlah akhir perlu dibayar: ${money(totals?.grand || 0)}`);

  return [
    `Terima kasih ${customerName}! Berikut ringkasan pesanan Gold 999.9 anda di Emas Amir.`,
    ``,
    `Kaedah bayaran: ${payMethod === "QR" ? "QR" : "TRANSFER"}`,
    shipLine,
    `Rujukan order: ${(refs || []).join(", ") || "-"}`,
    ``,
    `Item:`,
    ...itemLines,
    ``,
    `Ringkasan jumlah:`,
    ...summaryLines,
    ``,
    `Maklumat bayaran:`,
    `Bank: ${bankName}`,
    `Nama Akaun: ${bankAccName}`,
    `No Akaun: ${bankAccNo}`,
    ``,
    `QR DuitNow / QR Transfer:`,
    bankQrUrl,
    ``,
    `Selepas berjaya bayar, sila hantar slip / resit di chat ini ya. Terima kasih 🙏`
  ].join("\n");
}

function formatAddress(cust) {
  const a = String(cust?.alamat || "").trim();
  const p = String(cust?.postcode || "").trim();
  const city = String(cust?.city || "").trim();
  const st = String(cust?.state || "").trim();
  const tail = [p, city, st].filter(Boolean).join(", ");
  if (!a && !tail) return "";
  if (a && tail) return `${a}, ${tail}`;
  return a || tail;
}

function detectMYZoneFromStateOrAddress(state, alamat) {
  const t = (String(state || "") + " " + String(alamat || "")).toLowerCase();
  if (t.includes("sabah") || t.includes("sarawak") || t.includes("labuan")) return "EAST_MY";
  return "WEST_MY";
}

function calcShipFee(country, zone) {
  if (country === "SG") return 45;
  return zone === "EAST_MY" ? 20 : 10;
}

function shipLabel(country, zone) {
  if (country === "SG") return "Singapore";
  return zone === "EAST_MY" ? "Sabah/Sarawak" : "Semenanjung Malaysia";
}

function makeQuickReplies(pairs) {
  return (pairs || []).map(x => ({
    label: String(x.label || "").trim(),
    send: String(x.send || "").trim()
  })).filter(x => x.label && x.send);
}

function makeDesignCards(designs) {
  return (designs || []).map(d => ({
    label: String(d?.name || "").trim(),
    send: String(d?.name || "").trim(),
    image_url: String(d?.image_url || "").trim()
  })).filter(x => x.label && x.send);
}

function makeEmptyFlow() {
  return {
    active: false,
    step: "",

    kind: null,
    weight_g: null,
    weight_label: null,
    upah_rm: 0,
    price_per_g: 0,

    selected_design_id: null,
    selected_design_name: "",
    selected_design_custom_fee_rm: 0,

    card_type: "READY",
    qty: 1,

    checkout_mode: null,
    cart: [],

    last_shown_weights: [],
    last_shown_designs: [],

    prepared_refs: [],
    prepared_checkout_mode: null,
    prepared_totals: null,
    prepared_discount_rule: null,
    prepared_items: [],
    checkout_group_code: null,

    discount_source: null,
    discount_enabled: false,

    ship_mode: null,
    ship_code: null,
    ship_label: null,
    ship_fee_rm: 0,
    pickup_when_text: "",
    addr_text: "",
    addr_need_new: false,
   customer_country: "MY",
    customer_profile: null,
    pay_method: null,

    is_real_app: false,
    app_platform: "",

    // ===== NEW: builder mode =====
    builder_mode: false,
    builder_started_from_custom_intent: false,
    builder_summary_open: true
  };
}
function safeMeta(threadRow) {
  return jsonClone(threadRow?.meta || {}) || {};
}

async function setGold999Flow(supabase, threadId, threadRow, nextFlow) {
  const meta = safeMeta(threadRow);
  meta.gold999_flow = nextFlow;

  const { error } = await supabase
    .from("chat_threads")
    .update({ meta })
    .eq("id", threadId);

  if (error) {
    console.warn("[chat-gold999] setGold999Flow error:", error);
  }

  return meta;
}

function getGold999Flow(threadRow) {
  const meta = safeMeta(threadRow);
  const flow = jsonClone(meta.gold999_flow);
  return flow && typeof flow === "object" ? flow : makeEmptyFlow();
}

function getDiscountSourceFromThread(threadRow) {
  const meta = safeMeta(threadRow);

  if (meta.ai_dan_discount === true) return "AI_DAN";
  if (meta.ai_dan === true) return "AI_DAN";
  if (meta.ai_dan_mode === true) return "AI_DAN";

  return null;
}

async function findCustomerByThreadPhone(supabase, threadRow) {
  const phone = String(threadRow?.customer_phone || "").replace(/\D+/g, "");
  if (!phone) return null;

  const candidates = normalizePhoneVariants(phone);

  for (const ph of candidates) {
    try {
      const { data, error } = await supabase
        .from("customers")
        .select("id,name,phone,alamat,postcode,city,state")
        .eq("phone", ph)
        .limit(1)
        .maybeSingle();

      if (!error && data) return data;
    } catch (_) {}
  }

  return null;
}

async function saveCustomerAddressByThreadPhone(supabase, threadRow, customerProfile, newAddr) {
  const phoneRaw = String(threadRow?.customer_phone || "").replace(/\D+/g, "");
  if (!phoneRaw || !newAddr) return customerProfile || null;

  const candidates = normalizePhoneVariants(phoneRaw);
  const customerName =
    norm(customerProfile?.name) ||
    norm(threadRow?.customer_name) ||
    null;

  let existing = customerProfile || null;

  if (!existing) {
    existing = await findCustomerByThreadPhone(supabase, threadRow);
  }

  if (existing?.id) {
    const { error } = await supabase
      .from("customers")
      .update({
        alamat: newAddr
      })
      .eq("id", existing.id);

    if (error) {
      console.warn("[chat-gold999] saveCustomerAddress update error:", error);
    } else {
      return {
        ...(existing || {}),
        alamat: newAddr
      };
    }
  }

  const phoneToUse = candidates[0] || phoneRaw;

  try {
    const { data, error } = await supabase
      .from("customers")
      .insert({
        name: customerName,
        phone: phoneToUse,
        alamat: newAddr
      })
      .select("id,name,phone,alamat,postcode,city,state")
      .single();

    if (!error && data) return data;
    if (error) console.warn("[chat-gold999] saveCustomerAddress insert error:", error);
  } catch (err) {
    console.warn("[chat-gold999] saveCustomerAddress insert exception:", err);
  }

  return existing ? { ...existing, alamat: newAddr } : {
    id: null,
    name: customerName,
    phone: phoneToUse,
    alamat: newAddr,
    postcode: null,
    city: null,
    state: null
  };
}

function buildCategoryReply() {
  return (
    `Baik cik 😊 Untuk 999.9, cik nak pilih yang mana satu?\n\n` +
    `1. Gold Coin\n` +
    `2. Koleksi Dinar\n` +
    `3. Gold Bar\n\n` +
    `Balas nombor atau nama pilihan ya.\n` +
    `Contoh: *Gold Coin*`
  );
}

async function listPriceRows(supabase) {
  const { data, error } = await supabase.rpc(RPC_PRICE_LIST);
  if (error) {
    console.warn("[chat-gold999] listPriceRows RPC error:", error);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

function normalizePriceRow(row) {
  const kind = normalizeKindForDb(row?.kind);
  const weight_g = Number(row?.weight_g || 0);
  const upah_rm = Number(row?.upah_rm || 0);
  const price_per_g = Number(row?.price_per_g || 0);
  const harga_jual = Number(row?.harga_jual || 0);

  return {
    kind,
    weight_g,
    weight_label: kind === "dinar" ? dinarLabel(weight_g) : fmtG(weight_g),
    upah_rm,
    price_per_g,
    harga_jual
  };
}

async function getKindPriceRows(supabase, kind) {
  const rows = await listPriceRows(supabase);
  const k = normalizeKindForDb(kind);

  return rows
    .map(normalizePriceRow)
    .filter(r => r.kind === k)
    .sort((a, b) => Number(a.weight_g) - Number(b.weight_g));
}

function buildWeightsReply(kind, rows) {
  if (!rows.length) {
    return `Maaf cik, buat masa ini tiada pilihan berat aktif untuk ${kindLabel(kind)}.`;
  }

  const lines = rows.map((r, i) => {
    return `${i + 1}. ${r.weight_label} — ${money(r.harga_jual)}`;
  });

  return (
    `Baik 😊 Berikut pilihan berat untuk *${kindLabel(kind)}*:\n\n` +
    lines.join("\n") +
    `\n\nSila balas berat yang cik nak.\n` +
    `Contoh: *${rows[0].weight_label}*`
  );
}

// FIX 1:
// untuk berat, check label/berat sebenar dulu.
// BARU kalau user hantar nombor kosong macam "1", "2", "3"
// kita anggap sebagai index senarai.
function findWeightRowFromText(rows, text) {
  const t = lower(text);

  for (const r of rows) {
    const lbl = lower(r.weight_label);
    const plainG = lower(fmtG(r.weight_g));
    const rawNum = String(Number(r.weight_g));

    if (t === lbl || t.includes(lbl)) return r;
    if (t === plainG || t.includes(plainG)) return r;
    if (t === rawNum + "g" || t.includes(rawNum + "g")) return r;
    if (t === rawNum && !/^\d+$/.test(t)) return r;
  }

  const num = parseNumberLoose(text);
  if (isFinite(num)) {
    const found = rows.find(r => Math.abs(Number(r.weight_g) - Number(num)) < 0.000001);
    if (found) return found;
  }

  if (/^\d+$/.test(t)) {
    const idx = Number(t);
    if (idx >= 1 && idx <= rows.length) {
      return rows[idx - 1];
    }
  }

  return null;
}

async function listDesigns(supabase, kind, weight_g) {
  const { data, error } = await supabase
    .from("goldbar_designs")
    .select("id,name,image_url,weight_g,kind,is_active,sort_order,extra_custom_fee_cents")
    .eq("kind", normalizeKindForDb(kind))
    .eq("weight_g", Number(weight_g))
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) {
    console.warn("[chat-gold999] listDesigns error:", error);
    return [];
  }

  return (data || []).map((d) => ({
    id: d.id,
    name: norm(d.name) || "Design",
    image_url: norm(d.image_url),
    weight_g: Number(d.weight_g || 0),
    kind: normalizeKindForDb(d.kind),
    extra_custom_fee_rm: Number(d.extra_custom_fee_cents || 0) / 100
  }));
}

function buildDesignReply(weightLabel, designs) {
  if (!designs.length) {
    return (
      `Maaf cik, buat masa ini tiada design aktif untuk berat *${weightLabel}*.\n\n` +
      `Cik boleh pilih berat lain ya.`
    );
  }

  const lines = designs.map((d, i) => `${i + 1}. ${d.name}`);

  return (
    `Baik 😊 Untuk *${weightLabel}*, kami ada design berikut:\n\n` +
    lines.join("\n") +
    `\n\nSila balas nama design yang cik nak.\n` +
    `Contoh: *${designs[0].name}*`
  );
}

function findDesignFromText(designs, text) {
  const t = lower(text);

  for (const d of designs) {
    const name = lower(d.name);
    if (t === name || t.includes(name)) return d;
  }

  const idx = parseQty(text);
  if (idx && idx >= 1 && idx <= designs.length) {
    return designs[idx - 1];
  }

  return null;
}

function parseConfigChoice(text) {
  const t = norm(text);

  if (!t) {
    return {
      designId: null,
      cardType: null,
      qty: null
    };
  }

  if (t.startsWith("CONFIG|")) {
    const parts = t.split("|").slice(1);
    const out = {
      designId: null,
      cardType: null,
      qty: null
    };

    for (const p of parts) {
      const [k, v] = String(p || "").split("=");
      const key = String(k || "").trim().toLowerCase();
      const val = String(v || "").trim();

      if (key === "design_id") out.designId = val || null;
      if (key === "card") out.cardType = upper(val || "");
      if (key === "qty") {
        const q = Number(val || 0);
        out.qty = Number.isFinite(q) && q > 0 ? Math.min(99, Math.floor(q)) : null;
      }
    }

    return out;
  }

  const cardType = detectCardType(t);
  const qty = parseQty(t);

  return {
    designId: null,
    cardType: cardType || null,
    qty: qty || null
  };
}

function parseBuilderChoice(text) {
  const t = norm(text);

  if (!t.startsWith("BUILDER|")) {
    return null;
  }

  const out = {
    action: "",
    kind: "",
    weight_g: null,
    design_id: "",
    card: "READY",
    qty: 1,
    remove_index: null
  };

  const parts = t.split("|").slice(1);

  for (const raw of parts) {
    const [k, ...rest] = String(raw || "").split("=");
    const key = String(k || "").trim().toLowerCase();
    const val = decodeURIComponent(rest.join("=") || "").trim();

    if (key === "action") out.action = lower(val);
    if (key === "kind") out.kind = normalizeKindForDb(val);
    if (key === "weight_g") {
      const n = Number(val);
      out.weight_g = Number.isFinite(n) ? n : null;
    }
    if (key === "design_id") out.design_id = val || "";
    if (key === "card") out.card = upper(val || "READY");
    if (key === "qty") {
      const q = Number(val);
      out.qty = Number.isFinite(q) && q > 0 ? Math.min(99, Math.floor(q)) : 1;
    }
    if (key === "remove_index") {
      const idx = Number(val);
      out.remove_index = Number.isFinite(idx) ? Math.floor(idx) : null;
    }
  }

  if (out.card !== "CUSTOM") out.card = "READY";

  return out;
}

function parseLive999Lock(text) {
  const t = norm(text);
  if (!t.startsWith("LIVE999_LOCK|")) return null;

  const out = {
    kind: "",
    weight_g: null,
    design_id: "",
    design_name: "",
    card: "READY",
    qty: 1
  };

  const parts = t.split("|").slice(1);

  for (const raw of parts) {
    const [k, ...rest] = String(raw || "").split("=");
    const key = String(k || "").trim().toLowerCase();
    const val = decodeURIComponent(rest.join("=") || "").trim();

    if (key === "kind") out.kind = normalizeKindForDb(val);
    if (key === "weight_g") out.weight_g = Number(val);
    if (key === "design_id") out.design_id = val;
    if (key === "design_name") out.design_name = val;
    if (key === "card") out.card = upper(val || "READY") === "CUSTOM" ? "CUSTOM" : "READY";
    if (key === "qty") out.qty = Math.max(1, Math.min(99, Math.floor(Number(val || 1))));
  }

  if (!out.kind || !Number.isFinite(Number(out.weight_g)) || Number(out.weight_g) <= 0) return null;
  return out;
}

function parseLive999CheckoutSubmit(text) {
  const t = norm(text);
  if (!t.startsWith("LIVE999_CHECKOUT_SUBMIT|")) return null;

  const out = {
    kind: "",
    weight_g: null,
    design_id: "",
    design_name: "",
    card: "READY",
    qty: 1,
    price_rm: 0,
    ship: "POST",
    address: "",
    pickup_when: "",
    pay_method: "QR"
  };

  const parts = t.split("|").slice(1);

  for (const raw of parts) {
    const [k, ...rest] = String(raw || "").split("=");
    const key = String(k || "").trim().toLowerCase();
    const val = decodeURIComponent(rest.join("=") || "").trim();

    if (key === "kind") out.kind = normalizeKindForDb(val);
    if (key === "weight_g") out.weight_g = Number(val);
    if (key === "design_id") out.design_id = val;
    if (key === "design_name") out.design_name = val;
    if (key === "card") out.card = upper(val || "READY") === "CUSTOM" ? "CUSTOM" : "READY";
    if (key === "qty") out.qty = Math.max(1, Math.min(99, Math.floor(Number(val || 1))));
    if (key === "price_rm") out.price_rm = Number(val || 0);
    if (key === "ship") out.ship = upper(val || "POST");
    if (key === "address") out.address = val;
    if (key === "pickup_when") out.pickup_when = val;
    if (key === "pay_method") out.pay_method = upper(val || "QR");
  }

  if (!out.kind || !Number.isFinite(out.weight_g) || out.weight_g <= 0) return null;
  if (!Number.isFinite(out.price_rm) || out.price_rm <= 0) return null;

  return out;
}

async function handleLive999CheckoutSubmit(supabase, threadId, threadRow, rawText, isRealApp, appPlatform) {
  const live999Checkout = parseLive999CheckoutSubmit(rawText);
  if (!live999Checkout) return null;

  const qty = Number(live999Checkout.qty || 1);
  const unitPrice = Number(live999Checkout.price_rm || 0) / qty;

  const rows = await getKindPriceRows(supabase, live999Checkout.kind);
  const priceRow = rows.find(r => Number(r.weight_g) === Number(live999Checkout.weight_g));

  if (!priceRow) {
    return replyResult(
      `Maaf cik, harga untuk item GoldBar/Coin ini tak dijumpai. Sila cuba semula dari LIVE.`,
      "gold999_live999_price_not_found"
    );
  }

  const item = simplifyCartItem({
    kind: live999Checkout.kind,
    weight_g: live999Checkout.weight_g,
    weight_label: priceRow.weight_label || fmtG(live999Checkout.weight_g),
    cardType: live999Checkout.card || "READY",
    qty,
    unit: unitPrice,
    design_id: live999Checkout.design_id || null,
    design_name: live999Checkout.design_name || "",
    custom_fee: 0,
    price_per_g: priceRow.price_per_g,
    upah_rm: priceRow.upah_rm
  });

  const shipMode = live999Checkout.ship === "PICKUP" ? "PICKUP" : "POST";
  const payMethod = live999Checkout.pay_method === "TRANSFER" ? "TRANSFER" : "QR";

  let shipping = DEFAULT_SHIPPING;
  let addrText = "";
  let pickupWhenText = "";

  if (shipMode === "POST") {
    addrText = live999Checkout.address || "";
    const country = detectCountryFromPhone(threadRow?.customer_phone || "");
    const zone = detectMYZoneFromStateOrAddress("", addrText);

    shipping = {
      code: country === "SG" ? "SG" : (zone === "EAST_MY" ? "MYE" : "MY"),
      label: shipLabel(country, zone),
      rm: calcShipFee(country, zone)
    };
  } else {
    pickupWhenText = live999Checkout.pickup_when || "Akan dimaklumkan";
    shipping = DEFAULT_SHIPPING;
  }

  const discountSource = getDiscountSourceFromThread(threadRow) || "AI_DAN";

  const totals = await computeTotals([item], {
    supabase,
    shipping,
    payMethod,
    discountSource,
    isRealApp: isRealApp === true,
    appPlatform: appPlatform || ""
  });

  const refs = await createRefsForItems(supabase, [item]);

  const nextFlow = {
    ...makeEmptyFlow(),
    active: false,
    step: "done",
    prepared_refs: refs,
    prepared_items: [item],
    prepared_totals: totals,
    prepared_checkout_mode: "live999_direct",
    checkout_mode: "live999_direct",

    ship_mode: shipMode,
    ship_code: shipping.code,
    ship_label: shipping.label,
    ship_fee_rm: Number(shipping.rm || 0),
    pickup_when_text: pickupWhenText,
    addr_text: addrText,

    pay_method: payMethod,
    discount_source: discountSource,
    checkout_group_code: makeCheckoutGroupCode(),

    is_real_app: isRealApp === true,
    app_platform: upper(appPlatform || "")
  };

  await finalizePreparedOrders(
    supabase,
    refs,
    [item],
    nextFlow,
    threadId,
    threadRow,
    totals,
    payMethod
  );

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    buildPaymentDetailsReply([item], totals, refs, nextFlow, payMethod),
    "gold999_live999_checkout_payment_ready",
    {
      gold999: {
        done: true,
        step: "done",
        refs,
        pay_method: payMethod,
        grand_total_rm: Number(totals.grand || 0)
      }
    }
  );
}

async function buildConfigCardMeta(supabase, flow, threadRow) {
  const designs = await listDesigns(supabase, flow.kind, flow.weight_g);

  const selectedDesignId =
    flow.selected_design_id ||
    (designs[0]?.id || null);

  const selectedDesign =
    designs.find(d => String(d.id) === String(selectedDesignId)) ||
    designs[0] ||
    null;

  const selectedCustomFeeRm = Number(
    selectedDesign?.extra_custom_fee_rm ??
    flow.selected_design_custom_fee_rm ??
    0
  );

  const discountSource = getDiscountSourceFromThread(threadRow);

  const readyMarketPrice = calcUnitPrice(
    flow.price_per_g,
    flow.weight_g,
    flow.upah_rm,
    "READY",
    0
  );

  const customMarketPrice = calcUnitPrice(
    flow.price_per_g,
    flow.weight_g,
    flow.upah_rm,
    "CUSTOM",
    selectedCustomFeeRm
  );

  const readyItemForDiscount = simplifyCartItem({
    kind: flow.kind,
    weight_g: flow.weight_g,
    weight_label: flow.weight_label,
    cardType: "READY",
    qty: 1,
    unit: readyMarketPrice,
    design_id: selectedDesign?.id || null,
    design_name: selectedDesign?.name || "",
    custom_fee: 0,
    price_per_g: flow.price_per_g,
    upah_rm: flow.upah_rm
  });

  const customItemForDiscount = simplifyCartItem({
    kind: flow.kind,
    weight_g: flow.weight_g,
    weight_label: flow.weight_label,
    cardType: "CUSTOM",
    qty: 1,
    unit: customMarketPrice,
    design_id: selectedDesign?.id || null,
    design_name: selectedDesign?.name || "",
    custom_fee: selectedCustomFeeRm,
    price_per_g: flow.price_per_g,
    upah_rm: flow.upah_rm
  });

const readyTotals = await computeTotals([readyItemForDiscount], {
    supabase,
    shipping: DEFAULT_SHIPPING,
    payMethod: "CARD_EWALLET",
    discountSource,
    isRealApp: flow.is_real_app === true,
    appPlatform: flow.app_platform || ""
  });

  const customTotals = await computeTotals([customItemForDiscount], {
    supabase,
    shipping: DEFAULT_SHIPPING,
    payMethod: "CARD_EWALLET",
    discountSource,
    isRealApp: flow.is_real_app === true,
    appPlatform: flow.app_platform || ""
  });
  const readyFinalPrice = Number(readyTotals?.grand || 0);
  const customFinalPrice = Number(customTotals?.grand || 0);

  const readyJimat = Math.max(0, Number(readyMarketPrice || 0) - readyFinalPrice);
  const customJimat = Math.max(0, Number(customMarketPrice || 0) - customFinalPrice);

  return {
    kind: normalizeKindForDb(flow.kind),
    kind_label: kindLabel(flow.kind),
    weight_g: Number(flow.weight_g || 0),
    weight_label: flow.weight_label,

    selected_design_id: selectedDesign?.id || null,
    selected_design_name: selectedDesign?.name || "",
    selected_design_image_url: selectedDesign?.image_url || "",

    ready_market_price_rm: Number(readyMarketPrice || 0),
    ready_final_price_rm: Number(readyFinalPrice || 0),
    ready_jimat_rm: Number(readyJimat || 0),

    custom_market_price_rm: Number(customMarketPrice || 0),
    custom_final_price_rm: Number(customFinalPrice || 0),
    custom_jimat_rm: Number(customJimat || 0),

    market_price_rm: Number(readyMarketPrice || 0),
    final_price_rm: Number(readyFinalPrice || 0),
    jimat_rm: Number(readyJimat || 0),

    default_card_type: upper(flow.card_type || "READY"),
    default_qty: Number(flow.qty || 1),

    designs: designs.map(d => ({
      id: d.id,
      name: d.name,
      image_url: d.image_url || "",
      extra_custom_fee_rm: Number(d.extra_custom_fee_rm || 0)
    }))
  };
}

function detectBuilderStartIntent(text) {
  const t = lower(text);

  return (
    t.includes("gold coin custom") ||
    t.includes("berminat gold coin custom") ||
    t.includes("minat gold coin custom") ||
    t.includes("nak gold coin custom") ||
    t.includes("gold coin") ||
    t.includes("gold bar") ||
    t.includes("dinar") ||
    t.includes("emas 999") ||
    t.includes("emas 999.9")
  );
}

function kindOrderIndex(kind) {
  const k = normalizeKindForDb(kind);
  if (k === "coin") return 1;
  if (k === "dinar") return 2;
  return 3;
}

function buildCartSummaryLines(cart) {
  const arr = Array.isArray(cart) ? cart : [];
  return arr.map((it, idx) => {
    const amount = Number(it.unit || 0) * Number(it.qty || 0);
    return {
      index: idx + 1,
      kind: normalizeKindForDb(it.kind),
      kind_label: kindLabel(it.kind),
      weight_g: Number(it.weight_g || 0),
      weight_label: it.weight_label || fmtG(it.weight_g || 0),
      design_id: it.design_id || null,
      design_name: it.design_name || "",
      card_type: upper(it.cardType || "READY"),
      qty: Number(it.qty || 1),
      unit_rm: Number(it.unit || 0),
      total_rm: Number(amount || 0)
    };
  });
}

async function buildBuilderKindCatalog(supabase, kind, discountSource) {
  const rows = await getKindPriceRows(supabase, kind);

  const weights = [];

  for (const row of rows) {
    const designs = await listDesigns(supabase, kind, row.weight_g);

    const readyMarketPrice = calcUnitPrice(
      row.price_per_g,
      row.weight_g,
      row.upah_rm,
      "READY",
      0
    );

    const readyItem = simplifyCartItem({
      kind,
      weight_g: row.weight_g,
      weight_label: row.weight_label,
      cardType: "READY",
      qty: 1,
      unit: readyMarketPrice,
      design_id: null,
      design_name: "",
      custom_fee: 0,
      price_per_g: row.price_per_g,
      upah_rm: row.upah_rm
    });

   const readyTotals = await computeTotals([readyItem], {
      supabase,
      shipping: DEFAULT_SHIPPING,
      payMethod: "CARD_EWALLET",
      discountSource,
      isRealApp: false,
      appPlatform: ""
    });

    const readyFinalPrice = Number(readyTotals?.grand || 0);
    const readyJimat = Math.max(0, Number(readyMarketPrice || 0) - readyFinalPrice);

    const designEntries = [];

    for (const d of designs) {
      const customFeeRm = Number(d.extra_custom_fee_rm || 0);

      const customMarketPrice = calcUnitPrice(
        row.price_per_g,
        row.weight_g,
        row.upah_rm,
        "CUSTOM",
        customFeeRm
      );

      const customItem = simplifyCartItem({
        kind,
        weight_g: row.weight_g,
        weight_label: row.weight_label,
        cardType: "CUSTOM",
        qty: 1,
        unit: customMarketPrice,
        design_id: d.id,
        design_name: d.name,
        custom_fee: customFeeRm,
        price_per_g: row.price_per_g,
        upah_rm: row.upah_rm
      });

     const customTotals = await computeTotals([customItem], {
        supabase,
        shipping: DEFAULT_SHIPPING,
        payMethod: "CARD_EWALLET",
        discountSource,
        isRealApp: false,
        appPlatform: ""
      });

      const customFinalPrice = Number(customTotals?.grand || 0);
      const customJimat = Math.max(0, Number(customMarketPrice || 0) - customFinalPrice);

      designEntries.push({
        id: d.id,
        name: d.name,
        image_url: d.image_url || "",
        extra_custom_fee_rm: Number(d.extra_custom_fee_rm || 0),

        custom_market_price_rm: Number(customMarketPrice || 0),
        custom_final_price_rm: Number(customFinalPrice || 0),
        custom_jimat_rm: Number(customJimat || 0)
      });
    }

    const firstDesign = designEntries[0] || null;

    weights.push({
      weight_g: Number(row.weight_g || 0),
      weight_label: row.weight_label,

      ready_market_price_rm: Number(readyMarketPrice || 0),
      ready_final_price_rm: Number(readyFinalPrice || 0),
      ready_jimat_rm: Number(readyJimat || 0),

      custom_market_price_rm: Number(firstDesign?.custom_market_price_rm || 0),
      custom_final_price_rm: Number(firstDesign?.custom_final_price_rm || 0),
      custom_jimat_rm: Number(firstDesign?.custom_jimat_rm || 0),

      market_price_rm: Number(readyMarketPrice || 0),
      final_price_rm: Number(readyFinalPrice || 0),
      jimat_rm: Number(readyJimat || 0),

      designs: designEntries
    });
  }

  return { weights };
}

async function buildBuilderCardMeta(supabase, flow, threadRow) {
  const discountSource =
    getDiscountSourceFromThread(threadRow) ||
    flow.discount_source ||
    null;

  const allKinds = [
    { code: "coin", label: "Gold Coin" },
    { code: "dinar", label: "Koleksi Dinar" },
    { code: "bar",  label: "Gold Bar" }
  ];

  const catalog = {};
  for (const k of allKinds) {
    catalog[k.code] = await buildBuilderKindCatalog(
      supabase,
      k.code,
      discountSource
    );
  }

  const selectedKind = flow.kind ? normalizeKindForDb(flow.kind) : null;

  const weightRows = selectedKind
    ? (catalog[selectedKind]?.weights || [])
    : [];

  const selectedWeight =
    selectedKind && Number(flow.weight_g || 0) > 0
      ? weightRows.find(r => Number(r.weight_g) === Number(flow.weight_g))
      : null;

  const designs = selectedWeight
    ? (Array.isArray(selectedWeight.designs) ? selectedWeight.designs : [])
    : [];

  const chosenDesign =
    designs.find(d => String(d.id) === String(flow.selected_design_id || "")) ||
    designs.find(d => lower(d.name) === lower(flow.selected_design_name || "")) ||
    designs[0] ||
    null;

  const selectedCardType =
    upper(flow.card_type || "READY") === "CUSTOM" ? "CUSTOM" : "READY";

  const selectedQty = Math.max(1, Math.min(99, Math.floor(Number(flow.qty || 1) || 1)));

  let readyMarketPrice = 0;
  let readyFinalPrice = 0;
  let readyJimat = 0;

  let customMarketPrice = 0;
  let customFinalPrice = 0;
  let customJimat = 0;

  if (selectedWeight) {
    readyMarketPrice = Number(selectedWeight.ready_market_price_rm || 0);
    readyFinalPrice = Number(selectedWeight.ready_final_price_rm || 0);
    readyJimat = Number(selectedWeight.ready_jimat_rm || 0);
  }

  if (chosenDesign) {
    customMarketPrice = Number(chosenDesign.custom_market_price_rm || 0);
    customFinalPrice = Number(chosenDesign.custom_final_price_rm || 0);
    customJimat = Number(chosenDesign.custom_jimat_rm || 0);
  } else if (selectedWeight) {
    customMarketPrice = Number(selectedWeight.custom_market_price_rm || 0);
    customFinalPrice = Number(selectedWeight.custom_final_price_rm || 0);
    customJimat = Number(selectedWeight.custom_jimat_rm || 0);
  }

  const currentPerUnitMarket =
    selectedCardType === "CUSTOM"
      ? Number(customMarketPrice || 0)
      : Number(readyMarketPrice || 0);

  const currentPerUnitFinal =
    selectedCardType === "CUSTOM"
      ? Number(customFinalPrice || 0)
      : Number(readyFinalPrice || 0);

  const currentPerUnitJimat =
    selectedCardType === "CUSTOM"
      ? Number(customJimat || 0)
      : Number(readyJimat || 0);

  const currentTotalMarket = Number(currentPerUnitMarket || 0) * selectedQty;
  const currentTotalFinal = Number(currentPerUnitFinal || 0) * selectedQty;
  const currentTotalJimat = Number(currentPerUnitJimat || 0) * selectedQty;

  const currentItemReady =
    selectedKind && selectedWeight && chosenDesign
      ? simplifyCartItem({
          kind: selectedKind,
          weight_g: selectedWeight.weight_g,
          weight_label: selectedWeight.weight_label,
          cardType: selectedCardType,
          qty: selectedQty,
          unit: currentPerUnitMarket,
          design_id: chosenDesign.id,
          design_name: chosenDesign.name,
          custom_fee: selectedCardType === "CUSTOM"
            ? Number(chosenDesign.extra_custom_fee_rm || 0)
            : 0,
          price_per_g: 0,
          upah_rm: 0
        })
      : null;

  const cartLines = buildCartSummaryLines(flow.cart || []);
  const cartSubtotalRm = cartLines.reduce((s, x) => s + Number(x.total_rm || 0), 0);

  return {
    mode: "builder",
    started_from_custom_intent: !!flow.builder_started_from_custom_intent,

    catalog,

    kinds: allKinds.map(x => ({
      code: x.code,
      label: x.label,
      active: x.code === selectedKind,
      sort_no: kindOrderIndex(x.code)
    })),

    selected_kind: selectedKind,
    selected_kind_label: selectedKind ? kindLabel(selectedKind) : "",

    weights: weightRows.map(r => ({
      weight_g: Number(r.weight_g || 0),
      weight_label: r.weight_label,

      ready_market_price_rm: Number(r.ready_market_price_rm || 0),
      ready_final_price_rm: Number(r.ready_final_price_rm || 0),
      ready_jimat_rm: Number(r.ready_jimat_rm || 0),

      custom_market_price_rm: Number(r.custom_market_price_rm || 0),
      custom_final_price_rm: Number(r.custom_final_price_rm || 0),
      custom_jimat_rm: Number(r.custom_jimat_rm || 0),

      market_price_rm: Number(r.market_price_rm || 0),
      final_price_rm: Number(r.final_price_rm || 0),
      jimat_rm: Number(r.jimat_rm || 0),

      active: Number(r.weight_g || 0) === Number(flow.weight_g || 0)
    })),

    selected_weight_g: Number(flow.weight_g || 0) || null,
    selected_weight_label: flow.weight_label || "",

    designs: designs.map(d => ({
      id: d.id,
      name: d.name,
      image_url: d.image_url || "",

      custom_market_price_rm: Number(d.custom_market_price_rm || 0),
      custom_final_price_rm: Number(d.custom_final_price_rm || 0),
      custom_jimat_rm: Number(d.custom_jimat_rm || 0),

      active: String(d.id) === String(chosenDesign?.id || "")
    })),

    selected_design_id: chosenDesign?.id || null,
    selected_design_name: chosenDesign?.name || "",
    selected_design_image_url: chosenDesign?.image_url || "",

    selected_card_type: selectedCardType,
    selected_qty: selectedQty,

    ready_market_price_rm: Number(readyMarketPrice || 0),
    ready_final_price_rm: Number(readyFinalPrice || 0),
    ready_jimat_rm: Number(readyJimat || 0),

    custom_market_price_rm: Number(customMarketPrice || 0),
    custom_final_price_rm: Number(customFinalPrice || 0),
    custom_jimat_rm: Number(customJimat || 0),

    current_market_price_rm: Number(currentPerUnitMarket || 0),
    current_final_price_rm: Number(currentPerUnitFinal || 0),
    current_jimat_rm: Number(currentPerUnitJimat || 0),

    current_total_market_rm: Number(currentTotalMarket || 0),
    current_total_final_rm: Number(currentTotalFinal || 0),
    current_total_jimat_rm: Number(currentTotalJimat || 0),

    current_item_ready: currentItemReady,

    cart_items: cartLines,
    cart_count: cartLines.length,
    cart_subtotal_rm: Number(cartSubtotalRm || 0)
  };
}

function calcUnitPrice(hargaG, g, upah, cardType, extraCustomFeeRm) {
  const base =
    (Number(hargaG || 0) * Number(g || 0)) +
    Number(upah || 0) +
    (upper(cardType) === "CUSTOM" ? Number(extraCustomFeeRm || 0) : 0);

  return base * (1 + MARKUP_RATE);
}

function simplifyCartItem(item) {
  return {
    kind: normalizeKindForDb(item.kind),
    weight_g: Number(item.weight_g || 0),
    weight_label: norm(item.weight_label),
    cardType: upper(item.cardType || "READY"),
    qty: Number(item.qty || 1),
    unit: Number(item.unit || 0),
    design_id: item.design_id || null,
    design_name: norm(item.design_name),
    custom_fee: Number(item.custom_fee || 0),
    price_per_g: Number(item.price_per_g || 0),
    upah_rm: Number(item.upah_rm || 0)
  };
}

function buildCurrentItem(flow) {
  const unit = calcUnitPrice(
    flow.price_per_g,
    flow.weight_g,
    flow.upah_rm,
    flow.card_type,
    flow.selected_design_custom_fee_rm
  );

  return simplifyCartItem({
    kind: flow.kind,
    weight_g: flow.weight_g,
    weight_label: flow.weight_label,
    cardType: flow.card_type,
    qty: flow.qty,
    unit,
    design_id: flow.selected_design_id,
    design_name: flow.selected_design_name,
    custom_fee: flow.selected_design_custom_fee_rm || 0,
    price_per_g: flow.price_per_g,
    upah_rm: flow.upah_rm
  });
}

function resetCurrentBuilderSelection(flow) {
  return {
    ...flow,
    kind: null,
    weight_g: null,
    weight_label: null,
    upah_rm: 0,
    price_per_g: 0,
    selected_design_id: null,
    selected_design_name: "",
    selected_design_custom_fee_rm: 0,
    card_type: "READY",
    qty: 1,
    last_shown_weights: [],
    last_shown_designs: []
  };
}

function buildSingleSummaryReply(item) {
  const total = Number(item.unit || 0) * Number(item.qty || 0);

  return (
    `Baik, saya ringkaskan pesanan cik 😊\n\n` +
    `• Item: ${kindLabel(item.kind)}\n` +
    `• Berat: ${item.weight_label}\n` +
    `• Design: ${item.design_name}\n` +
    `• Kad: ${item.cardType === "CUSTOM" ? "Custom Card" : "Ready Card"}\n` +
    `• Qty: ${item.qty}\n` +
    `• Harga seunit: ${money(item.unit)}\n` +
    `• Jumlah: ${money(total)}\n\n` +
    `Balas salah satu:\n` +
    `1. *Tambah ke senarai*\n` +
    `2. *Checkout item ini sahaja*\n` +
    `3. *Batal*`
  );
}

function buildCartReply(cart) {
  if (!Array.isArray(cart) || !cart.length) {
    return `Senarai pesanan sementara masih kosong ya.`;
  }

  let subtotal = 0;
  const lines = cart.map((it, idx) => {
    const amount = Number(it.unit || 0) * Number(it.qty || 0);
    subtotal += amount;
    return (
      `${idx + 1}. ${kindLabel(it.kind)} — ${it.weight_label} — ${it.design_name}\n` +
      `   Kad: ${it.cardType === "CUSTOM" ? "Custom Card" : "Ready Card"} | Qty: ${it.qty} | Unit: ${money(it.unit)} | Jumlah: ${money(amount)}`
    );
  });

  return (
    `Senarai pesanan sementara cik 😊\n\n` +
    lines.join("\n\n") +
    `\n\nSubtotal: *${money(subtotal)}*\n\n` +
    `Balas salah satu:\n` +
    `• *Tambah lagi*\n` +
    `• *Checkout semua*\n` +
    `• *Batal*`
  );
}

function computeSubtotal(items) {
  return (items || []).reduce((sum, it) => {
    return sum + (Number(it.unit || 0) * Number(it.qty || 0));
  }, 0);
}

function getPaymentDiscountAmount(method, base, discountMap) {
  const rule = discountMap?.[method] || { type: "PERCENT", value: 0 };

  if (rule.type === "PERCENT") return base * (Number(rule.value || 0) / 100);
  if (rule.type === "FIXED") return Math.min(base, Number(rule.value || 0));

  return 0;
}

function normalizeDiscountRule(row) {
  if (!row) return null;

  const discountType = upper(row.discount_type || row.type || "AMOUNT");
  const discountValue = Number(row.discount_value ?? row.value ?? 0);

  return {
    id: row.id || null,
    source: upper(row.source || "AI_DAN"),
    kind: row.kind ? normalizeKindForDb(row.kind) : null,
    weight_g: row.weight_g !== null && row.weight_g !== undefined ? Number(row.weight_g) : null,
    discount_type: discountType,
    discount_value: discountValue,
    label: norm(row.label || row.name || "Diskaun AI-Dan"),
    priority: Number(row.priority || 0),
    is_active: row.is_active !== false
  };
}

async function listDiscountRules(supabase, { source, kind, weight_g }) {
  if (!source) return [];

  try {
    let q = supabase
      .from(GOLD999_DISCOUNT_TABLE)
      .select("id,source,kind,weight_g,discount_type,discount_value,label,priority,is_active")
      .eq("is_active", true)
      .eq("source", String(source).toUpperCase());

    if (kind) q = q.eq("kind", normalizeKindForDb(kind));
    if (weight_g !== null && weight_g !== undefined) q = q.eq("weight_g", Number(weight_g));

    const { data, error } = await q.order("priority", { ascending: true });

    if (error) {
      console.warn("[chat-gold999] listDiscountRules error:", error);
      return [];
    }

    return (data || []).map(normalizeDiscountRule).filter(Boolean);
  } catch (err) {
    console.warn("[chat-gold999] listDiscountRules exception:", err);
    return [];
  }
}

async function findBestDiscountRule(supabase, { source, kind, weight_g }) {
  const rules = await listDiscountRules(supabase, { source, kind, weight_g });
  if (!rules.length) return null;

  const exact = rules.find(r =>
    r.is_active === true &&
    normalizeKindForDb(r.kind) === normalizeKindForDb(kind) &&
    Number(r.weight_g) === Number(weight_g)
  );
  if (exact) return exact;

  const kindOnly = rules.find(r =>
    r.is_active === true &&
    normalizeKindForDb(r.kind) === normalizeKindForDb(kind) &&
    (r.weight_g === null || r.weight_g === undefined)
  );
  if (kindOnly) return kindOnly;

  const sourceOnly = rules.find(r =>
    r.is_active === true &&
    (!r.kind) &&
    (r.weight_g === null || r.weight_g === undefined)
  );
  if (sourceOnly) return sourceOnly;

  return rules[0] || null;
}

function getPromoDiscountAmount(rule, baseAmount) {
  if (!rule) return 0;

  const type = upper(rule.discount_type || "AMOUNT");
  const value = Number(rule.discount_value || 0);
  const base = Number(baseAmount || 0);

  if (!(base > 0)) return 0;
  if (!(value > 0)) return 0;

  if (type === "PERCENT") {
    return base * (value / 100);
  }

  if (type === "AMOUNT" || type === "FIXED") {
    return Math.min(base, value);
  }

  return 0;
}

function buildPromoLabel(rule) {
  if (!rule) return "Diskaun promo";
  return norm(rule.label || "Diskaun promo");
}

function serializeDiscountRule(rule) {
  if (!rule) return null;
  return {
    id: rule.id || null,
    source: rule.source || null,
    kind: rule.kind || null,
    weight_g: rule.weight_g !== null && rule.weight_g !== undefined ? Number(rule.weight_g) : null,
    discount_type: rule.discount_type || null,
    discount_value: Number(rule.discount_value || 0),
    label: rule.label || null,
    priority: Number(rule.priority || 0)
  };
}

async function computeTotals(items, options = {}) {
  const paymentDiscounts = options.paymentDiscounts || DEFAULT_PAYMENT_DISCOUNTS;
  const shipping = options.shipping || DEFAULT_SHIPPING;
  const payMethod = upper(options.payMethod || "CARD_EWALLET");
  const discountSource = options.discountSource || "AI_DAN";
  const supabase = options.supabase || null;

  const isRealApp = options.isRealApp === true;
  const appPlatform = upper(options.appPlatform || "");

  const subtotal = computeSubtotal(items);
  const ship = Number(shipping.rm || 0);

  // Diskaun hanya atas subtotal barang, bukan atas caj pos
  const discountBase = subtotal;

  const payDisc = getPaymentDiscountAmount(payMethod, discountBase, paymentDiscounts);
  const afterPay = Math.max(0, discountBase - payDisc);

  let promoRule = null;
  let promoDisc = 0;
  let promoLabel = null;

  if (supabase && discountSource && Array.isArray(items) && items.length > 0) {
    let promoTotal = 0;
    const promoLabels = [];
    let firstPromoRule = null;

    for (const item of items) {
      const itemAmount = Number(item.unit || 0) * Number(item.qty || 0);
      if (!(itemAmount > 0)) continue;

      const itemAfterPay = Math.max(
        0,
        itemAmount - getPaymentDiscountAmount(payMethod, itemAmount, paymentDiscounts)
      );

      const rule = await findBestDiscountRule(supabase, {
        source: discountSource,
        kind: item.kind,
        weight_g: item.weight_g
      });

      if (!rule) continue;

      const itemPromo = getPromoDiscountAmount(rule, itemAfterPay);
      if (!(itemPromo > 0)) continue;

      promoTotal += itemPromo;

      if (!firstPromoRule) firstPromoRule = rule;

      const label = buildPromoLabel(rule);
      if (label && !promoLabels.includes(label)) {
        promoLabels.push(label);
      }
    }

    promoDisc = promoTotal;
    promoRule = firstPromoRule || null;
    promoLabel = promoLabels.length <= 1
      ? (promoLabels[0] || null)
      : "Diskaun Ai-Dan";
  }

 let appDisc = 0;
  let appDiscLabel = null;

  if (isRealApp && supabase) {
    try {
      const { data: promoRow, error: promoErr } = await supabase
        .from("gold999_app_platform_promo")
        .select("appstore_rm, playstore_rm")
        .eq("id", 1)
        .maybeSingle();

      if (!promoErr && promoRow) {
        if (appPlatform === "APPSTORE") {
          appDisc = Number(promoRow.appstore_rm || 0);
          if (appDisc > 0) appDiscLabel = "Promo App Store";
        } else if (appPlatform === "PLAYSTORE") {
          appDisc = Number(promoRow.playstore_rm || 0);
          if (appDisc > 0) appDiscLabel = "Promo Play Store";
        }
      }
    } catch (err) {
      console.warn("[chat-gold999] app promo load error:", err);
    }
  }

  appDisc = Math.min(Math.max(0, afterPay - promoDisc), appDisc);

  // Pos ditambah paling akhir
  const grand = Math.max(0, afterPay - promoDisc - appDisc + ship);

  return {
    subtotal,
    ship,
    before: subtotal + ship,
    payDisc,
    promoDisc,
    promoLabel,
    appDisc,
    appDiscLabel,
    grand,
    payMethod,
    discountSource: discountSource || null,
    promoRule: serializeDiscountRule(promoRule)
  };
}function buildItemsLines(items) {
  return (items || []).map((it, idx) => {
    const amount = Number(it.unit || 0) * Number(it.qty || 0);
    return (
      `${idx + 1}. ${kindLabel(it.kind)} — ${it.weight_label} — ${it.design_name}\n` +
      `   Kad: ${it.cardType === "CUSTOM" ? "Custom Card" : "Ready Card"} | Qty: ${it.qty} | Unit: ${money(it.unit)} | Jumlah: ${money(amount)}`
    );
  });
}

function buildCheckoutReply(items, totals, refs) {
  const lines = buildItemsLines(items);
  const refText = Array.isArray(refs) && refs.length ? refs.join(", ") : "";
  const showRefs = !!refText;

  let promoLine = "";
  if (Number(totals.promoDisc || 0) > 0) {
    promoLine = `• ${totals.promoLabel || "Diskaun promo"}: -${money(totals.promoDisc)}\n`;
  }

  let appPromoLine = "";
  if (Number(totals.appDisc || 0) > 0) {
    appPromoLine = `• ${totals.appDiscLabel || "Promo App"}: -${money(totals.appDisc)}\n`;
  }

  return (
    `Baik cik 😊 Pesanan 999.9 telah disediakan.\n\n` +
    `Item pesanan:\n` +
    lines.join("\n\n") +
    `\n\nRingkasan:\n` +
    `• Subtotal: ${money(totals.subtotal)}\n` +
    `• Pos: ${money(totals.ship)}\n` +
    `• Diskaun kaedah bayaran: -${money(totals.payDisc)}\n` +
    promoLine +
    appPromoLine +
    `• Jumlah akhir anggaran: *${money(totals.grand)}*\n` +
    (showRefs ? `• Rujukan order: *${refText}*\n` : ``) +
    `\nCik nak *pos* atau *ambil di kedai*?`
  );
}
function buildAskShipModeReply() {
  return (
    `Baik cik 😊 Sebelum teruskan bayaran,\n` +
    `cik nak *Pos* atau *Ambil di Kedai*?\n\n` +
    `1. *Ambil di Kedai*\n` +
    `2. *Pos*`
  );
}

function buildAskPickupWhenReply() {
  return (
    `Baik cik 😊✅ Pilihan: *Ambil di Kedai*\n\n` +
    `Cik nak datang bila ya?\n\n` +
    `Contoh balas:\n` +
    `• *Secepat mungkin*\n` +
    `• *Bila dah siap*\n` +
    `• *2 hari lagi*`
  );
}

function buildConfirmAddressReply(addr, fee, label) {
  return (
    `Baik cik 😊✅ Pilihan: *Pos*\n\n` +
    `📍 Alamat penghantaran kami rekod:\n` +
    `${addr}\n\n` +
    `📦 Caj pos: *${money(fee)}* (${label})\n\n` +
    `Alamat ni betul?\n` +
    `✅ Balas *ALAMAT BETUL*\n` +
    `✍️ Balas *ALAMAT SALAH*`
  );
}

function buildNeedNewAddressReply() {
  return (
    `Baik cik 😊\n` +
    `Sila taip *alamat baru penuh* ya.\n\n` +
    `Format:\n` +
    `Alamat + Poskod + Bandar + Negeri`
  );
}

function buildAskPaymentMethodReply(items, totals, refs, flow) {
  const lines = buildItemsLines(items);
  const refText = Array.isArray(refs) && refs.length ? refs.join(", ") : "-";
  const showRefs = !!refText;

  let promoLine = "";
  if (Number(totals.promoDisc || 0) > 0) {
    promoLine = `• ${totals.promoLabel || "Diskaun promo"}: -${money(totals.promoDisc)}\n`;
  }

  let appPromoLine = "";
  if (Number(totals.appDisc || 0) > 0) {
    appPromoLine = `• ${totals.appDiscLabel || "Promo App"}: -${money(totals.appDisc)}\n`;
  }

  const shipLine =
    String(flow.ship_mode || "").toUpperCase() === "POST"
      ? `• Pos: ${money(flow.ship_fee_rm || 0)}${flow.ship_label ? ` (${flow.ship_label})` : ""}\n`
      : `• Ambil di kedai: ${flow.pickup_when_text || "-"}\n`;

  return (
    `Baik cik 😊 Ringkasan pesanan 999.9:\n\n` +
    `Item pesanan:\n` +
    lines.join("\n\n") +
    `\n\nRingkasan:\n` +
    `• Subtotal: ${money(totals.subtotal)}\n` +
    shipLine +
    `• Diskaun kaedah bayaran: -${money(totals.payDisc)}\n` +
    promoLine +
    appPromoLine +
    `• Jumlah akhir perlu dibayar: *${money(totals.grand)}*\n` +
    (showRefs ? `• Rujukan order: *${refText}*\n` : "") +
    `\nCik nak bayar guna apa?\n\n` +
    `1. *QR*\n` +
    `2. *TRANSFER*\n\n` +
    `Jika nak keluar flow ini, balas: *Batal*\n` +
    `Jika nak mula semula dari awal, balas: *Mula semula*`
  );
}

function buildPaymentDetailsReply(items, totals, refs, flow, payMethod) {
  const lines = buildItemsLines(items);
  const refText = Array.isArray(refs) && refs.length ? refs.join(", ") : "-";

  const bankName = process.env.BANK_NAME || "Maybank";
  const bankAccName = process.env.BANK_ACC_NAME || "EMAS AMIR SDN. BHD.";
  const bankAccNo = process.env.BANK_ACC_NO || "552031155695";
  const bankQrUrl =
    process.env.BANK_QR_URL ||
    process.env.QR_DUITNOW_URL ||
    "https://emasamir.app/qr-maybank.html";

  let promoLine = "";
  if (Number(totals.promoDisc || 0) > 0) {
    promoLine = `• ${totals.promoLabel || "Diskaun promo"}: *-${money(totals.promoDisc)}*\n`;
  }

  let appPromoLine = "";
  if (Number(totals.appDisc || 0) > 0) {
    appPromoLine = `• ${totals.appDiscLabel || "Promo App"}: *-${money(totals.appDisc)}*\n`;
  }

  const shipLine =
    String(flow.ship_mode || "").toUpperCase() === "POST"
      ? `• Caj pos: ${money(flow.ship_fee_rm || 0)}${flow.ship_label ? ` (${flow.ship_label})` : ""}\n• Alamat: ${flow.addr_text || "-"}\n`
      : `• Ambil di kedai: ${flow.pickup_when_text || "-"}\n`;

  const methodText = payMethod === "QR" ? "QR" : "Bank Transfer";

  return (
    `Baik cik 😊✅ Pilihan: *${methodText}*\n\n` +
    `Rujukan order: *${refText}*\n\n` +
    `Ringkasan bayaran:\n` +
    lines.map(l => `• ${l.replace(/\n/g, "\n  ")}`).join("\n") + `\n` +
    `• Subtotal: *${money(totals.subtotal)}*\n` +
    shipLine +
    `• Diskaun kaedah bayaran: *-${money(totals.payDisc)}*\n` +
    promoLine +
    appPromoLine +
    `✅ Jumlah akhir perlu dibayar: *${money(totals.grand)}*\n\n` +
    `Maklumat bayaran:\n` +
    `Bank: ${bankName}\n` +
    `Nama Akaun: ${bankAccName}\n` +
    `No Akaun: ${bankAccNo}\n\n` +
    `QR DuitNow / QR Transfer:\n${bankQrUrl}\n\n` +
    `Selepas berjaya bayar, sila hantar *slip / resit* ya untuk semakan. 🙏`
  );
}
async function prepareOrderOnServer(supabase, item) {
  const payload = {
    p_kind: normalizeKindForOrder(item.kind),
    p_weight_g: Number(item.weight_g || 0),
    p_design_id: item.design_id || null,
    p_design_name: item.design_name || null,
    p_card_type: upper(item.cardType || "READY"),
    p_qty: Number(item.qty || 1),
    p_price_per_g: Number(item.price_per_g || 0),
    p_upah_rm: Number(item.upah_rm || 0),
    p_custom_fee_rm: Number(item.custom_fee || 0)
  };

  const { data, error } = await supabase.rpc(ORDER_PREPARE_RPC, payload);
  if (error) throw error;

  if (typeof data === "string" && data) {
    return data;
  }

  const row = Array.isArray(data) ? data[0] : data;
  const ref =
    row?.reference_1 ||
    row?.reference ||
    row?.order_id ||
    row?.goldbar_order_id ||
    row?.id ||
    null;

  if (!ref) {
    throw new Error("Rujukan pesanan 999.9 tidak diterima daripada server.");
  }

  return String(ref);
}

async function createRefsForItems(supabase, items) {
  const refs = [];
  for (const it of items) {
    const ref = await prepareOrderOnServer(supabase, it);
    refs.push(String(ref));
  }
  return refs;
}

function makeCheckoutGroupCode() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `gbg_${Date.now()}_${rand}`;
}

async function finalizePreparedOrders(supabase, refs, items, flow, threadId, threadRow, totals, payMethod) {
  const refList = Array.isArray(refs) ? refs.slice() : [];
  const itemList = Array.isArray(items) ? items.slice() : [];

  if (!refList.length) throw new Error("Tiada rujukan order untuk finalize.");
  if (!itemList.length) throw new Error("Tiada item untuk finalize.");
  if (refList.length !== itemList.length) {
    throw new Error("Bilangan refs dan items tidak sama.");
  }

const customerPhone = norm(threadRow?.customer_phone || null) || null;

let customerName =
  norm(flow?.customer_profile?.name) ||
  norm(threadRow?.customer_name) ||
  null;

// fallback: kalau order dari comment → Ai-Dan tapi threadRow tak bawa nama
if (!customerName && customerPhone) {
  try {
    const foundCustomer =
      flow?.customer_profile ||
      await findCustomerByThreadPhone(supabase, threadRow);

    customerName =
      norm(foundCustomer?.name) ||
      norm(foundCustomer?.full_name) ||
      norm(foundCustomer?.customer_name) ||
      null;
  } catch (e) {
    console.warn("[chat-gold999] customer name fallback gagal:", e);
  }
}
  const shipAll = Number(flow?.ship_mode === "POST" ? (flow?.ship_fee_rm || 0) : 0);
const payDiscAll = Number(totals?.payDisc || 0);
const promoDiscAll = Number(totals?.promoDisc || 0);
const appDiscAll = Number(totals?.appDisc || 0);

// 1 checkout = 1 group baru
const existingGroupCode = norm(flow?.checkout_group_code || "");
const groupCode = existingGroupCode || makeCheckoutGroupCode();

  for (let i = 0; i < refList.length; i++) {
    const ref = String(refList[i]);
    const item = itemList[i];

    const itemSubtotal = Number(item.unit || 0) * Number(item.qty || 0);
    const isFirst = i === 0;

   const shippingRm = isFirst ? shipAll : 0;
    const payDiscRm = isFirst ? payDiscAll : 0;
    const couponDiscRm = isFirst ? promoDiscAll : 0;
    const appDiscRm = isFirst ? appDiscAll : 0;
    const grandTotalRm = Math.max(0, itemSubtotal + shippingRm - payDiscRm - couponDiscRm - appDiscRm);

    const payload = {
      customer_phone: customerPhone,
      customer_name: customerName,
      subtotal_rm: itemSubtotal,
      shipping_rm: shippingRm,
      pay_disc_rm: payDiscRm,
      coupon_disc_rm: couponDiscRm,
      grand_total_rm: grandTotalRm,
      total_rm: grandTotalRm,
      amount_cents: Math.round(grandTotalRm * 100),
      checkout_group: groupCode,
      status: "PENDING",
      amount_mismatch: false
    };

    const { error } = await supabase
      .from("goldbar_order")
      .update(payload)
      .or(`reference_1.eq.${ref},id.eq.${ref}`);

    if (error) {
      console.warn("[chat-gold999] finalizePreparedOrders update error:", error);
      throw error;
    }
  }

  return {
    ok: true,
    checkout_group_code: groupCode
  };
}

function buildStartFlow() {
  const flow = makeEmptyFlow();
  flow.active = true;
  flow.step = "choose_kind";
  return flow;
}

function replyResult(reply, action, extraMeta) {
  return {
    reply,
    action,
    meta: extraMeta || {}
  };
}

async function resetFlow(supabase, threadId, threadRow) {
  const nextFlow = makeEmptyFlow();
  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    `Assalamualaikum cik 😊\n\n` +
    `Saya Ai–Dan, pembantu untuk Paksu Emas Amir.\n` +
    `Saya akan bantu cik mudahkan urusan pembelian dari LIVE Paksu.\n\n` +
    `Kalau cik ada soalan selain “lock LIVE”, cik boleh tanya juga ya — insyaAllah saya cuba jawab. Jika saya tak pasti, staf kami akan hubungi cik semula di WhatsApp.\n\n` +
    `✅ Jika cik ada lock barang dalam LIVE, sila balas:\n` +
    `“Ya, saya ada lock dalam LIVE”\n\n` +
    `🧾 Jika cik sudah buat bayaran, sila balas:\n` +
    `“Saya dah bayar (hantar slip)”\n` +
    `dan hantar slip bayaran di sini ya.\n\n` +
    `🪙 Jika cik berminat untuk membeli gold coin custom, sila balas:\n` +
    `“Ya, saya berminat gold coin custom”\n\n` +
    `❌ Jika cik tidak ada lock, cik boleh balas:\n` +
    `“Tiada lock”\n` +
    `atau terus tanya soalan yang cik nak 😊`,
    "gold999_exit_flow",
    {
      gold999: { reset: true, active: false },
      quick_replies: makeQuickReplies([
        { label: "🔐 Ya, saya ada lock dalam LIVE", send: "Ya, saya ada lock dalam LIVE" },
        { label: "🧾 Saya dah bayar (hantar slip)", send: "Saya dah bayar (hantar slip)" },
        { label: "🪙 Ya, saya berminat gold coin custom", send: "Ya, saya berminat gold coin custom" },
        { label: "💬 Tiada lock / Tanya Ai-Dan", send: "Tiada lock" }
      ])
    }
  );
}

async function handleChooseKind(supabase, threadId, threadRow, flow, text) {
  const kind = detectKindFromText(text);

  if (!kind) {
    return replyResult(
      `Baik cik 😊 Saya perlukan pilihan kategori dulu ya.`,
      "gold999_ask_kind",
      {
        gold999: { step: "choose_kind" },
        builder_card: await buildBuilderCardMeta(supabase, flow, threadRow),
        quick_replies: makeQuickReplies([
          { label: "Gold Coin", send: "Gold Coin" },
          { label: "Koleksi Dinar", send: "Dinar" },
          { label: "Gold Bar", send: "Gold Bar" }
        ])
      }
    );
  }

  const rows = await getKindPriceRows(supabase, kind);
  const firstWeight = rows[0] || null;

  const nextFlow = {
    ...flow,
    active: true,
    builder_mode: true,
    kind: normalizeKindForDb(kind),
    step: firstWeight ? "choose_weight" : "choose_kind",
    weight_g: firstWeight ? Number(firstWeight.weight_g) : null,
    weight_label: firstWeight ? firstWeight.weight_label : null,
    upah_rm: firstWeight ? Number(firstWeight.upah_rm || 0) : 0,
    price_per_g: firstWeight ? Number(firstWeight.price_per_g || 0) : 0,
    selected_design_id: null,
    selected_design_name: "",
    selected_design_custom_fee_rm: 0,
    card_type: "READY",
    qty: 1,
    last_shown_weights: rows.map(r => ({
      kind: r.kind,
      weight_g: r.weight_g,
      weight_label: r.weight_label,
      upah_rm: r.upah_rm,
      price_per_g: r.price_per_g,
      harga_jual: r.harga_jual
    }))
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    `Baik cik 😊 Sila lengkapkan pilihan dalam kad di bawah ya.`,
    "gold999_show_builder_after_kind",
    {
      gold999: {
        step: "choose_weight",
        kind: normalizeKindForDb(kind)
      },
      builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
    }
  );
}

async function handleChooseDesign(supabase, threadId, threadRow, flow, text) {
  const designs = Array.isArray(flow.last_shown_designs) && flow.last_shown_designs.length
    ? flow.last_shown_designs
    : await listDesigns(supabase, flow.kind, flow.weight_g);

  const picked = findDesignFromText(designs, text);

  if (!picked) {
    return replyResult(
      `Baik cik 😊 Sila pilih salah satu design yang saya senaraikan ya.`,
      "gold999_ask_design_again",
      {
        gold999: {
          step: "choose_design",
          kind: flow.kind,
          weight_g: flow.weight_g,
          weight_label: flow.weight_label
        },
        builder_card: await buildBuilderCardMeta(supabase, flow, threadRow),
        design_cards: makeDesignCards(designs.slice(0, 12)),
        quick_replies: designs.slice(0, 10).map(d => ({
          label: d.name,
          send: d.name
        }))
      }
    );
  }

  const nextFlow = {
    ...flow,
    selected_design_id: picked.id,
    selected_design_name: picked.name,
    selected_design_custom_fee_rm: Number(picked.extra_custom_fee_rm || 0),
    card_type: flow.card_type || "READY",
    qty: Number(flow.qty || 1),
    step: "choose_config"
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    `Baik cik 😊 Sila lengkapkan pilihan dalam kad di bawah ya.`,
    "gold999_show_builder_after_design",
    {
      gold999: {
        step: "choose_config",
        design_id: picked.id,
        design_name: picked.name,
        weight_g: nextFlow.weight_g,
        weight_label: nextFlow.weight_label
      },
      builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
    }
  );
}async function handleChooseWeight(supabase, threadId, threadRow, flow, text) {
  const rows = Array.isArray(flow.last_shown_weights) && flow.last_shown_weights.length
    ? flow.last_shown_weights
    : await getKindPriceRows(supabase, flow.kind);

  const picked = findWeightRowFromText(rows, text);

  if (!picked) {
    return replyResult(
      `Baik cik 😊 Sila pilih salah satu berat yang disenaraikan ya.`,
      "gold999_ask_weight_again",
      {
        gold999: { step: "choose_weight", kind: flow.kind },
        builder_card: await buildBuilderCardMeta(supabase, flow, threadRow),
        quick_replies: rows.slice(0, 10).map(r => ({
          label: r.weight_label,
          send: r.weight_label
        }))
      }
    );
  }

  const designs = await listDesigns(supabase, flow.kind, picked.weight_g);
  const firstDesign = designs[0] || null;

  const nextFlow = {
    ...flow,
    weight_g: Number(picked.weight_g),
    weight_label: picked.weight_label,
    upah_rm: Number(picked.upah_rm || 0),
    price_per_g: Number(picked.price_per_g || 0),
    selected_design_id: firstDesign ? firstDesign.id : null,
    selected_design_name: firstDesign ? firstDesign.name : "",
    selected_design_custom_fee_rm: firstDesign ? Number(firstDesign.extra_custom_fee_rm || 0) : 0,
    card_type: "READY",
    qty: 1,
    step: "choose_design",
    last_shown_designs: designs.map(d => ({
      id: d.id,
      name: d.name,
      image_url: d.image_url,
      extra_custom_fee_rm: d.extra_custom_fee_rm
    }))
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    `Baik cik 😊 Sila lengkapkan pilihan dalam kad di bawah ya.`,
    "gold999_show_builder_after_weight",
    {
      gold999: {
        step: "choose_design",
        kind: flow.kind,
        weight_g: Number(picked.weight_g),
        weight_label: picked.weight_label
      },
      builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
    }
  );
}

async function handleChooseConfig(supabase, threadId, threadRow, flow, text) {
  const picked = parseConfigChoice(text);

  let selectedDesignId = picked.designId || flow.selected_design_id || null;
  let selectedDesignName = flow.selected_design_name || "";
  let selectedDesignCustomFeeRm = Number(flow.selected_design_custom_fee_rm || 0);

  const freshDesigns = await listDesigns(supabase, flow.kind, flow.weight_g);
  const selectedDesign =
    freshDesigns.find(d => String(d.id) === String(selectedDesignId)) ||
    freshDesigns.find(d => lower(d.name) === lower(selectedDesignName)) ||
    null;

  if (selectedDesign) {
    selectedDesignId = selectedDesign.id;
    selectedDesignName = selectedDesign.name;
    selectedDesignCustomFeeRm = Number(selectedDesign.extra_custom_fee_rm || 0);
  }

  if (!selectedDesignId || !picked.cardType || !picked.qty) {
    const previewFlow = {
      ...flow,
      selected_design_id: selectedDesignId,
      selected_design_name: selectedDesignName,
      selected_design_custom_fee_rm: selectedDesignCustomFeeRm
    };

    const configCard = await buildConfigCardMeta(supabase, previewFlow, threadRow);

    return replyResult(
      `Baik cik 😊 Sila lengkapkan pilihan dalam kad di bawah ya.`,
      "gold999_ask_config_again",
      {
        gold999: {
          step: "choose_config",
          design_id: previewFlow.selected_design_id,
          design_name: previewFlow.selected_design_name,
          weight_g: previewFlow.weight_g,
          weight_label: previewFlow.weight_label
        },
        config_card: configCard
      }
    );
  }

  const nextFlow = {
    ...flow,
    selected_design_id: selectedDesignId,
    selected_design_name: selectedDesignName,
    selected_design_custom_fee_rm: selectedDesignCustomFeeRm,
    card_type: picked.cardType,
    qty: picked.qty,
    step: "post_item_choice"
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  const item = buildCurrentItem(nextFlow);

  return replyResult(
    buildSingleSummaryReply(item),
    "gold999_item_summary",
    {
      gold999: {
        step: "post_item_choice",
        qty: picked.qty,
        card_type: picked.cardType,
        current_item: item
      },
      quick_replies: makeQuickReplies([
        { label: "Tambah ke Senarai", send: "Tambah ke senarai" },
        { label: "Checkout Item Ini", send: "Checkout item ini sahaja" },
        { label: "Batal", send: "Batal" }
      ])
    }
  );
}async function handlePostItemChoice(supabase, threadId, threadRow, flow, text) {
  const t = lower(text);
  const currentItem = buildCurrentItem(flow);
  const discountSource = getDiscountSourceFromThread(threadRow);

  if (t.includes("tambah ke senarai") || t === "1") {
    const cart = Array.isArray(flow.cart) ? flow.cart.slice() : [];
    cart.push(currentItem);

    const nextFlow = {
      ...flow,
      cart,
      prepared_refs: [],
      prepared_checkout_mode: null,
      prepared_totals: null,
      prepared_discount_rule: null,
      prepared_items: [],
      discount_source: discountSource || null,
      discount_enabled: !!discountSource,
      step: "after_cart"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      buildCartReply(cart),
      "gold999_added_to_cart",
      {
        gold999: {
          step: "after_cart",
          cart_count: cart.length,
          discount_source: discountSource || null
        },
        quick_replies: makeQuickReplies([
          { label: "Tambah Lagi", send: "Tambah lagi" },
          { label: "Checkout Semua", send: "Checkout semua" },
          { label: "Batal", send: "Batal" }
        ])
      }
    );
  }

  if (t.includes("checkout item") || t === "2") {
    const items = [currentItem];
    const totals = await computeTotals(items, {
      supabase,
      shipping: DEFAULT_SHIPPING,
      payMethod: "CARD_EWALLET",
      discountSource,
      isRealApp: flow.is_real_app === true,
      appPlatform: flow.app_platform || ""
    });

    const customer = await findCustomerByThreadPhone(supabase, threadRow);
    const nextFlow = {
  ...flow,
  prepared_refs: [],
  prepared_checkout_mode: "single",
  prepared_totals: totals,
  prepared_discount_rule: totals.promoRule || null,
  prepared_items: items,
  checkout_group_code: null,
      discount_source: discountSource || null,
      discount_enabled: !!discountSource,
      customer_country: detectCountryFromPhone(threadRow?.customer_phone || ""),
      customer_profile: customer || null,
      ship_mode: null,
      ship_code: null,
      ship_label: null,
      ship_fee_rm: 0,
      pickup_when_text: "",
      addr_text: "",
      addr_need_new: false,
      pay_method: null,
      step: "await_ship_mode"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      buildCheckoutReply(items, totals, []) + `\n\n` + buildAskShipModeReply(),
      "gold999_checkout_single_ready",
      {
        gold999: {
          step: "await_ship_mode",
          refs: [],
          checkout_mode: "single",
          items,
          totals,
          discount_source: discountSource || null,
          discount_rule: totals.promoRule || null
        },
        quick_replies: makeQuickReplies([
          { label: "Ambil di Kedai", send: "Ambil di kedai" },
          { label: "Pos", send: "Pos" }
        ])
      }
    );
  }

  if (t.includes("batal") || t === "3") {
    return resetFlow(supabase, threadId, threadRow);
  }

  return replyResult(
    `Baik cik 😊 Sila balas salah satu pilihan berikut ya:\n\n` +
    `1. *Tambah ke senarai*\n` +
    `2. *Checkout item ini sahaja*\n` +
    `3. *Batal*`,
    "gold999_ask_post_item_choice_again",
    {
      gold999: { step: "post_item_choice" },
      quick_replies: makeQuickReplies([
        { label: "Tambah ke Senarai", send: "Tambah ke senarai" },
        { label: "Checkout Item Ini", send: "Checkout item ini sahaja" },
        { label: "Batal", send: "Batal" }
      ])
    }
  );
}

async function handleAfterCart(supabase, threadId, threadRow, flow, text) {
  if (isShowListCommand(text)) {
    return replyResult(
      buildCartReply(flow.cart),
      "gold999_show_cart",
      {
        gold999: {
          step: "after_cart",
          cart_count: Array.isArray(flow.cart) ? flow.cart.length : 0
        },
        quick_replies: makeQuickReplies([
          { label: "Tambah Lagi", send: "Tambah lagi" },
          { label: "Checkout Semua", send: "Checkout semua" },
          { label: "Batal", send: "Batal" }
        ])
      }
    );
  }

  if (isAddMoreCommand(text)) {
    const nextFlow = {
      ...flow,
      kind: null,
      weight_g: null,
      weight_label: null,
      upah_rm: 0,
      price_per_g: 0,
      selected_design_id: null,
      selected_design_name: "",
      selected_design_custom_fee_rm: 0,
      card_type: "READY",
      qty: 1,
      step: "choose_kind",
      last_shown_weights: [],
      last_shown_designs: [],
      prepared_refs: [],
      prepared_checkout_mode: null,
      prepared_totals: null,
      prepared_discount_rule: null,
      prepared_items: [],
      ship_mode: null,
      ship_code: null,
      ship_label: null,
      ship_fee_rm: 0,
      pickup_when_text: "",
      addr_text: "",
      addr_need_new: false,
      pay_method: null
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      `Baik cik 😊 Kita tambah item baru ya.\n\n` + buildCategoryReply(),
      "gold999_add_more",
      {
        gold999: { step: "choose_kind" },
        quick_replies: makeQuickReplies([
          { label: "Gold Coin", send: "Gold Coin" },
          { label: "Koleksi Dinar", send: "Dinar" },
          { label: "Gold Bar", send: "Gold Bar" }
        ])
      }
    );
  }

  if (isCheckoutAllCommand(text)) {
    const cart = Array.isArray(flow.cart) ? flow.cart.slice() : [];

   if (!cart.length) {
      return replyResult(
        `Senarai pesanan masih kosong ya.`,
        "gold999_cart_empty",
        { gold999: { step: "after_cart" } }
      );
    }

    const discountSource = getDiscountSourceFromThread(threadRow);
   const totals = await computeTotals(cart, {
      supabase,
      shipping: DEFAULT_SHIPPING,
      payMethod: "CARD_EWALLET",
      discountSource,
      isRealApp: flow.is_real_app === true,
      appPlatform: flow.app_platform || ""
    });

    const customer = await findCustomerByThreadPhone(supabase, threadRow);
   const nextFlow = {
  ...flow,
  prepared_refs: [],
  prepared_checkout_mode: "all",
  prepared_totals: totals,
  prepared_discount_rule: totals.promoRule || null,
  prepared_items: cart,
  checkout_group_code: null,
      discount_source: discountSource || null,
      discount_enabled: !!discountSource,
      customer_country: detectCountryFromPhone(threadRow?.customer_phone || ""),
      customer_profile: customer || null,
      ship_mode: null,
      ship_code: null,
      ship_label: null,
      ship_fee_rm: 0,
      pickup_when_text: "",
      addr_text: "",
      addr_need_new: false,
      pay_method: null,
      step: "await_ship_mode"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      buildCheckoutReply(cart, totals, []) + `\n\n` + buildAskShipModeReply(),
      "gold999_checkout_all_ready",
      {
        gold999: {
          step: "await_ship_mode",
          refs: [],
          checkout_mode: "all",
          items: cart,
          totals,
          discount_source: discountSource || null,
          discount_rule: totals.promoRule || null
        },
        quick_replies: makeQuickReplies([
          { label: "Ambil di Kedai", send: "Ambil di kedai" },
          { label: "Pos", send: "Pos" }
        ])
      }
    );
  }

  return replyResult(
    buildCartReply(flow.cart),
    "gold999_prompt_after_cart",
    {
      gold999: {
        step: "after_cart",
        cart_count: Array.isArray(flow.cart) ? flow.cart.length : 0
      },
      quick_replies: makeQuickReplies([
        { label: "Tambah Lagi", send: "Tambah lagi" },
        { label: "Checkout Semua", send: "Checkout semua" },
        { label: "Batal", send: "Batal" }
      ])
    }
  );
}

async function handleAwaitShipMode(supabase, threadId, threadRow, flow, text) {
  const mode = detectShipMode(text);

  if (!mode) {
    return replyResult(
      buildAskShipModeReply(),
      "gold999_ask_ship_mode_again",
      {
        gold999: { step: "await_ship_mode" },
        quick_replies: makeQuickReplies([
          { label: "Ambil di Kedai", send: "Ambil di kedai" },
          { label: "Pos", send: "Pos" }
        ])
      }
    );
  }

  if (mode === "PICKUP") {
    const nextFlow = {
      ...flow,
      ship_mode: "PICKUP",
      ship_code: SHIPPING_OPTIONS.PU.code,
      ship_label: SHIPPING_OPTIONS.PU.label,
      ship_fee_rm: SHIPPING_OPTIONS.PU.rm,
      step: "await_pickup_when"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      buildAskPickupWhenReply(),
      "gold999_pickup_ask_when",
      {
        gold999: { step: "await_pickup_when", ship_mode: "PICKUP" },
        quick_replies: makeQuickReplies([
          { label: "Secapat  Mungkin", send: "Secapat Mungkin" },
          { label: "Bila dah siap", send: "Bila dah siap" },
          { label: "2 hari lagi", send: "2 hari lagi" }
        ])
      }
    );
  }

  const customer = flow.customer_profile || await findCustomerByThreadPhone(supabase, threadRow);
  const addr = formatAddress(customer);
const country = flow.customer_country || detectCountryFromPhone(threadRow?.customer_phone || "");

  if (!addr) {
    const nextFlow = {
      ...flow,
      customer_profile: customer || null,
      ship_mode: "POST",
      ship_code: country === "SG" ? "SG" : "MY",
      ship_label: "",
      ship_fee_rm: 0,
      addr_text: "",
      addr_need_new: true,
      step: "await_new_address"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      `Baik cik 😊✅ Pilihan: *Pos*\n\n` +
      `Saya belum jumpa alamat dalam sistem.\n\n` +
      buildNeedNewAddressReply(),
      "gold999_need_new_address",
      {
        gold999: { step: "await_new_address", ship_mode: "POST", need_address: true }
      }
    );
  }

  const zone = detectMYZoneFromStateOrAddress(customer?.state, customer?.alamat);
  const fee = calcShipFee(country, zone);
  const label = shipLabel(country, zone);

  const nextFlow = {
    ...flow,
    customer_profile: customer || null,
    ship_mode: "POST",
    ship_code: country === "SG" ? "SG" : (zone === "EAST_MY" ? "MYE" : "MY"),
    ship_label: label,
    ship_fee_rm: fee,
    addr_text: addr,
    addr_need_new: false,
    step: "await_addr_confirm"
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    buildConfirmAddressReply(addr, fee, label),
    "gold999_confirm_address",
    {
      gold999: {
        step: "await_addr_confirm",
        ship_mode: "POST",
        ship_fee_rm: fee,
        ship_label: label,
        addr_text: addr
      },
      quick_replies: makeQuickReplies([
        { label: "Alamat Betul", send: "ALAMAT BETUL" },
        { label: "Alamat Salah", send: "ALAMAT SALAH" }
      ])
    }
  );
}

async function handleAwaitPickupWhen(supabase, threadId, threadRow, flow, text) {
  const whenText = norm(text);
  if (!whenText) {
    return replyResult(
      buildAskPickupWhenReply(),
      "gold999_pickup_when_again",
      {
        gold999: { step: "await_pickup_when", ship_mode: "PICKUP" },
        quick_replies: makeQuickReplies([
          { label: "Secapat  Mungkin", send: "Secapat Mungkin" },
          { label: "Bila dah siap", send: "Bila dah siap" },
          { label: "2 hari lagi", send: "2 hari lagi" }
        ])
      }
    );
  }

  const items = Array.isArray(flow.prepared_items) ? flow.prepared_items.slice() : [];
 const totals = await computeTotals(items, {
    supabase,
    shipping: SHIPPING_OPTIONS.PU,
    payMethod: "CARD_EWALLET",
    discountSource: flow.discount_source || null,
    isRealApp: flow.is_real_app === true,
    appPlatform: flow.app_platform || ""
  });

  const nextFlow = {
    ...flow,
    pickup_when_text: whenText,
    ship_mode: "PICKUP",
    ship_code: SHIPPING_OPTIONS.PU.code,
    ship_label: SHIPPING_OPTIONS.PU.label,
    ship_fee_rm: SHIPPING_OPTIONS.PU.rm,
    prepared_totals: totals,
    prepared_discount_rule: totals.promoRule || null,
    step: "await_payment_method"
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    `Baik cik 😊✅ Cik akan ambil di kedai: *${whenText}*\n\n` +
    buildAskPaymentMethodReply(items, totals, [], nextFlow),
    "gold999_pickup_to_payment",
    {
      gold999: {
        step: "await_payment_method",
        ship_mode: "PICKUP",
        pickup_when_text: whenText,
        refs: [],
        totals
      },
      quick_replies: makeQuickReplies([
  { label: "QR", send: "QR" },
  { label: "TRANSFER", send: "TRANSFER" },
  { label: "Batal", send: "Batal" },
  { label: "Mula semula", send: "Mula semula" }
])
    }
  );
}

async function handleAwaitAddrConfirm(supabase, threadId, threadRow, flow, text) {
  if (isAddressSalah(text)) {
    const nextFlow = {
      ...flow,
      addr_need_new: true,
      step: "await_new_address"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      buildNeedNewAddressReply(),
      "gold999_ask_new_address",
      {
        gold999: { step: "await_new_address", ship_mode: "POST", need_address: true }
      }
    );
  }

  if (!isAddressBetul(text)) {
    return replyResult(
      `Maaf cik 😊\n` +
      `Sila balas salah satu:\n` +
      `• *ALAMAT BETUL*\n` +
      `• *ALAMAT SALAH*`,
      "gold999_addr_confirm_again",
      {
        gold999: { step: "await_addr_confirm", ship_mode: "POST" },
        quick_replies: makeQuickReplies([
          { label: "Alamat Betul", send: "ALAMAT BETUL" },
          { label: "Alamat Salah", send: "ALAMAT SALAH" }
        ])
      }
    );
  }

  const shipCode = flow.ship_code || "MY";
  const shipping =
    shipCode === "SG" ? SHIPPING_OPTIONS.SG :
    shipCode === "MYE" ? SHIPPING_OPTIONS.MYE :
    SHIPPING_OPTIONS.MY;

  const items = Array.isArray(flow.prepared_items) ? flow.prepared_items.slice() : [];
const totals = await computeTotals(items, {
    supabase,
    shipping,
    payMethod: "CARD_EWALLET",
    discountSource: flow.discount_source || null,
    isRealApp: flow.is_real_app === true,
    appPlatform: flow.app_platform || ""
  });
  const nextFlow = {
    ...flow,
    prepared_totals: totals,
    prepared_discount_rule: totals.promoRule || null,
    addr_need_new: false,
    step: "await_payment_method"
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    `Baik cik 😊✅ Alamat disahkan.\n\n` +
    buildAskPaymentMethodReply(items, totals, [], nextFlow),
    "gold999_addr_ok_to_payment",
    {
      gold999: {
        step: "await_payment_method",
        ship_mode: "POST",
        addr_text: flow.addr_text || "",
        ship_fee_rm: flow.ship_fee_rm || 0,
        ship_label: flow.ship_label || "",
        refs: [],
        totals
      },
      quick_replies: makeQuickReplies([
  { label: "QR", send: "QR" },
  { label: "TRANSFER", send: "TRANSFER" },
  { label: "Batal", send: "Batal" },
  { label: "Mula semula", send: "Mula semula" }
])
    }
  );
}

async function handleAwaitNewAddress(supabase, threadId, threadRow, flow, text) {
  if (isAddressBetul(text) || isAddressSalah(text)) {
    return replyResult(
      `Cik belum bagi alamat baru lagi 😊\n\n` + buildNeedNewAddressReply(),
      "gold999_need_address_text",
      {
        gold999: { step: "await_new_address", ship_mode: "POST", need_address: true }
      }
    );
  }

const newAddr = norm(text);
  if (newAddr.length < 12) {
    return replyResult(
      `Alamat nampak terlalu pendek 😅\n` +
      `Sila taip alamat penuh ya.\n\n` +
      `Format: Alamat + Poskod + Bandar + Negeri`,
      "gold999_addr_too_short",
      {
        gold999: { step: "await_new_address", ship_mode: "POST", invalid_addr: true }
      }
    );
  }

  const country = flow.customer_country || detectCountryFromPhone(threadRow?.customer_phone || "");
  const zone = detectMYZoneFromStateOrAddress("", newAddr);
  const fee = calcShipFee(country, zone);
  const label = shipLabel(country, zone);

  const savedCustomer = await saveCustomerAddressByThreadPhone(
    supabase,
    threadRow,
    flow.customer_profile || null,
    newAddr
  );

  const nextFlow = {
    ...flow,
    customer_profile: savedCustomer || flow.customer_profile || null,
    ship_mode: "POST",
    ship_code: country === "SG" ? "SG" : (zone === "EAST_MY" ? "MYE" : "MY"),
    ship_label: label,
    ship_fee_rm: fee,
    addr_text: newAddr,
    addr_need_new: false,
    step: "await_addr_confirm"
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    `Baik cik 😊 Saya rekod alamat baru:\n` +
    `${newAddr}\n\n` +
    `📦 Caj pos: *${money(fee)}* (${label})\n\n` +
    `Alamat ni betul?\n` +
    `✅ Balas *ALAMAT BETUL*\n` +
    `✍️ Balas *ALAMAT SALAH*`,
    "gold999_new_addr_confirm",
    {
      gold999: {
        step: "await_addr_confirm",
        ship_mode: "POST",
        addr_text: newAddr,
        ship_fee_rm: fee,
        ship_label: label
      },
      quick_replies: makeQuickReplies([
        { label: "Alamat Betul", send: "ALAMAT BETUL" },
        { label: "Alamat Salah", send: "ALAMAT SALAH" }
      ])
    }
  );
}

async function handleAwaitPaymentMethod(supabase, threadId, threadRow, flow, text) {
  const payMethod = detectPaymentChoice(text);

  if (!payMethod) {
    return replyResult(
      `Baik cik 😊 Sila pilih salah satu ya:\n\n` +
      `1. *QR*\n` +
      `2. *TRANSFER*`,
      "gold999_ask_payment_method_again",
      {
        gold999: {
          step: "await_payment_method",
          refs: flow.prepared_refs || [],
          checkout_mode: flow.prepared_checkout_mode || null
        },
        quick_replies: makeQuickReplies([
          { label: "QR", send: "QR" },
          { label: "TRANSFER", send: "TRANSFER" },
          { label: "Batal", send: "Batal" },
          { label: "Mula semula", send: "Mula semula" }
        ])
      }
    );
  }

  const items = Array.isArray(flow.prepared_items) ? flow.prepared_items.slice() : [];

 const totals = await computeTotals(items, {
    supabase,
    shipping: {
      code: flow.ship_code || DEFAULT_SHIPPING.code,
      label: flow.ship_label || DEFAULT_SHIPPING.label,
      rm: Number(flow.ship_fee_rm || 0)
    },
    payMethod,
    discountSource: flow.discount_source || null,
    isRealApp: flow.is_real_app === true,
    appPlatform: flow.app_platform || ""
  });

  let refs = Array.isArray(flow.prepared_refs) ? flow.prepared_refs.slice() : [];
  if (!refs.length) {
    refs = await createRefsForItems(supabase, items);
  }

 await finalizePreparedOrders(
    supabase,
    refs,
    items,
    flow,
    threadId,
    threadRow,
    totals,
    payMethod
  );

  try {
    const customerPhone =
      norm(threadRow?.customer_phone) ||
      norm(flow?.customer_profile?.phone) ||
      "";

    if (customerPhone) {
      const waText = buildOnsendCustomerText(
        items,
        totals,
        refs,
        flow,
        payMethod,
        threadRow
      );

      const waOk = await sendOnsendText(customerPhone, waText);
      console.log("[chat-gold999] OnSend ke customer:", {
        phone: customerPhone,
        ok: waOk,
        refs
      });
    } else {
      console.warn("[chat-gold999] Tiada nombor customer untuk OnSend.", {
        thread_customer_phone: threadRow?.customer_phone,
        profile_phone: flow?.customer_profile?.phone || null
      });
    }
  } catch (waErr) {
    console.warn("[chat-gold999] OnSend customer gagal, tapi order sudah finalize:", waErr);
  }

  const replyText = buildPaymentDetailsReply(items, totals, refs, flow, payMethod);

  const nextFlow = {
    ...flow,
    active: false,
    step: "done",
    prepared_refs: refs,
    pay_method: payMethod,
    checkout_group_code: null,
    prepared_checkout_mode: null,
    prepared_totals: null,
    prepared_discount_rule: null,
    prepared_items: [],
    cart: [],
    ship_mode: null,
    ship_code: null,
    ship_label: null,
    ship_fee_rm: 0,
    pickup_when_text: "",
    addr_text: "",
    addr_need_new: false
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    replyText,
    "gold999_payment_method_chosen",
    {
      gold999: {
        done: true,
        pay_method: payMethod,
        refs,
        checkout_mode: flow.prepared_checkout_mode || null,
        items,
        totals,
        discount_source: flow.discount_source || null,
        discount_rule: flow.prepared_discount_rule || null,
        ship_mode: flow.ship_mode || null,
        ship_fee_rm: flow.ship_fee_rm || 0,
        ship_label: flow.ship_label || null,
        pickup_when_text: flow.pickup_when_text || null,
        addr_text: flow.addr_text || null
      }
    }
  );
}

async function handleBuilderAction(supabase, threadId, threadRow, flow, rawText) {
  const picked = parseBuilderChoice(rawText);

  if (!picked) return null;

  const discountSource = getDiscountSourceFromThread(threadRow) || flow.discount_source || null;

if (picked.action === "remove_item") {
    const cart = Array.isArray(flow.cart) ? flow.cart.slice() : [];
    const idx = Number(picked.remove_index || 0) - 1;

    if (idx >= 0 && idx < cart.length) {
      cart.splice(idx, 1);
    }

    const nextFlow = {
      ...flow,
      active: true,
      builder_mode: true,
      cart
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      `Baik cik 😊 Item telah dibuang.`,
      "gold999_builder_removed_item",
      {
        gold999: {
          step: nextFlow.step || "choose_config",
          builder_mode: true,
          cart_count: cart.length
        },
        builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
      }
    );
  }

  // ===== choose kind =====
  if (picked.action === "choose_kind") {
    const kind = normalizeKindForDb(picked.kind || "");

    if (!kind) {
      return replyResult(
        `Baik cik 😊 Sila pilih jenis dahulu dalam kad di bawah ya.`,
        "gold999_builder_need_kind",
        {
          gold999: { step: "choose_kind", builder_mode: true },
          builder_card: await buildBuilderCardMeta(supabase, flow, threadRow)
        }
      );
    }

    const rows = await getKindPriceRows(supabase, kind);
    const firstWeight = rows[0] || null;
    const designs = firstWeight ? await listDesigns(supabase, kind, firstWeight.weight_g) : [];
    const firstDesign = designs[0] || null;

    const nextFlow = {
      ...flow,
      active: true,
      builder_mode: true,
      discount_source: discountSource,
      discount_enabled: !!discountSource,

      kind,
      weight_g: firstWeight ? Number(firstWeight.weight_g) : null,
      weight_label: firstWeight ? firstWeight.weight_label : null,
      upah_rm: firstWeight ? Number(firstWeight.upah_rm || 0) : 0,
      price_per_g: firstWeight ? Number(firstWeight.price_per_g || 0) : 0,

      selected_design_id: firstDesign ? firstDesign.id : null,
      selected_design_name: firstDesign ? firstDesign.name : "",
      selected_design_custom_fee_rm: firstDesign ? Number(firstDesign.extra_custom_fee_rm || 0) : 0,

      card_type: "READY",
      qty: 1,

      last_shown_weights: rows.map(r => ({
        kind: r.kind,
        weight_g: r.weight_g,
        weight_label: r.weight_label,
        upah_rm: r.upah_rm,
        price_per_g: r.price_per_g,
        harga_jual: r.harga_jual
      })),

      last_shown_designs: designs.map(d => ({
        id: d.id,
        name: d.name,
        image_url: d.image_url,
        extra_custom_fee_rm: d.extra_custom_fee_rm
      })),

      step: "choose_config"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      `Baik cik 😊 Sila lengkapkan pilihan dalam kad di bawah ya.`,
      "gold999_builder_kind_selected",
      {
        gold999: { step: "choose_config", builder_mode: true, kind },
        builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
      }
    );
  }

  // ===== choose weight =====
  if (picked.action === "choose_weight") {
    const kind = normalizeKindForDb(flow.kind || picked.kind || "");
    if (!kind) {
      return replyResult(
        `Baik cik 😊 Sila pilih jenis dahulu ya.`,
        "gold999_builder_need_kind_before_weight",
        {
          gold999: { step: "choose_kind", builder_mode: true },
          builder_card: await buildBuilderCardMeta(supabase, flow, threadRow)
        }
      );
    }

    const rows = await getKindPriceRows(supabase, kind);
    const selectedRow =
      rows.find(r => Number(r.weight_g) === Number(picked.weight_g)) ||
      rows[0] ||
      null;

    if (!selectedRow) {
      return replyResult(
        `Maaf cik, berat untuk pilihan ini belum tersedia.`,
        "gold999_builder_no_weight",
        {
          gold999: { step: "choose_kind", builder_mode: true },
          builder_card: await buildBuilderCardMeta(supabase, flow, threadRow)
        }
      );
    }

    const designs = await listDesigns(supabase, kind, selectedRow.weight_g);
    const firstDesign = designs[0] || null;

    const nextFlow = {
      ...flow,
      active: true,
      builder_mode: true,
      kind,
      weight_g: Number(selectedRow.weight_g),
      weight_label: selectedRow.weight_label,
      upah_rm: Number(selectedRow.upah_rm || 0),
      price_per_g: Number(selectedRow.price_per_g || 0),

      selected_design_id: firstDesign ? firstDesign.id : null,
      selected_design_name: firstDesign ? firstDesign.name : "",
      selected_design_custom_fee_rm: firstDesign ? Number(firstDesign.extra_custom_fee_rm || 0) : 0,

      card_type: "READY",
      qty: 1,

     last_shown_weights: rows.map(r => ({
        kind: r.kind,
        weight_g: r.weight_g,
        weight_label: r.weight_label,
        upah_rm: r.upah_rm,
        price_per_g: r.price_per_g,
        harga_jual: r.harga_jual
      })),

      last_shown_designs: designs.map(d => ({
        id: d.id,
        name: d.name,
        image_url: d.image_url,
        extra_custom_fee_rm: d.extra_custom_fee_rm
      })),

      step: "choose_config"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      `Baik cik 😊 Sila lengkapkan pilihan dalam kad di bawah ya.`,
      "gold999_builder_weight_selected",
      {
        gold999: { step: "choose_config", builder_mode: true, kind },
        builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
      }
    );
  }

  // dari sini, builder perlukan kind + weight + design
  const kind = normalizeKindForDb(flow.kind || picked.kind || "");
  if (!kind || !Number(flow.weight_g || picked.weight_g || 0)) {
    return replyResult(
      `Baik cik 😊 Sila pilih jenis dan berat dahulu ya.`,
      "gold999_builder_incomplete",
      {
        gold999: { step: "choose_kind", builder_mode: true },
        builder_card: await buildBuilderCardMeta(supabase, flow, threadRow)
      }
    );
  }

  const rows = await getKindPriceRows(supabase, kind);
  const row =
    rows.find(r => Number(r.weight_g) === Number(flow.weight_g || picked.weight_g)) ||
    null;

  if (!row) {
    return replyResult(
      `Maaf cik, berat itu tidak dijumpai.`,
      "gold999_builder_weight_not_found",
      {
        gold999: { step: "choose_kind", builder_mode: true },
        builder_card: await buildBuilderCardMeta(supabase, flow, threadRow)
      }
    );
  }

  const designs = await listDesigns(supabase, kind, row.weight_g);

  const design =
    designs.find(d => String(d.id) === String(picked.design_id || flow.selected_design_id || "")) ||
    designs.find(d => lower(d.name) === lower(flow.selected_design_name || "")) ||
    designs[0] ||
    null;

  if (!design) {
    return replyResult(
      `Baik cik 😊 Sila pilih design dahulu ya.`,
      "gold999_builder_need_design",
      {
        gold999: { step: "choose_config", builder_mode: true },
        builder_card: await buildBuilderCardMeta(supabase, flow, threadRow)
      }
    );
  }

  const workingFlow = {
    ...flow,
    active: true,
    builder_mode: true,
    discount_source: discountSource,
    discount_enabled: !!discountSource,

    kind,
    weight_g: Number(row.weight_g),
    weight_label: row.weight_label,
    upah_rm: Number(row.upah_rm || 0),
    price_per_g: Number(row.price_per_g || 0),

    selected_design_id: design.id,
    selected_design_name: design.name,
    selected_design_custom_fee_rm: Number(design.extra_custom_fee_rm || 0),

    card_type: upper(picked.card || flow.card_type || "READY"),
    qty: Number(picked.qty || flow.qty || 1),

    last_shown_weights: rows.map(r => ({
      kind: r.kind,
      weight_g: r.weight_g,
      weight_label: r.weight_label,
      upah_rm: r.upah_rm,
      price_per_g: r.price_per_g,
      harga_jual: r.harga_jual
    })),

    last_shown_designs: designs.map(d => ({
      id: d.id,
      name: d.name,
      image_url: d.image_url,
      extra_custom_fee_rm: d.extra_custom_fee_rm
    })),

    step: "choose_config"
  };

  const currentItem = buildCurrentItem(workingFlow);

  // ===== add item =====
  if (picked.action === "add_item") {
    const nextCart = Array.isArray(flow.cart) ? flow.cart.slice() : [];
    nextCart.push(currentItem);

    const nextFlow = resetCurrentBuilderSelection({
      ...workingFlow,
      cart: nextCart,
      step: "choose_kind",
      prepared_refs: [],
      prepared_checkout_mode: null,
      prepared_totals: null,
      prepared_discount_rule: null,
      prepared_items: [],
      checkout_group_code: null
    });

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      `Baik cik 😊 Item telah ditambah. Cik boleh pilih item seterusnya dalam kad di bawah.`,
      "gold999_builder_added_item",
      {
        gold999: {
          step: "choose_kind",
          builder_mode: true,
          cart_count: nextCart.length
        },
        builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
      }
    );
  }

  // ===== checkout now =====
  if (picked.action === "checkout_now") {
   let items = Array.isArray(flow.cart) ? flow.cart.slice() : [];

if (!items.length) {
  if (currentItem && currentItem.kind && currentItem.weight_g) {
    items = [currentItem];
  }
}

if (!items.length) {
  return replyResult(
    `Baik cik 😊 Sila lengkapkan item dahulu ya.`,
    "gold999_builder_checkout_empty",
    {
      gold999: { step: "choose_config", builder_mode: true },
      builder_card: await buildBuilderCardMeta(supabase, workingFlow, threadRow)
    }
  );
}

    const totals = await computeTotals(items, {
      supabase,
      shipping: DEFAULT_SHIPPING,
      payMethod: "CARD_EWALLET",
      discountSource,
      isRealApp: flow.is_real_app === true,
      appPlatform: flow.app_platform || ""
    });

    const customer = await findCustomerByThreadPhone(supabase, threadRow);

    const nextFlow = {
      ...workingFlow,
      cart: [],
      prepared_refs: [],
      prepared_checkout_mode: "builder",
      prepared_totals: totals,
      prepared_discount_rule: totals.promoRule || null,
      prepared_items: items,
      checkout_group_code: null,
      customer_country: detectCountryFromPhone(threadRow?.customer_phone || ""),
      customer_profile: customer || null,
      ship_mode: null,
      ship_code: null,
      ship_label: null,
      ship_fee_rm: 0,
      pickup_when_text: "",
      addr_text: "",
      addr_need_new: false,
      pay_method: null,
      step: "await_ship_mode"
    };

    await setGold999Flow(supabase, threadId, threadRow, nextFlow);

    return replyResult(
      buildCheckoutReply(items, totals, []) + `\n\n` + buildAskShipModeReply(),
      "gold999_builder_checkout_ready",
      {
        gold999: {
          step: "await_ship_mode",
          builder_mode: true,
          items,
          totals,
          checkout_mode: "builder"
        },
        quick_replies: makeQuickReplies([
          { label: "Ambil di Kedai", send: "Ambil di kedai" },
          { label: "Pos", send: "Pos" }
        ])
      }
    );
  }

  return replyResult(
    `Baik cik 😊 Sila lengkapkan pilihan dalam kad di bawah ya.`,
    "gold999_builder_refresh",
    {
      gold999: { step: "choose_config", builder_mode: true },
      builder_card: await buildBuilderCardMeta(supabase, workingFlow, threadRow)
    }
  );
}

async function handleLive999Lock(supabase, threadId, threadRow, rawText, isRealApp, appPlatform) {
  const picked = parseLive999Lock(rawText);
  if (!picked) return null;

  const discountSource = getDiscountSourceFromThread(threadRow) || "AI_DAN";

  const rows = await getKindPriceRows(supabase, picked.kind);
  const row = rows.find(r => Number(r.weight_g) === Number(picked.weight_g)) || rows[0];

  if (!row) {
    return replyResult(
      `Maaf cik, item LIVE 999.9 ini belum jumpa dalam senarai harga.`,
      "gold999_live_lock_not_found",
      { gold999: { error: true, source: "live999_lock" } }
    );
  }

  const designs = await listDesigns(supabase, picked.kind, row.weight_g);
  const design =
    designs.find(d => String(d.id) === String(picked.design_id || "")) ||
    designs.find(d => lower(d.name) === lower(picked.design_name || "")) ||
    designs[0] ||
    null;

  const item = simplifyCartItem({
    kind: picked.kind,
    weight_g: row.weight_g,
    weight_label: row.weight_label,
    cardType: picked.card,
    qty: picked.qty,
    unit: calcUnitPrice(
      row.price_per_g,
      row.weight_g,
      row.upah_rm,
      picked.card,
      picked.card === "CUSTOM" ? Number(design?.extra_custom_fee_rm || 0) : 0
    ),
    design_id: design?.id || picked.design_id || null,
    design_name: design?.name || picked.design_name || "",
    custom_fee: picked.card === "CUSTOM" ? Number(design?.extra_custom_fee_rm || 0) : 0,
    price_per_g: row.price_per_g,
    upah_rm: row.upah_rm
  });

  const totals = await computeTotals([item], {
    supabase,
    shipping: DEFAULT_SHIPPING,
    payMethod: "CARD_EWALLET",
    discountSource,
    isRealApp: isRealApp === true,
    appPlatform: appPlatform || ""
  });

  const customer = await findCustomerByThreadPhone(supabase, threadRow);

  const nextFlow = {
    ...makeEmptyFlow(),
    active: true,
    step: "await_ship_mode",
    builder_mode: false,

    prepared_refs: [],
    prepared_checkout_mode: "live999",
    prepared_totals: totals,
    prepared_discount_rule: totals.promoRule || null,
    prepared_items: [item],
    checkout_group_code: null,

    discount_source: discountSource,
    discount_enabled: !!discountSource,

    customer_country: detectCountryFromPhone(threadRow?.customer_phone || ""),
    customer_profile: customer || null,

    is_real_app: !!isRealApp,
    app_platform: upper(appPlatform || "")
  };

  await setGold999Flow(supabase, threadId, threadRow, nextFlow);

  return replyResult(
    buildCheckoutReply([item], totals, []) + `\n\n` + buildAskShipModeReply(),
    "gold999_live_lock_ready",
    {
      gold999: {
        step: "await_ship_mode",
        source: "live999_lock",
        checkout_mode: "live999",
        items: [item],
        totals,
        discount_source: discountSource,
        discount_rule: totals.promoRule || null
      },
      quick_replies: makeQuickReplies([
        { label: "Ambil di Kedai", send: "Ambil di kedai" },
        { label: "Pos", send: "Pos" }
      ])
    }
  );
}
async function tryHandleGold999({ supabase, threadId, text, threadRow, isRealApp = false, appPlatform = "" }) {
  try {
    const rawText = norm(text);
    if (!rawText) return null;

    console.log("[G999 DEBUG] rawText:", rawText);

    const flow = getGold999Flow(threadRow);

    // =========================
    // 1️⃣ LIVE CHECKOUT SUBMIT
    // =========================
    const live999CheckoutSubmit = await handleLive999CheckoutSubmit(
      supabase,
      threadId,
      threadRow,
      rawText,
      isRealApp,
      appPlatform
    );
console.log("[G999 DEBUG] live999CheckoutSubmit:", live999CheckoutSubmit);
    if (live999CheckoutSubmit) return live999CheckoutSubmit;

    // =========================
    // 2️⃣ LIVE LOCK (PENTING)
    // =========================
    const live999Lock = await handleLive999Lock(
      supabase,
      threadId,
      threadRow,
      rawText,
      isRealApp,
      appPlatform
    );

    if (live999Lock) return live999Lock;

    // =========================
    // 3️⃣ BUILDER ACTION
    // =========================
    if (String(rawText).startsWith("BUILDER|") && flow.active) {
      return await handleBuilderAction(supabase, threadId, threadRow, flow, rawText);
    }

    // =========================
    // EXIT / RESET
    // =========================
    if (isExitCommand(rawText) && flow.active) {
      return await resetFlow(supabase, threadId, threadRow);
    }

    if (isRestartCommand(rawText) && flow.active) {
      const nextFlow = buildStartFlow();
      nextFlow.discount_source = getDiscountSourceFromThread(threadRow) || "AI_DAN";
      nextFlow.discount_enabled = !!nextFlow.discount_source;
      nextFlow.customer_country = detectCountryFromPhone(threadRow?.customer_phone || "");
      nextFlow.customer_profile = await findCustomerByThreadPhone(supabase, threadRow);
      nextFlow.is_real_app = !!isRealApp;
      nextFlow.app_platform = upper(appPlatform || "");
      nextFlow.builder_mode = true;
      nextFlow.builder_started_from_custom_intent = false;

      await setGold999Flow(supabase, threadId, threadRow, nextFlow);

      return replyResult(
        `Baik cik 😊 Kita mulakan semula flow 999.9 ya.`,
        "gold999_fallback_restart",
        {
          gold999: { step: "choose_kind", builder_mode: true },
          builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow),
          quick_replies: makeQuickReplies([
            { label: "Gold Coin", send: "Gold Coin" },
            { label: "Koleksi Dinar", send: "Dinar" },
            { label: "Gold Bar", send: "Gold Bar" }
          ])
        }
      );
    }

    // =========================
    // START FLOW
    // =========================
    if (!flow.active) {
      if (!detect999Intent(rawText) && !detectBuilderStartIntent(rawText)) return null;

      const nextFlow = buildStartFlow();
      nextFlow.discount_source = getDiscountSourceFromThread(threadRow) || "AI_DAN";
      nextFlow.discount_enabled = !!nextFlow.discount_source;
      nextFlow.customer_country = detectCountryFromPhone(threadRow?.customer_phone || "");
      nextFlow.customer_profile = await findCustomerByThreadPhone(supabase, threadRow);
      nextFlow.is_real_app = !!isRealApp;
      nextFlow.app_platform = upper(appPlatform || "");
      nextFlow.builder_mode = true;
      nextFlow.builder_started_from_custom_intent = lower(rawText).includes("gold coin custom");

      await setGold999Flow(supabase, threadId, threadRow, nextFlow);

      return replyResult(
        `Baik cik 😊 Sila pilih jenis dahulu dalam kad di bawah ya.`,
        "gold999_start_builder",
        {
          gold999: {
            step: "choose_kind",
            started: true,
            discount_source: nextFlow.discount_source || null,
            builder_mode: true
          },
          builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow),
          quick_replies: makeQuickReplies([
            { label: "Gold Coin", send: "Gold Coin" },
            { label: "Koleksi Dinar", send: "Dinar" },
            { label: "Gold Bar", send: "Gold Bar" }
          ])
        }
      );
    }

    // =========================
    // BUILDER FALLBACK
    // =========================
    if (rawText.startsWith("BUILDER|")) {
      const builderHandled = await handleBuilderAction(
        supabase,
        threadId,
        threadRow,
        flow,
        rawText
      );
      if (builderHandled) return builderHandled;
    }

    // =========================
    // STEP FLOW
    // =========================
    if (flow.step === "choose_kind") {
      return await handleChooseKind(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "choose_weight") {
      return await handleChooseWeight(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "choose_design") {
      return await handleChooseDesign(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "choose_config") {
      return await handleChooseConfig(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "post_item_choice") {
      return await handlePostItemChoice(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "after_cart") {
      return await handleAfterCart(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "await_ship_mode") {
      return await handleAwaitShipMode(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "await_pickup_when") {
      return await handleAwaitPickupWhen(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "await_addr_confirm") {
      return await handleAwaitAddrConfirm(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "await_new_address") {
      return await handleAwaitNewAddress(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "await_payment_method") {
      return await handleAwaitPaymentMethod(supabase, threadId, threadRow, flow, rawText);
    }

    if (flow.step === "done") {
      if (isAddMoreCommand(rawText) || detect999Intent(rawText)) {
        const nextFlow = buildStartFlow();
        nextFlow.discount_source = flow.discount_source || getDiscountSourceFromThread(threadRow);
        nextFlow.discount_enabled = !!nextFlow.discount_source;
        nextFlow.customer_country = detectCountryFromPhone(threadRow?.customer_phone || "");
        nextFlow.customer_profile = flow.customer_profile || await findCustomerByThreadPhone(supabase, threadRow);
        nextFlow.is_real_app = !!isRealApp;
        nextFlow.app_platform = upper(appPlatform || "");
        nextFlow.builder_mode = true;

        await setGold999Flow(supabase, threadId, threadRow, nextFlow);

        return replyResult(
          `Baik cik 😊 Kita mulakan item 999.9 yang baru ya.`,
          "gold999_restart_after_done",
          {
            gold999: { step: "choose_kind", builder_mode: true },
            builder_card: await buildBuilderCardMeta(supabase, nextFlow, threadRow)
          }
        );
      }

      return null;
    }

    return null;

  } catch (err) {
    console.error("[chat-gold999] fatal error:", err);

    return replyResult(
      `Maaf cik, ada sedikit masalah semasa proses order 999.9.`,
      "gold999_error",
      {
        gold999: {
          error: true,
          message: String(err?.message || err || "Unknown error")
        }
      }
    );
  }
}

module.exports = {
  tryHandleGold999
};
