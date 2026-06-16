exports.handler = async function () {
  return {
    statusCode: 302,
    headers: {
      Location: "/fpx/indirect.html"
    },
    body: ""
  };
};