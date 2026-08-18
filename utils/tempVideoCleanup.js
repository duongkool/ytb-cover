const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const TEMP_VIDEO_DIR = path.join(__dirname, "..", "public", "temp-videos");

// Video tạm tồn tại tối đa 2 giờ
const MAX_AGE_HOURS = 2;

const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000;

async function cleanupTempVideos() {
  try {
    if (!fs.existsSync(TEMP_VIDEO_DIR)) {
      return {
        success: true,
        scanned: 0,
        deleted: 0,
        failed: 0,
      };
    }

    const entries = await fs.promises.readdir(TEMP_VIDEO_DIR, {
      withFileTypes: true,
    });

    const now = Date.now();

    let scanned = 0;
    let deleted = 0;
    let failed = 0;

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();

      // Chỉ xử lý video mp4
      if (ext !== ".mp4") {
        continue;
      }

      scanned += 1;

      const fullPath = path.join(TEMP_VIDEO_DIR, entry.name);

      try {
        const stat = await fs.promises.stat(fullPath);

        const ageMs = now - stat.mtimeMs;

        if (ageMs < MAX_AGE_MS) {
          continue;
        }

        await fs.promises.unlink(fullPath);

        deleted += 1;

        const ageMinutes = Math.floor(ageMs / (60 * 1000));

        console.log(
          `🗑️ Deleted temp video: ${entry.name} (${ageMinutes} minutes old)`,
        );
      } catch (error) {
        failed += 1;

        console.warn(
          `⚠️ Cannot cleanup temp video ${entry.name}: ${error.message}`,
        );
      }
    }

    if (deleted > 0) {
      console.log(
        `🧹 Temp video cleanup: scanned=${scanned}, deleted=${deleted}, failed=${failed}`,
      );
    }

    return {
      success: true,
      scanned,
      deleted,
      failed,
    };
  } catch (error) {
    console.error("❌ cleanupTempVideos failed:", error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

function startTempVideoCleanupJob() {
  // Quét mỗi 10 phút
  cron.schedule(
    "*/10 * * * *",
    async () => {
      await cleanupTempVideos();
    },
    {
      timezone: "Asia/Ho_Chi_Minh",
    },
  );

  console.log("✅ Temp video cleanup scheduled every 10 minutes");
}

module.exports = {
  cleanupTempVideos,
  startTempVideoCleanupJob,
};
