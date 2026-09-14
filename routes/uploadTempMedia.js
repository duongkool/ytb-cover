// routes/uploadTempMedia.js
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const {
  detectTempMediaType,
  isAllowedTempMedia,
  uploadTempMedia,
} = require("../utils/uploadTempVideo");

const router = express.Router();

const TEMP_UPLOAD_DIR = path.join(__dirname, "..", "temp", "uploads");

if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
  fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });
}

function sanitizeTempFilename(filename) {
  const safeName = path
    .basename(filename || "upload")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "");

  return `${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}_${safeName || "upload"}`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, TEMP_UPLOAD_DIR);
  },

  filename: (_req, file, cb) => {
    cb(null, sanitizeTempFilename(file.originalname));
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB
    files: 1,
  },

  fileFilter: (_req, file, cb) => {
    const mediaType = detectTempMediaType({
      mimetype: file.mimetype,
      filename: file.originalname,
    });

    if (mediaType !== "unknown" && isAllowedTempMedia(file)) {
      return cb(null, true);
    }

    return cb(new Error("Only video, image, and audio files are allowed"));
  },
});

router.post("/", (req, res) => {
  upload.single("file")(req, res, async (uploadError) => {
    let tempPath = null;

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

      const mediaType = detectTempMediaType({
        mimetype: req.file.mimetype,
        filename: req.file.originalname,
      });

      if (mediaType === "unknown") {
        return res.status(400).json({
          success: false,
          error: "Unsupported file type",
        });
      }

      const requestedName =
        req.body.filename ||
        req.file.originalname ||
        `${mediaType}_${Date.now()}`;

      const uploadResult = await uploadTempMedia(tempPath, requestedName, {
        mediaType,
        mimeType: req.file.mimetype,
      });

      return res.json(uploadResult);
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
});

module.exports = router;
