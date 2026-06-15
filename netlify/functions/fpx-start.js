const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SELLER_ID = "SE00120695";
const EXCHANGE_ID = "EX00040523";
const FPX_AR_URL = "https://uat.mepsfpx.com.my/FPXMain/seller2DReceiver.jsp";

function signData(data){
  const privateKeyPath =
    process.env.FPX_PRIVATE_KEY_PATH ||
    path.join(__dirname, "fpx-secure", "EX00040523.key");

  const privateKey = fs.readFileSync(privateKeyPath, "utf8");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();

  return signer.sign(privateKey, "base64");
}

exports.handler = async function(event) {
  try{
    const q = event.queryStringParameters || {};

    const mode = q.mode || "01";
    const bank = q.bank || "TEST0021";
    const amount = Number(q.amount || 1).toFixed(2);
    const orderNo = q.orderNo || ("FPXUAT" + Date.now());

    const directUrl = "https://emasamir.app/.netlify/functions/fpx-direct-ac";
    const indirectUrl = "https://emasamir.app/fpx/indirect.html";

    const fields = {
      fpx_msgType: "AR",
      fpx_msgToken: mode,
      fpx_sellerExId: EXCHANGE_ID,
      fpx_sellerExOrderNo: orderNo,
      fpx_sellerTxnTime: new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0,14),
      fpx_sellerOrderNo: orderNo,
      fpx_sellerId: SELLER_ID,
      fpx_sellerBankCode: "01",
      fpx_txnCurrency: "MYR",
      fpx_txnAmount: amount,
      fpx_buyerEmail: "test@emasamir.app",
      fpx_buyerName: "UAT Buyer",
      fpx_buyerBankId: bank,
      fpx_productDesc: "EMAS AMIR FPX UAT",
      fpx_version: "7.0",
      fpx_directDebit: "false",
      fpx_buyerAccNo: "",
      fpx_buyerId: "",
      fpx_buyerIban: "",
      fpx_makerName: "",
      fpx_buyerBankBranch: "",
      fpx_url: indirectUrl
    };

    const checksumSource = [
      fields.fpx_buyerAccNo,
      fields.fpx_buyerBankBranch,
      fields.fpx_buyerBankId,
      fields.fpx_buyerEmail,
      fields.fpx_buyerIban,
      fields.fpx_buyerId,
      fields.fpx_buyerName,
      fields.fpx_makerName,
      fields.fpx_msgToken,
      fields.fpx_msgType,
      fields.fpx_productDesc,
      fields.fpx_sellerBankCode,
      fields.fpx_sellerExId,
      fields.fpx_sellerExOrderNo,
      fields.fpx_sellerId,
      fields.fpx_sellerOrderNo,
      fields.fpx_sellerTxnTime,
      fields.fpx_txnAmount,
      fields.fpx_txnCurrency,
      fields.fpx_version
    ].join("|");

    fields.fpx_checkSum = signData(checksumSource);

    const hiddenInputs = Object.entries(fields).map(([k,v]) =>
      `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}">`
    ).join("\n");

    const previewRows = Object.entries(fields).map(([k,v]) =>
      `<tr><td>${k}</td><td style="word-break:break-all">${String(v)}</td></tr>`
    ).join("");

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FPX AR Preview</title>
  <style>
    body{font-family:Arial,sans-serif;background:#f6f7fb;padding:24px;color:#111}
    .box{max-width:960px;margin:auto;background:#fff;padding:22px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
    table{width:100%;border-collapse:collapse;margin-top:18px}
    td{border:1px solid #ddd;padding:8px;font-size:13px;vertical-align:top}
    td:first-child{font-weight:700;width:230px;background:#f9fafb}
    button{background:#0b65c2;color:#fff;border:0;padding:12px 18px;border-radius:10px;font-weight:800;cursor:pointer}
    .warn{color:#b45309;font-weight:800}
  </style>
</head>
<body>
<div class="box">
  <h1>FPX AR Preview</h1>
  <p class="warn">Semak dulu. Bila tekan Submit, browser akan redirect ke PayNet UAT.</p>

  <form method="post" action="${FPX_AR_URL}">
    ${hiddenInputs}
    <button type="submit">Submit to PayNet UAT</button>
  </form>

  <table>${previewRows}</table>

  <p><a href="/fpx/checkout.html">Back to Checkout</a></p>
</div>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: html
    };

  }catch(err){
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/plain" },
      body: "FPX start error: " + err.message
    };
  }
};