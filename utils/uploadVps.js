// utils/uploadMedianet.js
const fs = require("fs");
const path = require("path");

const VIDEO_DIR = path.join(__dirname, "..", "public", "videos");
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://video.xopboo.com"
).replace(/\/+$/, "");

if (!fs.existsSync(VIDEO_DIR)) {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
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

async function uploadVideo(filePath, filename) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Local upload failed: source file not found");
  }

  const finalName = sanitizeFilename(filename);
  const destPath = path.join(VIDEO_DIR, finalName);

  await fs.promises.copyFile(filePath, destPath);

  const stat = await fs.promises.stat(destPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("Local upload failed: saved file is invalid");
  }

  return {
    success: true,
    url: `${PUBLIC_BASE_URL}/videos/${encodeURIComponent(finalName)}`,
    service: "local-vps",
    permanent: false,
    path: destPath,
    size: stat.size,
  };
}

module.exports = {
  uploadVideo,
};
