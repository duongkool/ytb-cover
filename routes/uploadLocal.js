// routes/uploadLocal.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const router = express.Router();

const TEMP_DIR = path.join(__dirname, "..", "temp", "uploads");
const MEDIA_DIR = path.join(__dirname, "..", "public", "videos");

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://video.xopboo.com"
).replace(/\/+$/, "");

for (const dir of [TEMP_DIR, MEDIA_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const ALLOWED_EXTENSIONS = [
  // Video
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".m4v",
  ".avi",

  // Image
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",

  // Audio
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".opus",
];

const ALLOWED_MIME_TYPES = [
  // Video
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "video/x-m4v",

  // Image
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",

  // Audio
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
  "audio/opus",

  // Một số client gửi MIME này
  "application/octet-stream",
];

function detectMediaType(file) {
  const mime = String(file.mimetype || "").toLowerCase();
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (mime.startsWith("image/")) {
    return "image";
  }

  if (mime.startsWith("audio/")) {
    return "audio";
  }

  if (mime.startsWith("video/")) {
    return "video";
  }

  if (
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"].includes(ext)
  ) {
    return "image";
  }

  if (
    [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"].includes(ext)
  ) {
    return "audio";
  }

  if ([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"].includes(ext)) {
    return "video";
  }

  return "unknown";
}

function getFallbackExtension(mediaType) {
  if (mediaType === "image") return ".jpg";
  if (mediaType === "audio") return ".mp3";
  return ".mp4";
}

function sanitizeFilename(filename, mediaType = "video") {
  const fallback = `${mediaType}_${Date.now()}${getFallbackExtension(
    mediaType,
  )}`;

  const raw = String(filename || fallback).trim();

  const originalExt = path.extname(raw).toLowerCase();
  const ext = ALLOWED_EXTENSIONS.includes(originalExt)
    ? originalExt
    : getFallbackExtension(mediaType);

  const base = path
    .basename(raw, originalExt)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "")
    .slice(0, 120);

  return `${base || `${mediaType}_${Date.now()}`}${ext}`;
}

async function ensureUniqueFilename(filename) {
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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, TEMP_DIR);
  },

  filename: (_req, file, cb) => {
    const originalName = path.basename(file.originalname || "upload");

    const safeTempName = originalName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    cb(
      null,
      `${Date.now()}_${Math.random().toString(36).slice(2, 10)}_${safeTempName}`,
    );
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB
    files: 1,
  },

  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    const ext = path.extname(file.originalname || "").toLowerCase();

    const validMime = ALLOWED_MIME_TYPES.includes(mime);
    const validExtension = ALLOWED_EXTENSIONS.includes(ext);

    if (validMime || validExtension) {
      return cb(null, true);
    }

    return cb(new Error("Only video, image, and audio files are allowed"));
  },
});

router.post("/", (req, res) => {
  upload.single("file")(req, res, async (uploadError) => {
    let tempPath = null;
    let destinationPath = null;

    try {
      if (uploadError) {
        if (uploadError instanceof multer.MulterError) {
          if (uploadError.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
              success: false,
              error: "File is too large. Maximum size is 2GB.",
            });
          }

          return res.status(400).json({
            success: false,
            error: uploadError.message,
            code: uploadError.code,
          });
        }

        return res.status(400).json({
          success: false,
          error: uploadError.message || "Invalid file",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "Missing file",
        });
      }

      tempPath = req.file.path;

      const mediaType = detectMediaType(req.file);

      if (mediaType === "unknown") {
        throw new Error("Unable to detect media type");
      }

      const requestedName =
        req.body.filename ||
        req.file.originalname ||
        `${mediaType}_${Date.now()}${getFallbackExtension(mediaType)}`;

      const safeName = sanitizeFilename(requestedName, mediaType);
      const finalName = await ensureUniqueFilename(safeName);

      destinationPath = path.join(MEDIA_DIR, finalName);

      try {
        await fs.promises.rename(tempPath, destinationPath);
        tempPath = null;
      } catch (renameError) {
        if (renameError.code !== "EXDEV") {
          throw renameError;
        }

        await fs.promises.copyFile(tempPath, destinationPath);
      }

      const stat = await fs.promises.stat(destinationPath);

      if (!stat.isFile() || stat.size <= 0) {
        throw new Error("Saved file is invalid");
      }

      return res.json({
        success: true,
        url: `${PUBLIC_BASE_URL}/videos/${encodeURIComponent(finalName)}`,
        service: "local-vps",
        type: mediaType,
        mimeType: req.file.mimetype,
        size: stat.size,
        filename: finalName,
        permanent: false,
        expiresAfterDays: 5,
      });
    } catch (error) {
      // Nếu đã tạo file đích nhưng quá trình kiểm tra thất bại thì xóa
      if (destinationPath && fs.existsSync(destinationPath)) {
        fs.unlink(destinationPath, () => {});
      }

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
});

module.exports = router;
