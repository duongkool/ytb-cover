const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const { uploadVideo } = require("../utils/uploadVps");

// UPLOAD TEST
// const { uploadVideo } = require("../utils/uploadService");

// UPLOAD TEMP
// const { uploadVideo } = require("../utils/uploadTempVideo");

const router = express.Router();
const pipelineAsync = promisify(pipeline);

const OUTPUT_FPS = 25;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";
const COMMAND_LOG_TAIL_CHARS = 20000;

const TEMP_DIR = path.join(__dirname, "..", "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function q(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
      });
    }
  } catch (error) {
    console.warn(`Cleanup failed: ${error.message}`);
  }
}

async function runCommand(command, label) {
  console.log(`\n================ ${label} ================`);
  console.log(command);
  console.log("==========================================\n");

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const appendTail = (current, chunk) => {
      const next = current + chunk.toString();

      return next.length > COMMAND_LOG_TAIL_CHARS
        ? next.slice(-COMMAND_LOG_TAIL_CHARS)
        : next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;

      reject(new Error(`[${label}] ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `[${label}] ${stderr.trim() || `Process exited with code ${code}`}`,
        ),
      );
    });
  });
}

async function downloadFile(url, destinationPath) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 30000,
    family: 4,
    maxRedirects: 5,
    maxBodyLength: Infinity,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  await pipelineAsync(response.data, fs.createWriteStream(destinationPath));

  return destinationPath;
}

async function createStillImageVideo({
  imagePath,
  audioPath,
  outputPath,
  seconds,
}) {
  const command = [
    "ffmpeg -y",

    // Ảnh tĩnh được lặp liên tục.
    `-loop 1 -framerate ${OUTPUT_FPS} -i ${q(imagePath)}`,

    // Audio được lặp nếu ngắn hơn thời lượng yêu cầu.
    `-stream_loop -1 -i ${q(audioPath)}`,

    `-t ${Number(seconds).toFixed(3)}`,

    // Giữ nguyên tỷ lệ ảnh, không crop, không pad.
    // Chỉ giảm kích thước nếu cạnh lớn nhất vượt quá 1920 px.
    `-vf "scale='if(gt(max(iw,ih),1920),if(gte(iw,ih),1920,-2),trunc(iw/2)*2)':'if(gt(max(iw,ih),1920),if(gte(iw,ih),-2,1920),trunc(ih/2)*2)':flags=lanczos,setsar=1,format=yuv420p"`,

    `-c:v libx264`,
    `-preset ${OUTPUT_PRESET}`,
    `-crf ${OUTPUT_CRF}`,
    `-r ${OUTPUT_FPS}`,
    `-threads 2`,

    `-c:a aac`,
    `-b:a 128k`,

    // Dừng audio đúng theo thời lượng video.
    `-shortest`,

    `-movflags +faststart`,
    q(outputPath),
  ].join(" ");

  await runCommand(command, "create-still-image-video");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Không tạo được file video");
  }

  return outputPath;
}

/**
 * POST /api/image-to-video
 *
 * Body:
 * {
 *   "imageUrl": "https://example.com/image.jpg",
 *   "audioUrl": "https://example.com/audio.mp3",
 *   "seconds": 10
 * }
 */
router.post("/", async (req, res) => {
  const { imageUrl, audioUrl, seconds } = req.body || {};

  if (typeof imageUrl !== "string" || !imageUrl.trim()) {
    return res.status(400).json({
      success: false,
      error: "imageUrl is required",
    });
  }

  if (typeof audioUrl !== "string" || !audioUrl.trim()) {
    return res.status(400).json({
      success: false,
      error: "audioUrl is required",
    });
  }

  const duration = Number(seconds);

  if (!Number.isFinite(duration) || duration <= 0) {
    return res.status(400).json({
      success: false,
      error: "seconds must be a positive number",
    });
  }

  const requestId = `still_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const tempDir = path.join(TEMP_DIR, requestId);
  const imagePath = path.join(tempDir, "image");
  const audioPath = path.join(tempDir, "audio");
  const outputPath = path.join(tempDir, "final.mp4");

  fs.mkdirSync(tempDir, {
    recursive: true,
  });

  try {
    // Tải ảnh và audio song song.
    await Promise.all([
      downloadFile(imageUrl.trim(), imagePath),
      downloadFile(audioUrl.trim(), audioPath),
    ]);

    await createStillImageVideo({
      imagePath,
      audioPath,
      outputPath,
      seconds: duration,
    });

    const fileName = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}.mp4`;

    const uploadResult = await uploadVideo(outputPath, fileName);

    if (!uploadResult?.url) {
      throw new Error("Upload video failed");
    }

    return res.status(200).json({
      success: true,
      url: uploadResult.url,
      service: uploadResult.service || null,
      permanent: uploadResult.permanent || false,
      metadata: {
        duration: Number(duration.toFixed(2)),
        fps: OUTPUT_FPS,
        crf: OUTPUT_CRF,
        preset: OUTPUT_PRESET,
        layout: "still image + audio",
      },
    });
  } catch (error) {
    console.error(`Create still video failed (${requestId}):`, error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Create video failed",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

module.exports = router;
