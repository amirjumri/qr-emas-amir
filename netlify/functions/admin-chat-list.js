const { createClient } = require("@supabase/supabase-js");

const THREAD_LIMIT = 300;
const LATEST_MSG_LIMIT = 1500;
const ORDER_LIMIT_PER_PHONE = 12;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}

function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D+/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = "60" + d.slice(1);
  if (d.length === 8 && (d.startsWith("8") || d.startsWith("9"))) d = "65" + d;
  return d;
}

function phoneVariants(e164) {
  const d = normalizePhone(e164);
  if (!d) return [];
  const out = new Set([d, "+" + d]);
  if (d.startsWith("60")) out.add("0" + d.slice(2));
  return Array.from(out);
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function short999(ref) {
  return String(ref || "").trim().slice(0, 8);
}

function toTs(v) {
  const t = new Date(v || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function emptyCounts() {
  return {
    total: 0,
    unread: 0,
    read: 0,
    waiting_customer: 0,
    no_admin_reply: 0,
    needs_followup: 0,
    manual_mode: 0,
    ai_mode: 0
  };
}

async function verifyAdmin(supabase, adminPhone) {
  const p = normalizePhone(adminPhone);
  if (!p) return false;

  const variants = phoneVariants(p);

  const q = await supabase
    .from("admin_users")
    .select("phone,is_active")
    .in("phone", variants)
    .eq("is_active", true)
    .limit(1);

  return !q.error && Array.isArray(q.data) && q.data.length > 0;
}

function orderStatusRank(status) {
  const s = String(status || "").trim().toUpperCase();
  if (s === "PENDING") return 4;
  if (s === "PAID") return 3;
  if (s === "COMPLETED") return 2;
  if (s === "CANCELLED") return 1;
  if (s === "FAILED") return 0;
  return 0;
}

function sortOrders(a, b) {
  const ra = orderStatusRank(a?.status);
  const rb = orderStatusRank(b?.status);
  if (rb !== ra) return rb - ra;

  const ta = toTs(a?.created_at);
  const tb = toTs(b?.created_at);
  if (tb !== ta) return tb - ta;

  return 0;
}

function isPendingStatus(status) {
  return String(status || "").trim().toUpperCase() === "PENDING";
}

function buildOrderBundleForPhone(phoneKey, map916, map999) {
  const arr916Raw = Array.isArray(map916[phoneKey]) ? map916[phoneKey].slice() : [];
  const arr999Raw = Array.isArray(map999[phoneKey]) ? map999[phoneKey].slice() : [];

  const arr916 = arr916Raw.filter(x => isPendingStatus(x?.status));
  const arr999 = arr999Raw.filter(x => isPendingStatus(x?.status));

  arr916.sort(sortOrders);
  arr999.sort(sortOrders);

  const trimmed916 = arr916.slice(0, ORDER_LIMIT_PER_PHONE);
  const trimmed999 = arr999.slice(0, ORDER_LIMIT_PER_PHONE);

  const orderRefs = [];
  const orderRefsShort = [];
  const summaryParts = [];

  if (trimmed916.length) {
    const refs916 = trimmed916
      .map(x => String(x.order_code || "").trim())
      .filter(Boolean);

    orderRefs.push(...refs916);
    orderRefsShort.push(...refs916);

    summaryParts.push(`916: ${refs916.join(", ")}`);
  }

  if (trimmed999.length) {
    const refs999Full = trimmed999
      .map(x => String(x.reference_1 || "").trim())
      .filter(Boolean);

    const refs999Short = refs999Full.map(short999).filter(Boolean);

    orderRefs.push(...refs999Full);
    orderRefsShort.push(...refs999Short);

    summaryParts.push(`999: ${refs999Short.join(", ")}`);
  }

  return {
    order_refs: uniq(orderRefs),
    order_refs_short: uniq(orderRefsShort),
    order_summary: summaryParts.join(" • ")
  };
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }

    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Body JSON tak sah" });
    }

    const adminPhone = body.admin_phone || "";

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE ||
      "";

    if (!process.env.SUPABASE_URL || !serviceKey) {
      return json(500, { ok: false, error: "Supabase env belum lengkap." });
    }

    const supabase = createClient(process.env.SUPABASE_URL, serviceKey);

    const isAdmin = await verifyAdmin(supabase, adminPhone);
    if (!isAdmin) {
      return json(403, { ok: false, error: "Akses admin ditolak." });
    }

    const tQ = await supabase
      .from("chat_threads")
      .select(`
        id,
        status,
        customer_phone,
        last_message_at,
        created_at,
        meta,
        last_admin_message_at,
        last_customer_message_at,
        last_customer_seen_at
      `)
      .order("last_message_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(THREAD_LIMIT);

    if (tQ.error) throw tQ.error;

    const rawThreads = Array.isArray(tQ.data) ? tQ.data : [];
    if (!rawThreads.length) {
      return json(200, {
        ok: true,
        rows: [],
        counts: emptyCounts()
      });
    }

    const latestThreadByPhone = {};
    for (const th of rawThreads) {
      const key = normalizePhone(th.customer_phone);
      if (!key) continue;
      if (!latestThreadByPhone[key]) {
        latestThreadByPhone[key] = th;
      }
    }

    const threads = Object.values(latestThreadByPhone);
    if (!threads.length) {
      return json(200, {
        ok: true,
        rows: [],
        counts: emptyCounts()
      });
    }

    const threadIds = threads.map(x => x.id);

    const allCustomerVariants = new Set();
    const allPhonesForOrdersSet = new Set();

    for (const th of threads) {
      const vars = phoneVariants(th.customer_phone);
      for (const v of vars) {
        if (!v) continue;
        allCustomerVariants.add(v);
        allPhonesForOrdersSet.add(v);
      }
    }

    const allCustomerPhones = Array.from(allCustomerVariants);
    const allPhonesForOrders = Array.from(allPhonesForOrdersSet);

    const [
      latestMsgQ,
      cQ,
      q916,
      q999
    ] = await Promise.all([
      supabase
        .from("chat_messages")
        .select("id,thread_id,role,text,created_at,meta")
        .in("thread_id", threadIds)
        .order("created_at", { ascending: false })
        .limit(LATEST_MSG_LIMIT),

      allCustomerPhones.length
        ? supabase
            .from("customers")
            .select("phone,name,alamat,city,state")
            .in("phone", allCustomerPhones)
        : Promise.resolve({ data: [], error: null }),

      allPhonesForOrders.length
        ? supabase
            .from("j916_orders")
            .select("order_code,phone,status,created_at")
            .in("phone", allPhonesForOrders)
            .order("created_at", { ascending: false })
            .limit(3000)
        : Promise.resolve({ data: [], error: null }),

      allPhonesForOrders.length
        ? supabase
            .from("goldbar_order")
            .select("reference_1,customer_phone,status,created_at")
            .in("customer_phone", allPhonesForOrders)
            .order("created_at", { ascending: false })
            .limit(3000)
        : Promise.resolve({ data: [], error: null })
    ]);

    if (latestMsgQ.error) throw latestMsgQ.error;
    if (cQ.error) throw cQ.error;
    if (q916.error) throw q916.error;
    if (q999.error) throw q999.error;

    const latestByThread = {};
    for (const m of (latestMsgQ.data || [])) {
      if (!latestByThread[m.thread_id]) {
        latestByThread[m.thread_id] = m;
      }
    }

    const customers = Array.isArray(cQ.data) ? cQ.data : [];
    const customerMap = {};
    for (const c of customers) {
      const k = normalizePhone(c.phone);
      if (!k) continue;
      customerMap[k] = c;
    }

    const rows916 = Array.isArray(q916.data) ? q916.data : [];
    const order916Map = {};
    for (const row of rows916) {
      const p = normalizePhone(row.phone);
      if (!p) continue;
      if (!order916Map[p]) order916Map[p] = [];
      order916Map[p].push({
        order_code: String(row.order_code || "").trim(),
        status: String(row.status || "").trim().toUpperCase(),
        created_at: row.created_at || null
      });
    }

    const rows999 = Array.isArray(q999.data) ? q999.data : [];
    const order999Map = {};
    for (const row of rows999) {
      const p = normalizePhone(row.customer_phone);
      if (!p) continue;
      if (!order999Map[p]) order999Map[p] = [];
      order999Map[p].push({
        reference_1: String(row.reference_1 || "").trim(),
        status: String(row.status || "").trim().toUpperCase(),
        created_at: row.created_at || null
      });
    }

    const rows = threads.map(th => {
      const k = normalizePhone(th.customer_phone);
      const cust = customerMap[k] || null;
      const last = latestByThread[th.id] || null;

      const meta = (th.meta && typeof th.meta === "object") ? th.meta : {};
      const manualStatus = String(meta.admin_manual_status || "").toUpperCase();

      const adminMode = meta.admin_mode === true;
      const modeLabel = adminMode ? "MANUAL" : "AI";

      const orderBundle = buildOrderBundleForPhone(k, order916Map, order999Map);

      const lastAdminMessageAt = th.last_admin_message_at || null;
      const lastCustomerMessageAt = th.last_customer_message_at || null;
      const lastCustomerSeenAt = th.last_customer_seen_at || null;

      const adminTs = toTs(lastAdminMessageAt);
      const customerMsgTs = toTs(lastCustomerMessageAt);
      const seenTs = toTs(lastCustomerSeenAt);

      const hasAdminReply = adminTs > 0;
      const hasCustomerSeen = seenTs > 0;
      const hasCustomerMessage = customerMsgTs > 0;

      const autoNoAdminReply =
        hasCustomerMessage &&
        (
          !hasAdminReply ||
          customerMsgTs >= adminTs
        );

      const autoUnread =
        hasAdminReply &&
        adminTs > customerMsgTs &&
        (
          !hasCustomerSeen ||
          seenTs < adminTs
        );

      const autoRead =
        hasAdminReply &&
        adminTs > customerMsgTs &&
        hasCustomerSeen &&
        seenTs >= adminTs;

      let finalUnread = autoUnread;
      let finalRead = autoRead;
      let finalWaiting = false;
      let finalNoAdmin = autoNoAdminReply;

      if (manualStatus === "WAITING") {
        finalUnread = false;
        finalRead = false;
        finalWaiting = true;
        finalNoAdmin = false;
      }

      const needsFollowup = finalUnread || finalWaiting || finalNoAdmin;

      let unreadSortTs = 0;
      if (finalNoAdmin) {
        unreadSortTs = customerMsgTs;
      } else if (finalWaiting) {
        unreadSortTs = toTs(th.last_message_at || last?.created_at || th.created_at || 0);
      } else if (finalUnread) {
        unreadSortTs = adminTs;
      } else {
        unreadSortTs = toTs(th.last_message_at || last?.created_at || th.created_at || 0);
      }

      return {
        thread_id: th.id,
        status: th.status || "OPEN",
        created_at: th.created_at || null,
        last_message_at: th.last_message_at || last?.created_at || th.created_at || null,

        last_admin_message_at: lastAdminMessageAt,
        last_customer_message_at: lastCustomerMessageAt,
        last_customer_seen_at: lastCustomerSeenAt,

        customer_phone: th.customer_phone || "",
        customer_name: cust?.name || "",
        last_message_role: last?.role || "",
        last_message_text: String(last?.text || "").trim() || "(tiada mesej)",

        order_refs: orderBundle.order_refs,
        order_refs_short: orderBundle.order_refs_short,
        order_summary: orderBundle.order_summary,

        meta: meta,

        unread: finalUnread,
        read: finalRead,
        waiting_customer: finalWaiting,
        no_admin_reply: finalNoAdmin,
        needs_followup: needsFollowup,
        unread_sort_ts: unreadSortTs,
        manual_status: manualStatus || null,

        admin_mode: adminMode,
        mode: modeLabel
      };
    });

    rows.sort((a, b) => {
      const pa =
        a.no_admin_reply ? 5 :
        a.waiting_customer ? 4 :
        a.unread ? 3 :
        a.read ? 2 : 1;

      const pb =
        b.no_admin_reply ? 5 :
        b.waiting_customer ? 4 :
        b.unread ? 3 :
        b.read ? 2 : 1;

      if (pb !== pa) return pb - pa;

      const ta = Number(a.unread_sort_ts || 0);
      const tb = Number(b.unread_sort_ts || 0);
      if (tb !== ta) return tb - ta;

      const xa = toTs(a.last_message_at || a.created_at || 0);
      const xb = toTs(b.last_message_at || b.created_at || 0);
      return xb - xa;
    });

    const counts = {
      total: rows.length,
      unread: rows.filter(x => x.unread).length,
      read: rows.filter(x => x.read).length,
      waiting_customer: rows.filter(x => x.waiting_customer).length,
      no_admin_reply: rows.filter(x => x.no_admin_reply).length,
      needs_followup: rows.filter(x => x.needs_followup).length,
      manual_mode: rows.filter(x => x.admin_mode === true).length,
      ai_mode: rows.filter(x => x.admin_mode !== true).length
    };

    return json(200, { ok: true, rows, counts });

  } catch (e) {
    console.error("admin-chat-list error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};