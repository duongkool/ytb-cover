const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RETENTION_DIR = path.join(__dirname, "..", "data", "media-retention");

function getMetadataPath(filename) {
  const key = crypto.createHash("sha256").update(filename).digest("hex");
  return path.join(RETENTION_DIR, `${key}.json`);
}

async function setRetentionDays(filename, days) {
  await fs.promises.mkdir(RETENTION_DIR, { recursive: true });

  const metadataPath = getMetadataPath(filename);
  const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;

  await fs.promises.writeFile(
    tempPath,
    JSON.stringify({ filename, retentionDays: days }),
    "utf8",
  );
  await fs.promises.rename(tempPath, metadataPath);
}

async function getRetentionDays(filename, fallbackDays) {
  try {
    const raw = await fs.promises.readFile(getMetadataPath(filename), "utf8");
    const metadata = JSON.parse(raw);

    if (
      metadata.filename === filename &&
      Number.isInteger(metadata.retentionDays) &&
      metadata.retentionDays > 0
    ) {
      return metadata.retentionDays;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(
        `⚠️ Cannot read retention metadata for ${filename}: ${error.message}`,
      );
    }
  }

  return fallbackDays;
}

async function removeRetentionMetadata(filename) {
  try {
    await fs.promises.unlink(getMetadataPath(filename));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(
        `⚠️ Cannot remove retention metadata for ${filename}: ${error.message}`,
      );
    }
  }
}

module.exports = {
  getRetentionDays,
  removeRetentionMetadata,
  setRetentionDays,
};
