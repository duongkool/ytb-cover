const fs = require("fs");
const path = require("path");

const TEMP_VIDEO_DIR = path.join(__dirname, "..", "public", "temp-videos");

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://video.xopboo.com"
).replace(/\/+$/, "");

if (!fs.existsSync(TEMP_VIDEO_DIR)) {
  fs.mkdirSync(TEMP_VIDEO_DIR, { recursive: true });
}

function sanitizeFilename(filename) {
  const base = String(filename || `${Date.now()}.mp4`)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  if (!base) {
    return `${Date.now()}.mp4`;
  }

  return base.endsWith(".mp4") ? base : `${base}.mp4`;
}

async function ensureUniqueFilename(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  let finalName = filename;
  let counter = 1;

  while (fs.existsSync(path.join(TEMP_VIDEO_DIR, finalName))) {
    finalName = `${base}_${counter}${ext}`;
    counter += 1;
  }

  return finalName;
}

async function uploadVideo(filePath, filename) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Temp video upload failed: source file not found");
  }

  const safeName = sanitizeFilename(filename);
  const finalName = await ensureUniqueFilename(safeName);

  const destPath = path.join(TEMP_VIDEO_DIR, finalName);

  await fs.promises.copyFile(filePath, destPath);

  const stat = await fs.promises.stat(destPath);

  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("Temp video upload failed: saved file is invalid");
  }

  return {
    success: true,

    url: `${PUBLIC_BASE_URL}/temp-videos/${encodeURIComponent(finalName)}`,

    service: "local-vps-temp",

    permanent: false,

    expiresAfterHours: 2,

    filename: finalName,

    path: destPath,

    size: stat.size,
  };
}

module.exports = {
  uploadVideo,
};
