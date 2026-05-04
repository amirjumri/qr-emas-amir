const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// LIST 39 tu
const PHONES = [
"0164843868",
"01127363641",
"0129079618",
"0182660493",
"0165178405",
"0173072526",
"0136270920",
"0136407495",
"0173605643",
"0139725804",
"0176902448",
"0133623508",
"0174916650",
"0133678349",
"0137830121",
"0129302276",
"0138885507",
"01121675776",
"0109860036",
"0106691293",
"0183791364",
"0172986632",
"01128986293",
"0182604337",
"0187897650",
"0142559897",
"01163178080",
"0179676541",
"0135810041",
"0135081326",
"0135020912",
"0175410935",
"0164764382",
"0189298433",
"0192094071",
"01140683596",
"0168045093",
"0126846772",
"0134436521"
];

async function findAuthUserByEmail(email) {
  let page = 1;
  const perPage = 200;

  while (true) {
    const { data } = await supabase.auth.admin.listUsers({
      page,
      perPage
    });

    const users = data?.users || [];

    const found = users.find(
      (u) => (u.email || "").toLowerCase() === email.toLowerCase()
    );

    if (found) return found;

    if (users.length < perPage) break;
    page++;
  }

  return null;
}

exports.handler = async () => {
  console.log("=== FIX MAPPING START ===");

  let mapped = 0;
  let skipped = 0;

  for (const phone of PHONES) {

    const email = `${phone}@emasamir.app`;

    // 1️⃣ cari customer
    const { data: customer } = await supabase
      .from("customers")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();

    if (!customer) {
      console.log("NO CUSTOMER:", phone);
      skipped++;
      continue;
    }

    // 2️⃣ cari auth
    const authUser = await findAuthUserByEmail(email);

    if (!authUser) {
      console.log("NO AUTH:", email);
      skipped++;
      continue;
    }

    // 3️⃣ insert mapping
    await supabase.from("auth_customer_map").upsert(
      {
        auth_uid: authUser.id,
        customer_id: customer.id
      },
      { onConflict: "customer_id" }
    );

    console.log("MAPPED:", phone);
    mapped++;
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      mapped,
      skipped
    })
  };
};