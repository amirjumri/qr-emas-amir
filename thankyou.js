<!doctype html>
<html lang="ms">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Terima kasih – Emas Amir</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#fafafa}
  .wrap{max-width:680px;margin:40px auto;padding:20px}
  .card{background:#fff;border:1px solid #eee;border-radius:12px;padding:22px;text-align:center}
  h1{margin:0 0 12px}
  .muted{color:#666}
  .btn{display:inline-block;margin-top:16px;padding:12px 16px;border-radius:10px;background:#111;color:#fff;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Terima kasih atas tempahan!</h1>
    <p class="muted">Anda boleh teruskan urusan di WhatsApp bersama admin.</p>
    <p id="ref" class="muted"></p>
    <a class="btn" href="/">Kembali ke laman utama</a>
  </div>
</div>
<script>
  const p=new URLSearchParams(location.search);
  const r=p.get("ref"); if(r){ document.getElementById("ref").textContent="Rujukan: "+r; }
</script>
</body>
</html>