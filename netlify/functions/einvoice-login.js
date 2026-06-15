exports.handler = async () => {
  try {
    const clientId = process.env.MYINVOIS_CLIENT_ID;
    const clientSecret = process.env.MYINVOIS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          error: "MYINVOIS_CLIENT_ID atau MYINVOIS_CLIENT_SECRET belum set dekat Netlify ENV."
        }, null, 2)
      };
    }

    const body = new URLSearchParams();
    body.append("client_id", clientId);
    body.append("client_secret", clientSecret);
    body.append("grant_type", "client_credentials");
    body.append("scope", "InvoicingAPI");

    const r = await fetch(
      "https://identity.myinvois.hasil.gov.my/connect/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body
      }
    );

    const data = await r.json().catch(() => ({}));

    if (!r.ok || !data.access_token) {
      return {
        statusCode: r.status || 400,
        body: JSON.stringify({
          ok: false,
          message: "MyInvois login gagal.",
          status: r.status,
          error: data
        }, null, 2)
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        message: "MyInvois login berjaya.",
        token_type: data.token_type,
        expires_in: data.expires_in,
        scope: data.scope
      }, null, 2)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: String(err?.message || err)
      }, null, 2)
    };
  }
};