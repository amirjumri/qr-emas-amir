const EXCHANGE_ID = "EX00040523";
const FPX_BE_URL =
  "https://uat.mepsfpx.com.my/FPXMain/RetrieveBankList";

exports.handler = async () => {
  try {
    // BE = Bank List Enquiry, 01 = B2C / Retail
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

    const responseText = await response.text();

    // PayNet BC response is form-urlencoded
    const params = new URLSearchParams(responseText);

    const msgType = params.get("fpx_msgType") || "";
    const msgToken = params.get("fpx_msgToken") || "";
    const exchangeId = params.get("fpx_sellerExId") || "";
    const rawBankList = params.get("fpx_bankList") || "";

    if (msgType !== "BC") {
      throw new Error(
        "Expected BC response from PayNet. Received: " + msgType
      );
    }

    /*
      FPX bank list format contains:
      BANKID~A = Online
      BANKID~B = Offline
    */

    const nameMap = {
      TEST0021: "SBI BANK A",
      TEST0022: "SBI BANK B"
    };

    const banks = rawBankList
      .split(/[,;]/)
      .map(x => x.trim())
      .filter(Boolean)
      .map(item => {
        const parts = item.split("~");

        const id = (parts[0] || "").trim();
        const status = (parts[1] || "").trim().toUpperCase();

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
      .filter(bank => bank.id)
      .sort((a, b) =>
        a.name.localeCompare(b.name, "en", {
          sensitivity: "base"
        })
      );

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
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
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        ok: false,
        error: err.message
      })
    };
  }
};