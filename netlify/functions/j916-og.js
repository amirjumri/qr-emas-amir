const { createClient } = require("@supabase/supabase-js");

const SB_URL = process.env.SUPABASE_URL || "https://dduizetstqqjrpsezbpi.supabase.co";
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const sb = createClient(SB_URL, SB_KEY);

function esc(s){
  return String(s || "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}

function fixUrl(url){
  if (!url) return "https://emasamir.app/icons/icon-512.png";
  url = String(url).trim();
  if (url.startsWith("http")) return url;
  return "https://dduizetstqqjrpsezbpi.supabase.co/storage/v1/object" + url;
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};

let design = String(qs.design || "").trim();

if (!design) {
  const path = String(event.path || "");
  design = decodeURIComponent(path.split("/p/")[1] || "").trim();
}

  let title = "Barang Kemas 916 — Emas Amir";
  let desc = "Lihat koleksi Barang Kemas 916 di Emas Amir.";
  let img = "https://emasamir.app/icons/icon-512.png";

  try{
    if (design){
      const { data } = await sb
        .from("j916_designs")
        .select("id,name,img1_url,img2_url,img3_url,img1,img2,img3,video_url")
        .eq("id", design)
        .maybeSingle();

      if (data){
        title = `${data.name || "Barang Kemas 916"} — Emas Amir`;
        desc = "Lihat barang ini di Emas Amir. Tekan link untuk tengok pilihan, harga dan stok.";
        img = fixUrl(data.img1_url || data.img1 || data.img2_url || data.img2 || data.img3_url || data.img3);
      }
    }
  }catch(e){
    console.warn("j916-og error:", e);
  }

 const target = "https://emasamir.app/j916.html" + (design ? "?design=" + encodeURIComponent(design) : "");

  const html = `<!doctype html>
<html lang="ms">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="Emas Amir">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(target)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:secure_url" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">

<meta http-equiv="refresh" content="1;url=${esc(target)}">
<script>
  setTimeout(function(){
    location.replace(${JSON.stringify(target)});
  }, 900);
</script>
</head>
<body>
<a href="${esc(target)}">Buka barang di Emas Amir</a>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300"
    },
    body: html
  };
};