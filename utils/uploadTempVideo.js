const fs = require("fs");
const path = require("path");

const TEMP_VIDEO_DIR = path.join(__dirname, "..", "public", "temp-videos");

const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://video.xopboo.com"
).replace(/\/+$/, "");

if (!fs.existsSync(TEMP_VIDEO_DIR)) {
  fs.mkdirSync(TEMP_VIDEO_DIR, { recursive: true });
}

const MEDIA_EXTENSIONS = {
  video: [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"],
  image: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"],
};

const ALLOWED_EXTENSIONS = Object.values(MEDIA_EXTENSIONS).flat();

const ALLOWED_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
  "video/x-msvideo",
  "video/x-m4v",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
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
  "application/octet-stream",
];

function getFallbackExtension(mediaType) {
  if (mediaType === "image") return ".jpg";
  if (mediaType === "audio") return ".mp3";
  return ".mp4";
}

function getAllowedExtensions(mediaType) {
  return MEDIA_EXTENSIONS[mediaType] || ALLOWED_EXTENSIONS;
}

function detectTempMediaType({ mimetype, filename } = {}) {
  const mime = String(mimetype || "").toLowerCase();
  const ext = path.extname(filename || "").toLowerCase();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";

  if (MEDIA_EXTENSIONS.image.includes(ext)) return "image";
  if (MEDIA_EXTENSIONS.audio.includes(ext)) return "audio";
  if (MEDIA_EXTENSIONS.video.includes(ext)) return "video";

  return "unknown";
}

function isAllowedTempMedia(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(file?.originalname || "").toLowerCase();

  return ALLOWED_MIME_TYPES.includes(mime) || ALLOWED_EXTENSIONS.includes(ext);
}

function sanitizeFilename(filename, mediaType = "video") {
  const fallback = `${mediaType}_${Date.now()}${getFallbackExtension(
    mediaType,
  )}`;

  const raw = String(filename || fallback).trim();
  const originalExt = path.extname(raw).toLowerCase();
  const allowedExtensions = getAllowedExtensions(mediaType);
  const ext = allowedExtensions.includes(originalExt)
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

  if (!base) {
    return fallback;
  }

  return `${base}${ext}`;
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

async function uploadTempMedia(filePath, filename, options = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Temp media upload failed: source file not found");
  }

  const mediaType =
    options.mediaType ||
    detectTempMediaType({
      mimetype: options.mimeType,
      filename,
    });

  if (mediaType === "unknown") {
    throw new Error("Temp media upload failed: unsupported file type");
  }

  const safeName = sanitizeFilename(filename, mediaType);
  const finalName = await ensureUniqueFilename(safeName);

  const destPath = path.join(TEMP_VIDEO_DIR, finalName);

  await fs.promises.copyFile(filePath, destPath);

  const stat = await fs.promises.stat(destPath);

  if (!stat.isFile() || stat.size <= 0) {
    await fs.promises.unlink(destPath).catch(() => {});
    throw new Error("Temp media upload failed: saved file is invalid");
  }

  return {
    success: true,

    url: `${PUBLIC_BASE_URL}/temp-videos/${encodeURIComponent(finalName)}`,

    service: options.service || "local-vps-temp-media",

    type: mediaType,

    mimeType: options.mimeType || null,

    permanent: false,

    expiresAfterHours: 2,

    filename: finalName,

    path: destPath,

    size: stat.size,
  };
}

async function uploadVideo(filePath, filename) {
  return uploadTempMedia(filePath, filename, {
    mediaType: "video",
    service: "local-vps-temp",
  });
}

module.exports = {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  TEMP_VIDEO_DIR,
  detectTempMediaType,
  isAllowedTempMedia,
  uploadTempMedia,
  uploadVideo,
};
