const OpenAI = require("openai");

exports.handler = async (event) => {
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const body = JSON.parse(event.body || "{}");
    const audioBase64 = body.audio;

    if (!audioBase64) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No audio provided" })
      };
    }

    const buffer = Buffer.from(audioBase64, "base64");

    const response = await openai.audio.transcriptions.create({
      file: buffer,
      model: "gpt-4o-mini-transcribe",
      language: "ms"
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        text: response.text
      })
    };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};