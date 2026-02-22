// netlify/functions/cert-psd-generate.js
const { createClient } = require("@supabase/supabase-js");
const sharp = require("sharp");
const { writePsdBuffer } = require("ag-psd");

const corsHeaders = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(data),
  };
}

/**
 * Cover-crop image to target W/H (like CSS background-size: cover)
 */
async function coverToPngBuffer(inputBuf, targetW, targetH) {
  // sharp: resize cover + center crop, output PNG with alpha
  return await sharp(inputBuf)
    .resize(targetW, targetH, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
}

/**
 * Calculate grid positions (cols x rows) inside canvas with margin + gap.
 * If it doesn't fit, it will auto-shrink gap slightly; if still doesn't fit, it will scale slots (NOT recommended).
 * For v1: we assume it fits using Amir's known canvas.
 */
function calcGrid({
  canvasW,
  canvasH,
  cols,
  rows,
  slotW,
  slotH,
  marginX,
  marginY,
  gapX,
  gapY,
}) {
  const gridW = cols * slotW + (cols - 1) * gapX;
  const gridH = rows * slotH + (rows - 1) * gapY;

  // center inside canvas with margins (use margin as minimum)
  const startX = Math.max(marginX, Math.floor((canvasW - gridW) / 2));
  const startY = Math.max(marginY, Math.floor((canvasH - gridH) / 2));

  const slots = [];
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = startX + c * (slotW + gapX);
      const y = startY + r * (slotH + gapY);
      slots.push({ i, r, c, x, y, w: slotW, h: slotH });
      i++;
    }
  }
  return { startX, startY, gridW, gridH, slots };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, { ok: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
    }

    // Body: { job_id, images: [{path}], config? }
    const body = JSON.parse(event.body || "{}");
    const jobId = String(body.job_id || "").trim() || `job_${Date.now()}`;

    const images = Array.isArray(body.images) ? body.images : [];
    if (images.length < 1) return json(400, { ok: false, error: "No images provided" });
    if (images.length > 36) return json(400, { ok: false, error: "Max 36 images" });

    // Defaults ikut flow Amir
    const cfg = body.config || {};
    const canvasW = Number(cfg.canvasW || 4724); // Amir punya screenshot: 4724 x 6850 @300
    const canvasH = Number(cfg.canvasH || 6850);
    const cols = Number(cfg.cols || 6);
    const rows = Number(cfg.rows || 6);

    const slotW = Number(cfg.slotW || 650);
    const slotH = Number(cfg.slotH || 1028);

    // gap/margin boleh adjust “sikit2” lepas test print
    const marginX = Number(cfg.marginX ?? 180);
    const marginY = Number(cfg.marginY ?? 180);
    const gapX = Number(cfg.gapX ?? 24);
    const gapY = Number(cfg.gapY ?? 24);

    const includeGrid = cfg.includeGrid !== false; // default true

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Grid positions
    const grid = calcGrid({ canvasW, canvasH, cols, rows, slotW, slotH, marginX, marginY, gapX, gapY });

    // Download all images from Supabase Storage paths
    // Expect: images[].path = "bucket/path/file.jpg"
    // Example: "cert_uploads/front/job123/01.jpg"
    async function downloadByPath(fullPath) {
      // fullPath can be "bucket/some/path.png"
      const parts = String(fullPath).split("/");
      const bucket = parts.shift();
      const path = parts.join("/");
      if (!bucket || !path) throw new Error(`Invalid storage path: ${fullPath}`);

      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error) throw error;
      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    // Prepare PSD layers
    const layers = [];

    // (optional) grid layer as vector-like raster (thin lines)
    if (includeGrid) {
      // Create an overlay PNG with lines
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">
          <rect x="0" y="0" width="${canvasW}" height="${canvasH}" fill="transparent"/>
          ${grid.slots
            .map(
              (s) =>
                `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="#000000" stroke-width="3"/>`
            )
            .join("")}
        </svg>
      `;
      const gridPng = await sharp(Buffer.from(svg))
        .png()
        .toBuffer();

      layers.push({
        name: "GRID (panduan print)",
        opacity: 255,
        canvas: await sharp(gridPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => ({
          width: info.width,
          height: info.height,
          data,
        })),
      });
    }

    // Image layers (1 layer per slot)
    for (let idx = 0; idx < Math.min(images.length, cols * rows); idx++) {
      const imgPath = images[idx]?.path;
      if (!imgPath) continue;

      const slot = grid.slots[idx];
      const srcBuf = await downloadByPath(imgPath);
      const fittedPng = await coverToPngBuffer(srcBuf, slotW, slotH);

      // Convert to raw RGBA for ag-psd
      const { data: raw, info } = await sharp(fittedPng)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      layers.push({
        name: `SLOT_${String(idx + 1).padStart(2, "0")}`,
        top: slot.y,
        left: slot.x,
        opacity: 255,
        canvas: {
          width: info.width,
          height: info.height,
          data: raw,
        },
      });
    }

    // PSD doc
    const psd = {
      width: canvasW,
      height: canvasH,
      colorMode: 3, // RGB
      children: layers.map((l) => ({
        name: l.name,
        opacity: l.opacity,
        left: l.left || 0,
        top: l.top || 0,
        canvas: l.canvas,
      })),
    };

    const psdBuf = writePsdBuffer(psd);

    // Upload PSD to storage
    const outBucket = String(cfg.outputBucket || "cert_outputs");
    const outPath = `psd/${jobId}/front_36.psd`;

    const { error: upErr } = await supabase.storage.from(outBucket).upload(outPath, psdBuf, {
      contentType: "image/vnd.adobe.photoshop",
      upsert: true,
    });
    if (upErr) throw upErr;

    // Signed URL (valid 1 hour)
    const { data: signed, error: signErr } = await supabase.storage.from(outBucket).createSignedUrl(outPath, 3600);
    if (signErr) throw signErr;

    return json(200, {
      ok: true,
      job_id: jobId,
      output: { bucket: outBucket, path: outPath, signed_url: signed.signedUrl },
      config_used: { canvasW, canvasH, cols, rows, slotW, slotH, marginX, marginY, gapX, gapY, includeGrid },
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
};