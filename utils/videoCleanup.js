// utils/videoCleanup.js
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const MEDIA_DIR = path.join(__dirname, "..", "public", "videos");

// Xóa file sau 5 ngày
const MAX_AGE_DAYS = 5;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

// Các định dạng media được phép xóa
const ALLOWED_EXTENSIONS = new Set([
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
]);

function isAllowedMediaFile(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

async function cleanupOldMedia() {
  try {
    if (!fs.existsSync(MEDIA_DIR)) {
      console.log("📂 Media directory not found, skipping cleanup");
      return {
        success: true,
        scanned: 0,
        deleted: 0,
        skipped: 0,
        failed: 0,
      };
    }

    const entries = await fs.promises.readdir(MEDIA_DIR, {
      withFileTypes: true,
    });

    const now = Date.now();

    let scannedCount = 0;
    let deletedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const entry of entries) {
      // Bỏ qua thư mục con
      if (!entry.isFile()) {
        skippedCount += 1;
        continue;
      }

      const file = entry.name;

      // Chỉ xóa các định dạng video, ảnh và audio đã khai báo
      if (!isAllowedMediaFile(file)) {
        skippedCount += 1;
        continue;
      }

      scannedCount += 1;

      const fullPath = path.join(MEDIA_DIR, file);

      let stat;

      try {
        stat = await fs.promises.stat(fullPath);
      } catch (error) {
        failedCount += 1;
        console.warn(`⚠️ Cannot stat file ${file}: ${error.message}`);
        continue;
      }

      if (!stat.isFile()) {
        skippedCount += 1;
        continue;
      }

      const ageMs = now - stat.mtimeMs;

      if (ageMs < MAX_AGE_MS) {
        continue;
      }

      try {
        await fs.promises.unlink(fullPath);

        deletedCount += 1;

        const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

        console.log(`🗑️ Deleted old media: ${file} (${ageDays} day(s) old)`);
      } catch (error) {
        failedCount += 1;
        console.warn(`⚠️ Cannot delete ${file}: ${error.message}`);
      }
    }

    console.log(
      [
        "🧹 Media cleanup completed.",
        `Scanned: ${scannedCount}`,
        `Deleted: ${deletedCount}`,
        `Skipped: ${skippedCount}`,
        `Failed: ${failedCount}`,
      ].join(" "),
    );

    return {
      success: true,
      scanned: scannedCount,
      deleted: deletedCount,
      skipped: skippedCount,
      failed: failedCount,
    };
  } catch (error) {
    console.error("❌ cleanupOldMedia failed:", error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

function startVideoCleanupJob() {
  cron.schedule(
    "0 6 * * *",
    async () => {
      console.log("🕕 Running daily media cleanup at 06:00 Asia/Ho_Chi_Minh");

      await cleanupOldMedia();
    },
    {
      timezone: "Asia/Ho_Chi_Minh",
    },
  );

  console.log("✅ Media cleanup cron scheduled at 06:00 daily");
}

module.exports = {
  cleanupOldMedia,

  // Giữ alias cũ để code hiện tại không bị lỗi
  cleanupOldVideos: cleanupOldMedia,

  startVideoCleanupJob,
};
