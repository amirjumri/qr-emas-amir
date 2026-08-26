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
        Accept: "*/*"
      },
      body: new URLSearchParams(fields).toString()
    });

    const raw = await response.text();

    console.log("RAW PAYNET BC:", raw);

    // Decode HTML entities if PayNet response contains them
    const cleaned = raw
      .replace(/&amp;/g, "&")
      .replace(/&#38;/g, "&")
      .trim();

    // Extract values directly from raw response
    const getValue = (name) => {
      const match = cleaned.match(
        new RegExp("(?:^|[?&])" + name + "=([^&]*)", "i")
      );

      return match
        ? decodeURIComponent(match[1].replace(/\+/g, " "))
        : "";
    };

    let msgType = getValue("fpx_msgType");
    let msgToken = getValue("fpx_msgToken");
    let exchangeId = getValue("fpx_sellerExId");
    let rawBankList = getValue("fpx_bankList");

    /*
      Fallback:
      Some FPX responses may not contain the usual &
      separators in the form we expect.
    */
    if (!rawBankList) {
      const match = cleaned.match(
        /fpx_bankList=([\s\S]*?)(?:&fpx_|$)/i
      );

      if (match) {
        rawBankList = decodeURIComponent(
          match[1].replace(/\+/g, " ")
        );
      }
    }

    if (!msgType && /fpx_msgType=BC/i.test(cleaned)) {
      msgType = "BC";
    }

    if (!msgToken) msgToken = "01";
    if (!exchangeId) exchangeId = EXCHANGE_ID;

    if (!rawBankList) {
      throw new Error(
        "PayNet BC received but fpx_bankList could not be extracted."
      );
    }

    /*
      PayNet format:
      BANKID~A = Online
      BANKID~B = Offline
    */

    const nameMap = {
      TEST0021: "SBI BANK A",
      TEST0022: "SBI BANK B"
    };

    /*
      Bank list may be separated by comma,
      semicolon OR pipe depending on response.
    */

    const entries = rawBankList
      .split(/[,;|]/)
      .map(v => v.trim())
      .filter(Boolean);

    const banks = entries
      .map(item => {

        const parts = item.split("~");

        const id = (parts[0] || "").trim();
        const status =
          (parts[1] || "").trim().toUpperCase();

        if (!id) return null;

        let name = nameMap[id] || id;

        if (status === "B") {
          name += " (Offline)";
        }

        return {
          id,
          name,
          status
        };
      })
      .filter(Boolean)
      .sort((a, b) =>
        a.name.localeCompare(b.name, "en", {
          sensitivity: "base"
        })
      );

    return {
      statusCode: 200,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control": "no-store"
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

    console.error("FPX BANK LIST ERROR:", err);

    return {
      statusCode: 500,

      headers: {
        "Content-Type":
          "application/json; charset=utf-8"
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