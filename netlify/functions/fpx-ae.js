const crypto = require("crypto");

const SELLER_ID = "SE00120695";
const EXCHANGE_ID = "EX00040523";
const FPX_AE_URL =
  "https://uat.mepsfpx.com.my/FPXMain/sellerNVPTxnStatus.jsp";

function signData(data) {
  const privateKey = require("./fpx-key");

  const signer = crypto.createSign("RSA-SHA1");
  signer.update(data, "utf8");
  signer.end();

  return signer.sign(privateKey).toString("hex").toUpperCase();
}

function esc(v = "") {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

exports.handler = async function (event) {
  try {
    const q = event.queryStringParameters || {};

    // Guna maklumat transaksi ASAL yang hendak di-requery
    const orderNo = q.orderNo || "FPXNEWKEY001";
    const txnTime = q.txnTime || "20260824071146";
    const amount = Number(q.amount || 1).toFixed(2);
    const bank = q.bank || "TEST0021";

    const fields = {
      fpx_msgType: "AE",
      fpx_msgToken: "01",

      fpx_sellerExId: EXCHANGE_ID,
      fpx_sellerExOrderNo: orderNo,
      fpx_sellerTxnTime: txnTime,
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

      fpx_buyerAccNo: "",
      fpx_buyerId: "",
      fpx_buyerIban: "",
      fpx_makerName: "",
      fpx_buyerBankBranch: ""
    };

    // Susunan checksum sama seperti AR yang telah berjaya.
    // Jangan masukkan fpx_url.
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

    const body = new URLSearchParams(fields).toString();

    const response = await fetch(FPX_AE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*"
      },
      body
    });

    const responseText = await response.text();

    const rows = Object.entries(fields)
      .map(
        ([k, v]) =>
          `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`
      )
      .join("");

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
<title>FPX AE Re-query Test</title>
<style>
body{font-family:Arial,sans-serif;background:#f6f7fb;padding:24px;color:#111}
.box{max-width:1000px;margin:auto;background:#fff;padding:22px;border-radius:16px}
h1{color:#0b65c2}
.ok{background:#ecfdf5;padding:12px;border-radius:10px;margin-bottom:15px}
table{width:100%;border-collapse:collapse;margin:15px 0}
td{border:1px solid #ddd;padding:8px;font-size:13px;word-break:break-all}
td:first-child{font-weight:bold;width:220px;background:#f8fafc}
pre{white-space:pre-wrap;word-break:break-all;background:#111;color:#fff;padding:15px;border-radius:10px}
</style>
</head>
<body>
<div class="box">
<h1>FPX AE Re-query Test</h1>

<div class="ok">
<strong>AE message sent to PayNet UAT</strong><br>
Seller Order No: ${esc(orderNo)}<br>
Original Transaction Time: ${esc(txnTime)}
</div>

<h3>AE Request</h3>
<table>${rows}</table>

<h3>Checksum Source</h3>
<pre>${esc(checksumSource)}</pre>

<h3>PayNet Response</h3>
<p>HTTP Status: ${response.status}</p>
<pre>${esc(responseText)}</pre>

</div>
</body>
</html>`
    };

  } catch (err) {
    console.error("FPX AE ERROR", err);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8"
      },
      body: "FPX AE error: " + err.message
    };
  }
};