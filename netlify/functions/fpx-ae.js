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

exports.handler = async function (event) {
  try {
    const q = event.queryStringParameters || {};

    const orderNo = q.orderNo || "";
    const txnTime = q.txnTime || "";
    const amount = Number(q.amount || 1).toFixed(2);
    const bank = q.bank || "TEST0021";

    if (!orderNo) {
      throw new Error("orderNo is required");
    }

    if (!txnTime) {
      throw new Error("txnTime is required");
    }

    const fields = {
      fpx_buyerAccNo: "",
      fpx_buyerBankBranch: "",
      fpx_buyerBankId: bank,
      fpx_buyerEmail: "test@emasamir.app",
      fpx_buyerIban: "",
      fpx_buyerId: "",
      fpx_buyerName: "UAT Buyer",
      fpx_makerName: "",

      fpx_msgToken: "01",
      fpx_msgType: "AE",

      fpx_productDesc: "EMAS AMIR FPX UAT",

      fpx_sellerBankCode: "01",
      fpx_sellerExId: EXCHANGE_ID,
      fpx_sellerExOrderNo: orderNo,
      fpx_sellerId: SELLER_ID,
      fpx_sellerOrderNo: orderNo,
      fpx_sellerTxnTime: txnTime,

      fpx_txnAmount: amount,
      fpx_txnCurrency: "MYR",
      fpx_version: "7.0"
    };

    // Semua field request, ascending ikut nama field
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

    const response = await fetch(FPX_AE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*"
      },
      body: new URLSearchParams(fields).toString()
    });

    const raw = await response.text();

    console.log("FPX AE CHECKSUM SOURCE:", checksumSource);
    console.log("FPX AE RAW RESPONSE:", raw);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        ok: true,
        orderNo,
        txnTime,
        amount,
        bank,
        checksumSource,
        httpStatus: response.status,
        response: raw
      }, null, 2)
    };

  } catch (err) {
    console.error("FPX AE ERROR:", err);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        ok: false,
        error: err.message
      }, null, 2)
    };
  }
};