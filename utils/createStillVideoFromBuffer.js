const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const { uploadVideo } = require("./uploadFilegarden");

const pipelineAsync = promisify(pipeline);

const OUTPUT_FPS = 25;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";

const COMMAND_LOG_TAIL_CHARS = 20000;

const TEMP_DIR = path.join(__dirname, "..", "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true,
  });
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
    console.warn(`[still-video] cleanup failed: ${error.message}`);
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

    function appendTail(current, chunk) {
      const next = current + chunk.toString();

      return next.length > COMMAND_LOG_TAIL_CHARS
        ? next.slice(-COMMAND_LOG_TAIL_CHARS)
        : next;
    }

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
        resolve({
          stdout,
          stderr,
        });

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

/*
 * =========================================================
 * DOWNLOAD AUDIO
 * =========================================================
 */

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

/*
 * =========================================================
 * CREATE VIDEO
 * =========================================================
 */

async function createStillImageVideo({
  imagePath,
  audioPath,
  outputPath,
  seconds,
}) {
  const command = [
    "ffmpeg -y",

    /*
     * Ảnh tĩnh.
     */
    `-loop 1 -framerate ${OUTPUT_FPS} -i ${q(imagePath)}`,

    /*
     * Audio/video audio source.
     *
     * Nếu source ngắn hơn duration
     * thì lặp lại.
     */
    `-stream_loop -1 -i ${q(audioPath)}`,

    /*
     * Duration.
     */
    `-t ${Number(seconds).toFixed(3)}`,

    /*
     * Story image đã 1080x1920.
     *
     * Giữ nguyên ratio.
     *
     * Nếu input lớn hơn 1920 thì mới resize.
     */
    `-vf "scale='if(gt(max(iw,ih),1920),if(gte(iw,ih),1920,-2),trunc(iw/2)*2)':'if(gt(max(iw,ih),1920),if(gte(iw,ih),-2,1920),trunc(ih/2)*2)':flags=lanczos,setsar=1,format=yuv420p"`,

    /*
     * H264.
     */
    `-c:v libx264`,

    `-preset ${OUTPUT_PRESET}`,

    `-crf ${OUTPUT_CRF}`,

    `-r ${OUTPUT_FPS}`,

    `-threads 2`,

    /*
     * Chỉ lấy audio từ input thứ 2.
     *
     * Input 0 = image
     * Input 1 = audio source.
     */
    `-map 0:v:0`,

    `-map 1:a:0`,

    /*
     * Audio.
     */
    `-c:a aac`,

    `-b:a 128k`,

    /*
     * MP4 web optimize.
     */
    `-movflags +faststart`,

    q(outputPath),
  ].join(" ");

  await runCommand(command, "story-image-to-video");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Không tạo được file video");
  }

  return outputPath;
}

/*
 * =========================================================
 * PUBLIC FUNCTION
 * =========================================================
 */

async function createStillVideoFromBuffer({
  imageBuffer,
  audioUrl,
  seconds = 15,
}) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error("imageBuffer must be a Buffer");
  }

  if (typeof audioUrl !== "string" || !audioUrl.trim()) {
    throw new Error("audioUrl is required");
  }

  const duration = Number(seconds);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("seconds must be a positive number");
  }

  const requestId = `story_video_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const tempDir = path.join(TEMP_DIR, requestId);

  /*
   * Ảnh chỉ tồn tại tạm cho FFmpeg.
   */
  const imagePath = path.join(tempDir, "story.jpg");

  /*
   * Source audio của bạn đang là MP4,
   * nên dùng extension .mp4.
   */
  const audioPath = path.join(tempDir, "audio.mp4");

  const outputPath = path.join(tempDir, "final.mp4");

  fs.mkdirSync(tempDir, {
    recursive: true,
  });

  const totalStart = performance.now();

  try {
    /*
     * =====================================================
     * WRITE IMAGE BUFFER
     * =====================================================
     */

    const imageWriteStart = performance.now();

    await fs.promises.writeFile(imagePath, imageBuffer);

    const imageWriteMs = performance.now() - imageWriteStart;

    /*
     * =====================================================
     * DOWNLOAD AUDIO
     * =====================================================
     */

    const audioStart = performance.now();

    await downloadFile(audioUrl.trim(), audioPath);

    const audioDownloadMs = performance.now() - audioStart;

    /*
     * =====================================================
     * FFMPEG
     * =====================================================
     */

    const ffmpegStart = performance.now();

    await createStillImageVideo({
      imagePath,
      audioPath,
      outputPath,
      seconds: duration,
    });

    const ffmpegMs = performance.now() - ffmpegStart;

    /*
     * =====================================================
     * UPLOAD VIDEO
     * =====================================================
     */

    const uploadStart = performance.now();

    const fileName = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}.mp4`;

    const uploadResult = await uploadVideo(outputPath, fileName);

    const uploadMs = performance.now() - uploadStart;

    if (!uploadResult?.url) {
      throw new Error("Upload video failed");
    }

    const totalMs = performance.now() - totalStart;

    console.log("[story-video]", {
      imageWrite: `${Math.round(imageWriteMs)}ms`,

      audioDownload: `${Math.round(audioDownloadMs)}ms`,

      ffmpeg: `${Math.round(ffmpegMs)}ms`,

      upload: `${Math.round(uploadMs)}ms`,

      total: `${Math.round(totalMs)}ms`,
    });

    return {
      url: uploadResult.url,

      service: uploadResult.service || null,

      permanent: uploadResult.permanent || false,

      duration: Number(duration.toFixed(2)),

      performance: {
        imageWriteMs: Math.round(imageWriteMs),

        audioDownloadMs: Math.round(audioDownloadMs),

        ffmpegMs: Math.round(ffmpegMs),

        uploadMs: Math.round(uploadMs),

        totalMs: Math.round(totalMs),
      },
    };
  } finally {
    /*
     * Xóa:
     *
     * story.jpg
     * audio.mp4
     * final.mp4
     */
    cleanupTempDir(tempDir);
  }
}

module.exports = {
  createStillVideoFromBuffer,

  OUTPUT_FPS,
  OUTPUT_CRF,
  OUTPUT_PRESET,
};
