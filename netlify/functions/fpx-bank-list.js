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
  ABB0234: "Affin B2C - Test ID",
  ABB0233: "Affin Bank",
  ABMB0212: "Alliance Bank (Personal)",
  AGRO01: "AGRONet",
  AMBB0209: "AmBank",
  BIMB0340: "Bank Islam",
  BMMB0341: "Bank Muamalat",
  BKRM0602: "Bank Rakyat",
  BOCM01: "Bank Of China",
  BSN0601: "BSN",
  BCBB0235: "CIMB Clicks",
  CIT0219: "Citibank",

  // Bank IDs returned by BC but not shown in the
  // PayNet SMI reference supplied to us.
  // PayNet instructed merchant to display Bank ID
  // when short/display name is not maintained.
  GXBANK01: "GXBank",

  HLB0224: "Hong Leong Bank",
  HSBC0223: "HSBC Bank",

  KAFB01: "KAF Bank",

  KFH0346: "KFH",

  LOAD001: "LOAD001",

  MBB0228: "Maybank2E",
  MB2U0227: "Maybank2U",

  MBBM2U2: "MBBM2U2",
  MBSB001: "MBSB001",

  OCBC0229: "OCBC Bank",
  PBB0233: "Public Bank",
  RHB0218: "RHB Bank",

  TEST0021: "SBI Bank A",
  TEST0022: "SBI Bank B",
  TEST0023: "SBI Bank C",

  SCB0216: "Standard Chartered",
  UOB0226: "UOB Bank",
  UOB0229: "UOB Bank - Test ID"
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