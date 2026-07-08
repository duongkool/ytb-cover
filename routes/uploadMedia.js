// routes/uploadMedia.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const router = express.Router();

const MEDIA_DIR = path.join(__dirname, "..", "public", "media");

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://video.xopboo.com"
).replace(/\/+$/, "");

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function getFallbackExtByMime(mimetype) {
  const map = {
    // image
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",

    // audio
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/webm": ".weba",
    "audio/x-m4a": ".m4a",

    // video
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/webm": ".webm",
  };

  return map[mimetype] || ".bin";
}

function sanitizeFilename(filename, mimetype) {
  const raw = String(filename || `media_${Date.now()}`).trim();

  let ext = path.extname(raw).toLowerCase();

  if (!ext) {
    ext = getFallbackExtByMime(mimetype);
  }

  const base = path
    .basename(raw, ext)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/_+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 120);

  return `${base || `media-${Date.now()}`}${ext}`;
}

function ensureUniqueFilename(filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  let candidate = filename;
  let counter = 1;

  while (fs.existsSync(path.join(MEDIA_DIR, candidate))) {
    candidate = `${base}_${counter}${ext}`;
    counter += 1;
  }

  return candidate;
}

function detectMediaType(mimetype, ext) {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("audio/")) return "audio";
  if (mimetype.startsWith("video/")) return "video";

  const imageExts = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"];
  const audioExts = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".weba"];
  const videoExts = [".mp4", ".mov", ".mkv", ".webm"];

  if (imageExts.includes(ext)) return "image";
  if (audioExts.includes(ext)) return "audio";
  if (videoExts.includes(ext)) return "video";

  return "file";
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, MEDIA_DIR);
  },

  filename: (_req, file, cb) => {
    const safeName = sanitizeFilename(file.originalname, file.mimetype);
    const finalName = ensureUniqueFilename(safeName);

    cb(null, finalName);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB
  },

  fileFilter: (_req, file, cb) => {
    const allowedMime = [
      // image
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/svg+xml",

      // audio
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/webm",
      "audio/x-m4a",

      // video
      "video/mp4",
      "video/quicktime",
      "video/x-matroska",
      "video/webm",

      // fallback
      "application/octet-stream",
    ];

    const allowedExt = [
      // image
      ".jpg",
      ".jpeg",
      ".png",
      ".webp",
      ".gif",
      ".svg",

      // audio
      ".mp3",
      ".wav",
      ".m4a",
      ".aac",
      ".ogg",
      ".weba",

      // video
      ".mp4",
      ".mov",
      ".mkv",
      ".webm",
    ];

    const ext = path.extname(file.originalname || "").toLowerCase();

    if (allowedMime.includes(file.mimetype) || allowedExt.includes(ext)) {
      return cb(null, true);
    }

    return cb(new Error("Only image/audio/video files are allowed"));
  },
});

router.post("/", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message || "Upload rejected",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Missing file",
        });
      }

      const finalName = req.file.filename;
      const destPath = req.file.path;

      const stat = await fs.promises.stat(destPath);

      if (!stat.isFile() || stat.size <= 0) {
        throw new Error("Saved file is invalid");
      }

      const ext = path.extname(finalName).toLowerCase();
      const mediaType = detectMediaType(req.file.mimetype || "", ext);

      return res.json({
        success: true,
        url: `${PUBLIC_BASE_URL}/media/${encodeURIComponent(finalName)}`,
        service: "local-media",
        type: mediaType,
        mimeType: req.file.mimetype || null,
        size: stat.size,
        filename: finalName,
        permanent: true,
      });
    } catch (error) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlink(req.file.path, () => {});
      }

      return res.status(500).json({
        success: false,
        error: error.message || "Upload failed",
      });
    }
  });
});

module.exports = router;
