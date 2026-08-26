const EXCHANGE_ID = "EX00040523";

const FPX_BE_URL =
  "https://uat.mepsfpx.com.my/FPXMain/RetrieveBankList";

exports.handler = async () => {
  try {

    const fields = {
      fpx_msgType: "BE",
      fpx_msgToken: "01",
      fpx_sellerExId: EXCHANGE_ID
    };

    const response = await fetch(FPX_BE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "*/*"
      },
      body: new URLSearchParams(fields).toString()
    });

    const raw = await response.text();

    console.log("RAW PAYNET BC:", raw);

    /*
      Normalize response.
      PayNet may return plain form-urlencoded text
      and browser/log output can contain line breaks
      or HTML entities.
    */
    const cleaned = String(raw || "")
      .replace(/&amp;/gi, "&")
      .replace(/&#38;/gi, "&")
      .replace(/<br\s*\/?>/gi, "")
      .replace(/\r/g, "")
      .replace(/\n/g, "")
      .trim();

    /*
      Extract a field without assuming that the response
      begins exactly with &field=...
    */
    function extractField(name) {

      const re = new RegExp(
        name + "\\s*=\\s*([^&<]*)",
        "i"
      );

      const match = cleaned.match(re);

      if (!match) return "";

      try {
        return decodeURIComponent(
          match[1].replace(/\+/g, " ")
        ).trim();
      } catch {
        return match[1].trim();
      }
    }

    const msgType =
      extractField("fpx_msgType") ||
      (/fpx_msgType\s*=\s*BC/i.test(cleaned) ? "BC" : "");

    const msgToken =
      extractField("fpx_msgToken") || "01";

    const exchangeId =
      extractField("fpx_sellerExId") || EXCHANGE_ID;

    const rawBankList =
      extractField("fpx_bankList");

    if (!rawBankList) {
      console.error(
        "FPX BANK LIST NOT FOUND. RAW:",
        cleaned
      );

      throw new Error(
        "BC response received but fpx_bankList is empty."
      );
    }

    /*
      PayNet:
      ~A = Online
      ~B = Offline

      Unknown bank short names are allowed to be
      displayed using Bank ID.
    */

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

    /*
      Actual BC list observed:
      TEST0001~A,TEST0002~A,...

      We still support comma / semicolon / pipe
      just in case.
    */

    const entries = rawBankList
      .split(/[,;|]/)
      .map(v => v.trim())
      .filter(Boolean);

    const banks = [];

    for (const entry of entries) {

      const match =
        entry.match(/^([^~\s]+)\s*~\s*([AB])$/i);

      if (!match) {
        console.log(
          "SKIP UNKNOWN BANK ENTRY:",
          entry
        );
        continue;
      }

      const id = match[1].trim();
      const status = match[2].toUpperCase();

      let name =
        bankNameMap[id] || id;

      if (status === "B") {
        name += " (Offline)";
      }

      banks.push({
        id,
        name,
        status,
        online: status === "A"
      });
    }

    /*
      PayNet requires alphabetical order
      based on displayed bank short name.
    */

    banks.sort((a, b) =>
      a.name.localeCompare(
        b.name,
        "en",
        { sensitivity: "base" }
      )
    );

    if (!banks.length) {
      throw new Error(
        "fpx_bankList was received but no valid bank entries were parsed."
      );
    }

    return {
      statusCode: 200,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store, no-cache, must-revalidate"
      },

      body: JSON.stringify(
        {
          ok: true,

          messageType: msgType,
          msgToken,
          exchangeId,

          bankCount: banks.length,

          banks
        },
        null,
        2
      )
    };

  } catch (err) {

    console.error(
      "FPX BANK LIST ERROR:",
      err
    );

    return {
      statusCode: 500,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control": "no-store"
      },

      body: JSON.stringify(
        {
          ok: false,
          error: err.message
        },
        null,
        2
      )
    };
  }
};