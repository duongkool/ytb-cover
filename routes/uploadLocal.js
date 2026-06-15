// routes/uploadLocal.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const router = express.Router();

const TEMP_DIR = path.join(__dirname, "..", "temp", "uploads");
const VIDEO_DIR = path.join(__dirname, "..", "public", "videos");
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://video.xopboo.com"
).replace(/\/+$/, "");

for (const dir of [TEMP_DIR, VIDEO_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilename(filename) {
  const raw = String(filename || `video_${Date.now()}.mp4`).trim();
  const ext = path.extname(raw).toLowerCase() || ".mp4";
  const base = path
    .basename(raw, ext)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "")
    .slice(0, 120);

  return `${base || `video_${Date.now()}`}${ext}`;
}

async function ensureUniqueFilename(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  let candidate = filename;
  let counter = 1;

  while (fs.existsSync(path.join(VIDEO_DIR, candidate))) {
    candidate = `${base}_${counter}${ext}`;
    counter += 1;
  }

  return candidate;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_DIR),
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}_${sanitizeFilename(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB
  },
  fileFilter: (_req, file, cb) => {
    const allowedMime = [
      "video/mp4",
      "video/quicktime",
      "video/x-matroska",
      "video/webm",
      "application/octet-stream",
    ];

    const allowedExt = [".mp4", ".mov", ".mkv", ".webm"];
    const ext = path.extname(file.originalname || "").toLowerCase();

    if (allowedMime.includes(file.mimetype) || allowedExt.includes(ext)) {
      return cb(null, true);
    }

    return cb(new Error("Only video files are allowed"));
  },
});

router.post("/", upload.single("file"), async (req, res) => {
  let tempPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Missing file",
      });
    }

    tempPath = req.file.path;

    const requestedName =
      req.body.filename || req.file.originalname || `video_${Date.now()}.mp4`;

    const safeName = sanitizeFilename(requestedName);
    const finalName = await ensureUniqueFilename(safeName);
    const destPath = path.join(VIDEO_DIR, finalName);

    await fs.promises.copyFile(tempPath, destPath);

    const stat = await fs.promises.stat(destPath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error("Saved file is invalid");
    }

    return res.json({
      success: true,
      url: `${PUBLIC_BASE_URL}/videos/${encodeURIComponent(finalName)}`,
      service: "local-vps",
      size: stat.size,
      filename: finalName,
      permanent: true,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Upload failed",
    });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlink(tempPath, () => {});
    }
  }
});

module.exports = router;
