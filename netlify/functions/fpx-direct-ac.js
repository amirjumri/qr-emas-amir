exports.handler = async function(event) {
  console.log("FPX DIRECT AC RECEIVED:", {
    method: event.httpMethod,
    headers: event.headers,
    query: event.queryStringParameters,
    body: event.body
  });

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/plain"
    },
    body: "OK"
  };
};