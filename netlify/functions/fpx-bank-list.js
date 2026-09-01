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

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};

    // 01 = B2C / Retail, 02 = B2B1 / Corporate
    // Default kekal B2C supaya flow lama tidak terganggu.
    const msgToken =
      String(q.mode || q.msgToken || "01").trim() === "02" ? "02" : "01";

    const fields = {
      fpx_msgToken: msgToken,
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
    const responseMsgToken = params.get("fpx_msgToken") || "";
    const exchangeId = params.get("fpx_sellerExId") || "";

    if (!rawBankList) {
      throw new Error("No fpx_bankList returned. Raw: " + raw);
    }

    // PayNet SMI v4.6 — Staging B2C, pages 6-7.
    const bankNameMapB2C = {
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
      HLB0224: "Hong Leong Bank",
      HSBC0223: "HSBC Bank",
      KFH0346: "KFH",
      LOAD001: "Load Bank",
      MB2U0227: "Maybank2U",
      MBB0228: "Maybank2E",
      MBBM2U2: "M2U Test",
      MBSB001: "MBSB Bank",
      OCBC0229: "OCBC Bank",
      PBB0233: "Public Bank",
      RHB0218: "RHB Bank",
      SCB0216: "Standard Chartered",
      TEST0021: "SBI Bank A",
      TEST0022: "SBI Bank B",
      TEST0023: "SBI Bank C",
      UOB0226: "UOB Bank"
    };

    // PayNet SMI v4.6 — Staging B2B, page 7.
    const bankNameMapB2B = {
      ABB0235: "AFFINMAX",
      ABMB0213: "Alliance Bank (Business)",
      AGRO02: "AGRONetBIZ",
      AMBB0208: "AmBank",
      BCBB0235: "CIMB Bank",
      BIMB0340: "Bank Islam",
      BKRM0602: "i-bizRAKYAT",
      BMMB0342: "Bank Muamalat",
      BNP003: "BNP Paribas",
      CIT0218: "Citibank Corporate Banking",
      DBB0199: "Deutsche Bank",
      HLB0224: "Hong Leong Bank",
      HSBC0223: "HSBC Bank",
      KFH0346: "KFH",
      LOAD001: "Load Bank",
      MBB0228: "Maybank2E",
      MBSB001: "MBSB Bank",
      OCBC0229: "OCBC Bank",
      PBB0233: "Public Bank PBe",
      PBB0234: "Public Bank PB enterprise",
      RHB0218: "RHB Bank",
      SCB0215: "Standard Chartered",
      TEST0021: "SBI Bank A",
      TEST0022: "SBI Bank B",
      TEST0023: "SBI Bank C",
      UOB0228: "UOB Regional",
      UOB0229: "UOB Bank - Test ID"
    };

    const bankNameMap =
      msgToken === "02" ? bankNameMapB2B : bankNameMapB2C;

    // Hanya bank yang diluluskan dalam PayNet SMI v4.6 untuk mode tersebut
    // dibenarkan dipaparkan. Bank tambahan daripada BC tidak akan dipaparkan.
    const approvedBankIds = new Set(Object.keys(bankNameMap));

    const banks = rawBankList
      .split(",")
      .map(item => {
        const [id, status] = item.trim().split("~");

        if (!id || !status) return null;
        if (!approvedBankIds.has(id)) return null;

        let name = bankNameMap[id];

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
        paymentMode: msgToken === "02" ? "B2B1" : "B2C",
        messageType: msgType,
        msgToken: responseMsgToken,
        exchangeId,
        checksumSource,
        approvedBankCount: approvedBankIds.size,
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
