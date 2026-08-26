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
  ABB0233: "Affin Bank",
  ABB0234: "Affin B2C - Test ID",
  ABMB0212: "Alliance Bank (Personal)",
  AGRO01: "AGRONet",
  AMBB0209: "AmBank",
  BCBB0235: "CIMB Clicks",
  BIMB0340: "Bank Islam",
  BKRM0602: "Bank Rakyat",
  BMMB0341: "Bank Muamalat",
  BOCM01: "Bank Of China",
  BSN0601: "BSN",
  CIT0219: "Citibank",
  GXBANK01: "GXBank",
  HLB0224: "Hong Leong Bank",
  HSBC0223: "HSBC Bank",
  KAFB01: "KAF Digital Bank",
  KFH0346: "KFH",
  LOAD001: "Load Test Bank",
  MB2U0227: "Maybank2U",
  MBB0228: "Maybank2E",
  MBBM2U2: "Maybank Test Bank",
  MBSB001: "MBSB Bank",
  OCBC0229: "OCBC Bank",
  PBB0233: "Public Bank",
  RHB0218: "RHB Bank",
  SCB0216: "Standard Chartered",
  TEST0021: "SBI BANK A",
  TEST0022: "SBI BANK B",
  TEST0023: "SBI BANK C",
  UOB0226: "UOB Bank"
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