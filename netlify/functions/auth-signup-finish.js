const {
  corsHeaders,
  json,
  getSupabaseAdmin,
  getOrCreateThread,
  insertAiMessage
} = require("./_auth-chat-helper");

const { verifyOtpInput, consumeOtp } = require("./_auth-otp-helper");

function buildPhoneCandidates(phone) {
  const d = String(phone || "").replace(/\D+/g, "").trim();
  if (!d) return [];

  const local = d.startsWith("60") ? ("0" + d.slice(2)) : d;
  return [local];
}

async function findCustomerByPhoneCandidates(supabase, phone) {
  const candidates = buildPhoneCandidates(phone);

  const q = await supabase
    .from("customers")
    .select("id,name,phone,ic,alamat")
    .in("phone", candidates)
    .limit(10);

  if (q.error) throw q.error;

  const rows = q.data || [];
  if (!rows.length) return null;

  const exact = rows.find(r => String(r.phone || "").replace(/\D+/g, "") === candidates[0]);
  if (exact) return exact;

  return rows[0];
}

async function findAgentBySlug(supabase, slug) {
  const s = String(slug || "").trim();
  if (!s) return null;

  const q = await supabase
    .from("agents")
    .select("id,slug,code,status")
    .eq("slug", s)
    .limit(1)
    .maybeSingle();

  if (q.error) throw q.error;
  return q.data || null;
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

   const rawPhone = body.phone || body.customer_phone || "";
    let phone = String(rawPhone || "").replace(/\D+/g, "").trim();
    const last4 = String(body.last4 || "").replace(/\D+/g, "");
    const name = String(body.name || "").trim();
    const ic = String(body.ic || "").replace(/\D+/g, "");
    const alamat = String(body.alamat || "").trim();
    const otp = String(body.otp || "").replace(/\D+/g, "");
    const password = String(body.password || "");
    const threadIdIn = String(body.thread_id || "").trim();
    const agentSlugIn = String(body.agent_slug || "").trim();

    if (phone.startsWith("60")) {
      phone = "0" + phone.slice(2);
    }

    if (!phone) return json(400, { ok: false, error: "Nombor telefon tak sah." });
    if (!/^\d{4}$/.test(last4)) return json(400, { ok: false, error: "4 digit terakhir tak sah." });
    if (!phone.endsWith(last4)) return json(400, { ok: false, error: "4 digit terakhir tak padan." });
    if (!/^\d{6}$/.test(otp)) return json(400, { ok: false, error: "OTP mesti 6 digit." });
    if (password.length < 6) return json(400, { ok: false, error: "Password minima 6 aksara." });
    if (ic && ic.length !== 12) return json(400, { ok: false, error: "IC perlu 12 digit atau kosong." });

    const supabase = getSupabaseAdmin();

    const checked = await verifyOtpInput(supabase, {
      phone,
      purpose: "signup",
      otp
    });

    if (!checked.ok) {
      return json(400, { ok: false, error: checked.error || "OTP tidak sah." });
    }

    const existingCustomer = await findCustomerByPhoneCandidates(supabase, phone);

    let dbPhone = existingCustomer?.phone
      ? String(existingCustomer.phone).replace(/\D+/g, "")
      : phone;

    if (dbPhone.startsWith("60")) {
      dbPhone = "0" + dbPhone.slice(2);
    }

    const finalPhone = dbPhone;

    const rpc = await supabase.rpc("register_finish_v2", {
      in_name: name || "",
      in_phone: finalPhone,
      in_ic: ic || "",
      in_alamat: alamat || "",
      in_otp: otp,
      in_password: password
    });

    if (rpc.error) {
      console.error("register_finish_v2 error:", rpc.error);
      return json(400, { ok: false, error: rpc.error.message || "Daftar gagal." });
    }

    let row = null;
    const data = rpc.data;

    if (Array.isArray(data) && data.length) {
      row = data[0];
    } else if (data && typeof data === "object") {
      row = data;
    } else if (typeof data === "string") {
      row = {
        id: data,
        name: name || finalPhone,
        phone: finalPhone,
        ic: ic || "",
        alamat: alamat || ""
      };
    }

   const finalId = row?.id || row?.customer_id || null;
    if (!finalId) {
      return json(400, { ok: false, error: "Daftar gagal (tiada ID pelanggan)." });
    }

   // attach agent pada customer jika agent_slug dihantar & customer belum ada agent
    if (agentSlugIn) {
      try {
        const agentRow = await findAgentBySlug(supabase, agentSlugIn);

        if (agentRow) {
          const custQ = await supabase
            .from("customers")
            .select("id,agent_slug,ref_agent_slug")
            .eq("id", finalId)
            .limit(1)
            .maybeSingle();

          if (!custQ.error && custQ.data) {
            const cust = custQ.data;
            const hasAgent =
              !!String(cust.agent_slug || "").trim() ||
              !!String(cust.ref_agent_slug || "").trim();

            if (!hasAgent) {
              const patch = {
                agent_slug: agentRow.slug,
                ref_agent_slug: agentRow.slug
              };

              const up = await supabase
                .from("customers")
                .update(patch)
                .eq("id", finalId);

              if (up.error) {
                console.warn("attach agent to customer failed:", up.error);
              } else {
                row = {
                  ...row,
                  agent_slug: agentRow.slug,
                  ref_agent_slug: agentRow.slug
                };
              }
            }
          }
        }
      } catch (e) {
        console.warn("find/attach agent failed:", e);
      }
    }

    await consumeOtp(supabase, checked.record.id);

   const thread = await getOrCreateThread(supabase, {
      phone: finalPhone,
      threadId: threadIdIn || checked.record.thread_id || null,
      status: "OPEN",
      meta: {
        ...(agentSlugIn ? { agent_slug: agentSlugIn } : {})
      }
    });

    await insertAiMessage(supabase, {
      threadId: thread.id,
      text:
        `Pendaftaran berjaya ✅\n` +
        `Telefon: ${row?.phone || finalPhone}\n` +
        `Nama: ${row?.name || name || finalPhone}`,
      meta: {
        auth_event: "SIGNUP_SUCCESS",
        purpose: "signup",
        customer_id: finalId
      }
    });

    const user = {
      id: finalId,
      name: row?.name || name || finalPhone,
      phone: row?.phone || finalPhone,
      ic: row?.ic ?? ic ?? "",
      alamat: row?.alamat ?? alamat ?? ""
    };

    return json(200, {
      ok: true,
      user,
      thread_id: thread.id,
      message: "Pendaftaran berjaya."
    });
  } catch (e) {
    console.error("auth-signup-finish error:", e);
    return json(500, {
      ok: false,
      error: e?.message || String(e)
    });
  }
};