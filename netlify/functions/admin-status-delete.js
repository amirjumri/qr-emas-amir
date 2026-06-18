const { createClient } = require("@supabase/supabase-js");

function json(statusCode, body){
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async function(event){
  if (event.httpMethod === "OPTIONS") return json(200, { ok:true });
  if (event.httpMethod !== "POST") return json(405, { ok:false, error:"Method not allowed" });

  try{
    const body = JSON.parse(event.body || "{}");
    const id = String(body.id || "").trim();

    if (!id){
      return json(400, { ok:false, error:"Status id kosong" });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE;

    const supabase = createClient(supabaseUrl, serviceKey);

    const { error } = await supabase
      .from("app_statuses")
      .update({ is_active:false })
      .eq("id", id);

    if (error) throw error;

    return json(200, { ok:true });
  }catch(err){
    return json(500, { ok:false, error: err.message || String(err) });
  }
};