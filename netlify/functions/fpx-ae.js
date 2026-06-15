exports.handler = async function(event) {
  const q = event.queryStringParameters || {};

  const orderNo = q.orderNo || q.fpx_sellerOrderNo || "FPXUATTEST001";

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      ok: true,
      message: "FPX AE endpoint ready",
      sellerId: "SE00120695",
      exchangeId: "EX00040523",
      msgToken: "01",
      sellerOrderNo: orderNo,
      status: "READY_FOR_REQUERY_TEST"
    }, null, 2)
  };
};