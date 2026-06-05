const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { promisify } = require("util");
const { exec } = require("child_process");
const { EventEmitter } = require("events");

const { uploadVideo } = require("../utils/uploadMedianet");

const execAsync = promisify(exec);
const router = express.Router();

// ─── Job store ────────────────────────────────────────────────────────────────
const jobs = new Map();
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(1000);

const JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Paths ────────────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(__dirname, "..", "temp");
const BG_VIDEO_FILE = path.join(__dirname, "..", "us.mp4");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Helpers: Job ─────────────────────────────────────────────────────────────
function generateJobId() {
  return `bg_image_audio_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function setJob(jobId, patch) {
  const current = jobs.get(jobId) || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  jobs.set(jobId, next);
  jobEvents.emit(`job:${jobId}`, next);
  return next;
}

function createJob(payload) {
  const jobId = generateJobId();
  const now = new Date().toISOString();

  const job = {
    id: jobId,
    status: "queued",
    progress: 0,
    step: "queued",
    message: "Job đã được tạo, đang chờ xử lý",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    payload: {
      imageUrl: payload.imageUrl,
      audioUrl: payload.audioUrl,
      seconds: payload.seconds,
    },
    result: null,
    error: null,
  };

  jobs.set(jobId, job);
  return job;
}

function sanitizeError(error) {
  return error?.message || "Unknown error";
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

function cleanupExpiredJobs() {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    const ts = new Date(job.updatedAt || job.createdAt).getTime();
    if (now - ts > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}
setInterval(cleanupExpiredJobs, 60 * 60 * 1000).unref();

// ─── Helpers: Command / Media ────────────────────────────────────────────────
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

// ─── Core process ────────────────────────────────────────────────────────────
async function processVideo(jobId, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const { imageUrl, audioUrl, seconds } = job.payload;

  const tempDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    if (!fs.existsSync(BG_VIDEO_FILE)) {
      throw new Error("Missing background video: us.mp4");
    }

    const imagePath = path.join(tempDir, "image.jpg");
    const audioPath = path.join(tempDir, "audio.mp3");
    const finalPath = path.join(tempDir, "final.mp4");

    onProgress({
      progress: 10,
      step: "download",
      message: "Đang tải ảnh đầu vào...",
    });
    await downloadFile(imageUrl, imagePath);

    onProgress({
      progress: 25,
      step: "download",
      message: "Đang tải audio...",
    });
    await downloadFile(audioUrl, audioPath);

    onProgress({
      progress: 40,
      step: "probe",
      message: "Đang phân tích video nền...",
    });
    const { width: canvasW, height: canvasH } =
      await getVideoDimensions(BG_VIDEO_FILE);

    onProgress({
      progress: 65,
      step: "render",
      message: "Đang render video...",
    });
    await composeImageOnBackground({
      backgroundVideoPath: BG_VIDEO_FILE,
      imagePath,
      audioPath,
      outputPath: finalPath,
      seconds: Number(seconds),
      canvasW,
      canvasH,
    });

    onProgress({
      progress: 88,
      step: "upload",
      message: "Đang upload video...",
    });
    const uploadResult = await uploadVideo(
      finalPath,
      `bg_image_audio_${jobId}.mp4`,
    );

    if (!uploadResult?.url) {
      throw new Error("Upload failed");
    }

    onProgress({
      progress: 98,
      step: "cleanup",
      message: "Đang dọn file tạm...",
    });
    cleanupTempDir(tempDir);

    onProgress({
      progress: 100,
      step: "done",
      message: "Hoàn thành!",
    });

    return {
      success: true,
      url: uploadResult.url,
      service: uploadResult.service,
      permanent: uploadResult.permanent || false,
      metadata: {
        duration: Number(Number(seconds).toFixed(2)),
        resolution: `${canvasW}x${canvasH}`,
        layout: "background video + full overlay image + looped external audio",
      },
    };
  } catch (error) {
    cleanupTempDir(tempDir);
    throw error;
  }
}

// ─── Background job runner ───────────────────────────────────────────────────
async function runJob(jobId) {
  const job = getJob(jobId);
  if (!job) return;

  try {
    setJob(jobId, {
      status: "processing",
      progress: 3,
      step: "starting",
      message: "Bắt đầu xử lý video",
      startedAt: new Date().toISOString(),
      error: null,
    });

    const result = await processVideo(jobId, ({ progress, step, message }) => {
      setJob(jobId, {
        status: "processing",
        progress,
        step,
        message,
      });
    });

    setJob(jobId, {
      status: "done",
      progress: 100,
      step: "done",
      message: "Xử lý thành công",
      result,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error.message);
    setJob(jobId, {
      status: "failed",
      step: "failed",
      message: "Xử lý thất bại",
      error: sanitizeError(error),
      finishedAt: new Date().toISOString(),
    });
  }
}

// ─── POST / — tạo job mới ────────────────────────────────────────────────────
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

  const job = createJob({
    imageUrl,
    audioUrl,
    seconds: duration,
  });

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║ 🎬 BG IMAGE AUDIO Job: ${job.id}`);
  console.log(`║ 🖼️  Image: ${imageUrl.substring(0, 60)}`);
  console.log(`║ 🎵 Audio: ${audioUrl.substring(0, 60)}`);
  console.log(`║ ⏱️  Seconds: ${duration}`);
  console.log(`╚══════════════════════════════════════════════════════╝`);

  res.status(202).json({
    success: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    message: job.message,
    pollUrl: `/api/overlay-image/${job.id}`,
    eventsUrl: `/api/overlay-image/${job.id}/events`,
  });

  setImmediate(() => {
    runJob(job.id).catch((err) => {
      console.error(`❌ Background runJob error (${job.id}):`, err.message);
      setJob(job.id, {
        status: "failed",
        step: "failed",
        message: "Background job crashed",
        error: sanitizeError(err),
        finishedAt: new Date().toISOString(),
      });
    });
  });
});

// ─── GET /:jobId — poll trạng thái ───────────────────────────────────────────
router.get("/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job not found",
    });
  }

  return res.json({
    success: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    result: job.status === "done" ? job.result : null,
  });
});

// ─── DELETE /:jobId — xóa job ────────────────────────────────────────────────
router.delete("/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job not found",
    });
  }

  jobs.delete(req.params.jobId);
  return res.json({
    success: true,
    message: "Job deleted",
  });
});

// ─── GET /:jobId/events — SSE realtime ───────────────────────────────────────
router.get("/:jobId/events", (req, res) => {
  const jobId = req.params.jobId;
  const job = getJob(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job not found",
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    message: job.message,
    error: job.error,
    result: job.status === "done" ? job.result : null,
  });

  const listener = (updatedJob) => {
    send({
      jobId: updatedJob.id,
      status: updatedJob.status,
      progress: updatedJob.progress,
      step: updatedJob.step,
      message: updatedJob.message,
      error: updatedJob.error,
      result: updatedJob.status === "done" ? updatedJob.result : null,
    });

    if (updatedJob.status === "done" || updatedJob.status === "failed") {
      clearInterval(heartbeat);
      jobEvents.off(`job:${jobId}`, listener);
      res.end();
    }
  };

  jobEvents.on(`job:${jobId}`, listener);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    jobEvents.off(`job:${jobId}`, listener);
  });
});

module.exports = router;
module.exports.jobs = jobs;
