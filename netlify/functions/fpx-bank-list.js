const crypto = require("crypto");

const EXCHANGE_ID = "EX00040523";
const FPX_BE_URL =
  "https://uat.mepsfpx.com.my/FPXMain/RetrieveBankList";

function signData(data) {
  const privateKey = require("./fpx-key");

  const signer = crypto.createSign("RSA-SHA1");
  signer.update(data, "utf8");
  signer.end();

  return signer.sign(privateKey).toString("hex").toUpperCase();
}

exports.handler = async () => {
  try {
    const fields = {
      fpx_msgToken: "01",
      fpx_msgType: "BE",
      fpx_sellerExId: EXCHANGE_ID,
      fpx_version: "7.0"
    };

    const checksumSource = [
      fields.fpx_msgToken,
      fields.fpx_msgType,
      fields.fpx_sellerExId,
      fields.fpx_version
    ].join("|");

    fields.fpx_checkSum = signData(checksumSource);

    const response = await fetch(FPX_BE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*"
      },
      body: new URLSearchParams(fields).toString()
    });

    const raw = await response.text();

    console.log("RAW PAYNET BC:", raw);

    const params = new URLSearchParams(raw);

    const rawBankList = params.get("fpx_bankList") || "";
    const msgType = params.get("fpx_msgType") || "";
    const msgToken = params.get("fpx_msgToken") || "";
    const exchangeId = params.get("fpx_sellerExId") || "";

    if (!rawBankList) {
      throw new Error("No fpx_bankList returned. Raw: " + raw);
    }

    const bankNameMap = {
      TEST0001: "Affin Bank",
      TEST0002: "Alliance Bank",
      TEST0003: "AmBank",
      TEST0004: "Bank Islam",
      TEST0005: "Bank Muamalat",
      TEST0006: "Bank Rakyat",
      TEST0007: "BSN",
      TEST0008: "CIMB Clicks",
      TEST0009: "Hong Leong Bank",
      TEST0010: "Maybank2u",
      TEST0021: "SBI BANK A",
      TEST0022: "SBI BANK B"
    };

    const banks = rawBankList
      .split(",")
      .map(item => {
        const [id, status] = item.trim().split("~");

        if (!id || !status) return null;

        let name = bankNameMap[id] || id;

        if (status.toUpperCase() === "B") {
          name += " (Offline)";
        }

        return {
          id,
          name,
          status: status.toUpperCase()
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      },
      body: JSON.stringify({
        ok: true,
        messageType: msgType,
        msgToken,
        exchangeId,
        checksumSource,
        bankCount: banks.length,
        banks
      }, null, 2)
    };

  } catch (err) {
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