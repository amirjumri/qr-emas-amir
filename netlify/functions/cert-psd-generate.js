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

function cmToPx(cm, dpi) {
  return Math.round((Number(cm) / 2.54) * Number(dpi));
}

/**
 * Cover-crop image to target W/H (like CSS background-size: cover)
 * NOTE: sharp akan enlarge kalau source kecil (default behaviour).
 */
async function coverToPngBuffer(inputBuf, targetW, targetH) {
  return await sharp(inputBuf, { failOn: "none" })
    .resize(targetW, targetH, {
      fit: "cover",
      position: "centre",
    })
    .png()
    .toBuffer();
}

/**
 * Calculate grid positions (cols x rows) inside canvas with margin + gap.
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

  // center tapi pastikan tak kurang dari margin minimum
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
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(), body: "" };
    }
    if (event.httpMethod !== "POST") {
      return json(405, { ok: false, error: "Method not allowed" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return json(500, {
        ok: false,
        error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
      });
    }

    // Body: { job_id, images: [{path, rotateDeg?}], config? }
    const body = JSON.parse(event.body || "{}");
    const jobId = String(body.job_id || "").trim() || `job_${Date.now()}`;

    const images = Array.isArray(body.images) ? body.images : [];
    if (images.length < 1) return json(400, { ok: false, error: "No images provided" });
    if (images.length > 36) return json(400, { ok: false, error: "Max 36 images" });

    const cfg = body.config || {};

    // ===== DPI =====
    const dpi = Number(cfg.dpi || 300);

    // ===== CANVAS SIZE =====
    // Option A: bagi cm terus -> kira px ikut dpi
    // Option B: bagi px terus (fallback)
    const canvasW =
      cfg.canvasWcm != null ? cmToPx(Number(cfg.canvasWcm), dpi) : Number(cfg.canvasW || 4724);
    const canvasH =
      cfg.canvasHcm != null ? cmToPx(Number(cfg.canvasHcm), dpi) : Number(cfg.canvasH || 6850);

    const cols = Number(cfg.cols || 6);
    const rows = Number(cfg.rows || 6);

    // ===== SLOT SIZE (pixel) =====
    const slotW = Number(cfg.slotW || 650);
    const slotH = Number(cfg.slotH || 1028);

    // ===== JARAK =====
    const gapX =
      cfg.gapX != null
        ? Number(cfg.gapX)
        : cmToPx(cfg.gapXcm != null ? cfg.gapXcm : 1.2, dpi);

    const gapY =
      cfg.gapY != null
        ? Number(cfg.gapY)
        : cmToPx(cfg.gapYcm != null ? cfg.gapYcm : 0.6, dpi);

    // margin tepi: kalau tak bagi, biar auto-center (0 minimum)
    const marginX =
      cfg.marginX != null
        ? Number(cfg.marginX)
        : cmToPx(cfg.marginXcm != null ? cfg.marginXcm : 0, dpi);

    const marginY =
      cfg.marginY != null
        ? Number(cfg.marginY)
        : cmToPx(cfg.marginYcm != null ? cfg.marginYcm : 0, dpi);

    const includeGrid = cfg.includeGrid !== false; // default true

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    const grid = calcGrid({
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
    });

    // download image by "bucket/path/file.jpg"
    async function downloadByPath(fullPath) {
      const parts = String(fullPath).split("/");
      const bucket = parts.shift();
      const path = parts.join("/");
      if (!bucket || !path) throw new Error(`Invalid storage path: ${fullPath}`);

      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error) throw error;

      const arrayBuffer = await data.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }

    const layers = [];

    // GRID layer
    if (includeGrid) {
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

      const gridPng = await sharp(Buffer.from(svg)).png().toBuffer();
      const { data: raw, info } = await sharp(gridPng)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      layers.push({
        name: "GRID (panduan print)",
        opacity: 255,
        left: 0,
        top: 0,
        imageData: {
          width: info.width,
          height: info.height,
          data: new Uint8ClampedArray(raw),
        },
      });
    }

    // Image layers (1 layer per slot)
    const max = Math.min(images.length, cols * rows);
    for (let idx = 0; idx < max; idx++) {
      const imgPath = images[idx]?.path;
      if (!imgPath) continue;

      const slot = grid.slots[idx];
      const srcBuf = await downloadByPath(imgPath);

      // rotate (optional) - 0/90/180/270
      let rot = Number(images[idx]?.rotateDeg || images[idx]?.rotate_deg || 0);
      if (!isFinite(rot)) rot = 0;
      rot = ((rot % 360) + 360) % 360;

      const snaps = [0, 90, 180, 270];
      let best = 0,
        bestDiff = 9999;
      for (const s of snaps) {
        const d = Math.abs(rot - s);
        if (d < bestDiff) {
          bestDiff = d;
          best = s;
        }
      }
      rot = best;

      // cover ikut slot pixel
      // kalau rotate 90/270, rotate dulu, lepas tu cover ke slotW/slotH
      let bufForFit = srcBuf;
      if (rot) {
        bufForFit = await sharp(srcBuf, { failOn: "none" }).rotate(rot).toBuffer();
      }

      const fittedPng = await coverToPngBuffer(bufForFit, slotW, slotH);

      const { data: raw, info } = await sharp(fittedPng)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      layers.push({
        name: `SLOT_${String(idx + 1).padStart(2, "0")}`,
        opacity: 255,
        left: slot.x,
        top: slot.y,
        imageData: {
          width: info.width,
          height: info.height,
          data: new Uint8ClampedArray(raw),
        },
      });
    }

    // ✅ PSD doc
    // IMPORTANT: ag-psd guna resolutionInfo key=1005:
    // { horizontalResolution, horizontalResolutionUnit:'PPI', widthUnit:'Inches', ... }
    // Kalau salah field (hRes/vRes), Photoshop akan fallback 72.
    const psd = {
      width: canvasW,
      height: canvasH,
      colorMode: 3, // RGB
      imageResources: {
        resolutionInfo: {
          horizontalResolution: dpi,
          horizontalResolutionUnit: "PPI",
          widthUnit: "Inches",
          verticalResolution: dpi,
          verticalResolutionUnit: "PPI",
          heightUnit: "Inches",
        },
      },
      children: layers,
    };

    const psdBuf = writePsdBuffer(psd);

    // Upload PSD to storage
    const outBucket = String(cfg.outputBucket || "cert_uploads");
    const outPath = String(cfg.outputPath || `cert_psd/${jobId}/front_36.psd`);

    const { error: upErr } = await supabase.storage.from(outBucket).upload(outPath, psdBuf, {
      contentType: "image/vnd.adobe.photoshop",
      upsert: true,
    });
    if (upErr) throw upErr;

    // Signed URL (valid 1 hour)
    const { data: signed, error: signErr } = await supabase.storage
      .from(outBucket)
      .createSignedUrl(outPath, 3600);
    if (signErr) throw signErr;

    return json(200, {
      ok: true,
      job_id: jobId,
      output: { bucket: outBucket, path: outPath, signed_url: signed.signedUrl },
      config_used: {
        dpi,
        canvasW,
        canvasH,
        canvasWcm: cfg.canvasWcm != null ? Number(cfg.canvasWcm) : null,
        canvasHcm: cfg.canvasHcm != null ? Number(cfg.canvasHcm) : null,
        cols,
        rows,
        slotW,
        slotH,
        marginX,
        marginY,
        gapX,
        gapY,
        includeGrid,
        startX: grid.startX,
        startY: grid.startY,
        gridW: grid.gridW,
        gridH: grid.gridH,
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
};