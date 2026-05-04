const OpenAI = require("openai");
const { toFile } = require("openai/uploads");

function json(statusCode, body){
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try{
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const body = JSON.parse(event.body || "{}");
    const audioBase64 = body.audio;
    const filename = body.filename || "audio.webm";
    const mime = body.mime || "audio/webm";
    const language = body.language || "ms";

    if(!audioBase64){
      return json(400, { error: "No audio provided" });
    }

    const buffer = Buffer.from(audioBase64, "base64");
    const file = await toFile(buffer, filename, { type: mime });

    const resp = await openai.audio.transcriptions.create({
      file,
      model: "gpt-4o-mini-transcribe",
      language
    });

    return json(200, { text: resp.text || "" });
  }catch(err){
    console.error(err);
    return json(500, { error: err.message || String(err) });
  }
};