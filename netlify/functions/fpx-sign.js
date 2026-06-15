const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

exports.handler = async function(event) {
  try {
    const privateKeyPath =
      process.env.FPX_PRIVATE_KEY_PATH ||
      path.join(process.cwd(), "fpx-secure", "EX00040523.key");

    if (!fs.existsSync(privateKeyPath)) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          ok: false,
          error: "Private key file not found",
          privateKeyPath
        }, null, 2)
      };
    }

    const privateKey = fs.readFileSync(privateKeyPath, "utf8");

    const sampleData =
      "EX00040523|SE00120695|FPXUATTEST001|1.00|TEST0021|01";

    const signer = crypto.createSign("RSA-SHA256");
    signer.update(sampleData);
    signer.end();

    const signature = signer.sign(privateKey, "base64");

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        ok: true,
        message: "FPX signing test success",
        algorithm: "RSA-SHA256",
        sampleData,
        signature
      }, null, 2)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        error: err.message
      }, null, 2)
    };
  }
};