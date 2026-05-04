exports.handler = async function(event) {
  try {
    const zone = String(event.queryStringParameters?.zone || "KDH05")
      .replace(/[^A-Z0-9]/gi, "")
      .toUpperCase();

    const r = await fetch(`https://solat.my/api/daily/${zone}`);
    const data = await r.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=1800"
      },
      body: JSON.stringify(data)
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ error: "failed_to_load_prayer_times" })
    };
  }
};