const querystring = require("querystring");

exports.handler = async function(event){

  let params = {};

  if(event.httpMethod === "POST"){
    params = querystring.parse(event.body || "");
  }else{
    params = event.queryStringParameters || {};
  }

  const qs = new URLSearchParams(params).toString();

  return {
    statusCode: 302,
    headers: {
      Location: "/fpx/indirect.html?" + qs
    },
    body: ""
  };
};