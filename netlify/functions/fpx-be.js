const EXCHANGE_ID = "EX00040523";
const FPX_BE_URL =
  "https://uat.mepsfpx.com.my/FPXMain/RetrieveBankList";

exports.handler = async function () {
  try {
    const fields = {
      fpx_msgType: "BE",
      fpx_msgToken: "01",
      fpx_sellerExId: EXCHANGE_ID
    };

    const body = new URLSearchParams(fields).toString();

    const response = await fetch(FPX_BE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*"
      },
      body
    });

    const responseText = await response.text();

    const esc = (v = "") =>
      String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8"
      },
      body: `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FPX BE Bank List Test</title>
<style>
body{font-family:Arial,sans-serif;background:#f6f7fb;padding:24px;color:#111}
.box{max-width:1000px;margin:auto;background:#fff;padding:22px;border-radius:16px}
pre{white-space:pre-wrap;word-break:break-all;background:#111;color:#fff;padding:15px;border-radius:10px}
</style>
</head>
<body>
<div class="box">
<h1>FPX BE Bank List Test</h1>

<p><strong>Message Type:</strong> BE</p>
<p><strong>Message Token:</strong> 01 (B2C / Retail)</p>
<p><strong>Exchange ID:</strong> ${EXCHANGE_ID}</p>

<h3>PayNet BC Response</h3>
<p>HTTP Status: ${response.status}</p>
<pre>${esc(responseText)}</pre>

</div>
</body>
</html>`
    };

  } catch (err) {
    console.error("FPX BE ERROR", err);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      },
      body: "FPX BE error: " + err.message
    };
  }
};