// utils/videoCleanup.js
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const VIDEO_DIR = path.join(__dirname, "..", "public", "videos");
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

async function cleanupOldVideos() {
  try {
    if (!fs.existsSync(VIDEO_DIR)) {
      console.log("📂 Video dir not found, skip cleanup");
      return;
    }

    const files = await fs.promises.readdir(VIDEO_DIR);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      if (!file.toLowerCase().endsWith(".mp4")) continue;

      const fullPath = path.join(VIDEO_DIR, file);

      let stat;
      try {
        stat = await fs.promises.stat(fullPath);
      } catch (err) {
        console.warn(`⚠️ Cannot stat file ${file}: ${err.message}`);
        continue;
      }

      if (!stat.isFile()) continue;

      const ageMs = now - stat.mtimeMs;

      if (ageMs >= MAX_AGE_MS) {
        try {
          await fs.promises.unlink(fullPath);
          deletedCount += 1;
          console.log(`🗑️ Deleted old video: ${file}`);
        } catch (err) {
          console.warn(`⚠️ Cannot delete ${file}: ${err.message}`);
        }
      }
    }

    console.log(`🧹 Cleanup done. Deleted ${deletedCount} old video(s).`);
  } catch (error) {
    console.error("❌ cleanupOldVideos failed:", error.message);
  }
}

function startVideoCleanupJob() {
  cron.schedule(
    "0 6 * * *",
    async () => {
      console.log("🕕 Running daily video cleanup at 06:00 Asia/Ho_Chi_Minh");
      await cleanupOldVideos();
    },
    {
      timezone: "Asia/Ho_Chi_Minh",
    },
  );

  console.log("✅ Video cleanup cron scheduled at 06:00 daily");
}

module.exports = {
  cleanupOldVideos,
  startVideoCleanupJob,
};
