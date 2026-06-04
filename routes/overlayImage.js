const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { promisify } = require("util");
const { exec } = require("child_process");

const { uploadVideo } = require("../utils/uploadMedianet");

const execAsync = promisify(exec);
const router = express.Router();

const TEMP_DIR = path.join(__dirname, "..", "temp");
const BG_VIDEO_FILE = path.join(__dirname, "..", "us.mp4");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function generateJobId() {
  return `bg_image_audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(`🗑️ Cleaned: ${tempDir}`);
    }
  } catch (err) {
    console.warn(`⚠️ Cleanup failed: ${err.message}`);
  }
}

async function runCommand(cmd, label) {
  console.log(`\n================ ${label} ================`);
  console.log(cmd);
  console.log("==========================================\n");

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      maxBuffer: 1024 * 1024 * 300,
    });

    if (stdout?.trim()) console.log(`[${label}] stdout:\n${stdout}`);
    if (stderr?.trim()) console.log(`[${label}] stderr:\n${stderr}`);

    return { stdout, stderr };
  } catch (err) {
    console.error(`❌ [${label}] failed`);
    console.error(`[${label}] message:`, err.message);
    if (err.stdout) console.error(`[${label}] stdout:\n${err.stdout}`);
    if (err.stderr) console.error(`[${label}] stderr:\n${err.stderr}`);
    throw new Error(`[${label}] ${err.stderr || err.message}`);
  }
}

async function downloadFile(url, destPath) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
  });

  fs.writeFileSync(destPath, res.data);
  return destPath;
}

async function getVideoDimensions(filePath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${filePath}"`,
    { maxBuffer: 20 * 1024 * 1024 },
  );

  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) {
    throw new Error(`Cannot get video dimensions: ${filePath}`);
  }

  return { width, height };
}

async function composeImageOnBackground({
  backgroundVideoPath,
  imagePath,
  audioPath,
  outputPath,
  seconds,
  canvasW,
  canvasH,
}) {
  const marginX = 10;
  const marginTop = 10;
  const targetW = canvasW - marginX * 2;

  const cornerRadius = 24;

  const filter = [
    `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH}[bg]`,
    `[1:v]scale=${targetW}:-2,format=yuva420p,geq=lum='p(X,Y)':a='if(gt(abs(W/2-X),W/2-${cornerRadius})*gt(abs(H/2-Y),H/2-${cornerRadius}),if(lte(hypot(${cornerRadius}-(W/2-abs(W/2-X)),${cornerRadius}-(H/2-abs(H/2-Y))),${cornerRadius}),255,0),255)'[fg]`,
    `[bg][fg]overlay=${marginX}:${marginTop}:format=auto[v]`,
  ].join(";");

  const cmd = `ffmpeg -y \
-stream_loop -1 -i "${backgroundVideoPath}" \
-loop 1 -i "${imagePath}" \
-stream_loop -1 -i "${audioPath}" \
-filter_complex "${filter}" \
-map "[v]" \
-map 2:a:0 \
-t ${seconds} \
-c:v libx264 \
-preset medium \
-crf 21 \
-c:a aac \
-b:a 128k \
-pix_fmt yuv420p \
-shortest \
"${outputPath}"`;

  await runCommand(cmd, "compose-image-on-background");

  if (!fs.existsSync(outputPath)) {
    throw new Error("composeImageOnBackground failed");
  }

  return outputPath;
}

router.post("/", async (req, res) => {
  const { imageUrl, audioUrl, seconds } = req.body || {};

  if (!imageUrl || typeof imageUrl !== "string") {
    return res.status(400).json({
      success: false,
      error: "imageUrl is required",
    });
  }

  if (!audioUrl || typeof audioUrl !== "string") {
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

  if (!fs.existsSync(BG_VIDEO_FILE)) {
    return res.status(500).json({
      success: false,
      error: "Missing background video: us.mp4",
    });
  }

  const jobId = generateJobId();
  const tempDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const imagePath = path.join(tempDir, "image.jpg");
    const audioPath = path.join(tempDir, "audio.mp3");
    const finalPath = path.join(tempDir, "final.mp4");

    await downloadFile(imageUrl, imagePath);
    await downloadFile(audioUrl, audioPath);

    const { width: canvasW, height: canvasH } =
      await getVideoDimensions(BG_VIDEO_FILE);

    await composeImageOnBackground({
      backgroundVideoPath: BG_VIDEO_FILE,
      imagePath,
      audioPath,
      outputPath: finalPath,
      seconds: duration,
      canvasW,
      canvasH,
    });

    const uploadResult = await uploadVideo(
      finalPath,
      `bg_image_audio_${jobId}.mp4`,
    );

    if (!uploadResult?.url) {
      throw new Error("Upload failed");
    }

    return res.json({
      success: true,
      jobId,
      url: uploadResult.url,
      service: uploadResult.service,
      permanent: uploadResult.permanent || false,
      metadata: {
        duration: Number(duration.toFixed(2)),
        resolution: `${canvasW}x${canvasH}`,
        layout: "background video + full overlay image + looped external audio",
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "Unknown error",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

module.exports = router;
