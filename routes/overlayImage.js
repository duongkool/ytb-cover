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

const JOB_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Paths ────────────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(__dirname, "..", "temp");
const BG_VIDEO_FILE = path.join(__dirname, "..", "us.mp4");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Helpers: Job ─────────────────────────────────────────────────────────────
function generateJobId() {
  return `bg_image_audio_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
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
      mode: payload.mode || "single",
      imageUrl: payload.imageUrl,
      slideImageUrls: payload.slideImageUrls || [],
      slideSeconds: payload.slideSeconds || null,
      slideLayout: payload.slideLayout || null,
      audioUrl: payload.audioUrl,
      backgroundUrl: payload.backgroundUrl || null,
      seconds: payload.seconds,
      fullAudio: Boolean(payload.fullAudio),
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
      shell: true,
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
    validateStatus: (status) => status >= 200 && status < 300,
  });

  fs.writeFileSync(destPath, res.data);
  return destPath;
}

async function tryDownloadFile(url, destPath) {
  try {
    await downloadFile(url, destPath);
    return true;
  } catch (error) {
    console.warn(`⚠️ Download failed: ${url}`);
    console.warn(`⚠️ Reason: ${error.message}`);
    return false;
  }
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

async function getMediaDuration(filePath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
    { maxBuffer: 20 * 1024 * 1024 },
  );

  const duration = Number(String(stdout).trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Cannot get media duration: ${filePath}`);
  }

  return duration;
}

function makeEven(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
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

  const cmd = `ffmpeg -y -stream_loop -1 -i "${backgroundVideoPath}" -loop 1 -i "${imagePath}" -stream_loop -1 -i "${audioPath}" -filter_complex "${filter}" -map "[v]" -map 2:a:0 -t ${seconds} -c:v libx264 -preset medium -crf 21 -c:a aac -b:a 128k -pix_fmt yuv420p -shortest "${outputPath}"`;

  await runCommand(cmd, "compose-image-on-background");

  if (!fs.existsSync(outputPath)) {
    throw new Error("composeImageOnBackground failed");
  }

  return outputPath;
}

async function composeSlideOnBackground({
  backgroundVideoPath,
  overlayImagePath,
  slideImagePaths,
  audioPath,
  outputPath,
  seconds,
  slideSeconds,
  slideLayout,
  canvasW,
  canvasH,
}) {
  const marginX = 10;
  const marginTop = 10;
  const targetW = canvasW - marginX * 2;
  const cornerRadius = 24;

  const sourceW = Number(slideLayout?.sourceWidth) || 1440;
  const imageX = Number(slideLayout?.imageX) || 0;
  const imageY = Number(slideLayout?.imageY) || 0;
  const imageW = Number(slideLayout?.imageWidth) || 1440;
  const imageH = Number(slideLayout?.imageHeight) || 840;

  const scaleRatio = targetW / sourceW;
  const slotX = marginX + Math.round(imageX * scaleRatio);
  const slotY = marginTop + Math.round(imageY * scaleRatio);
  const slotW = makeEven(imageW * scaleRatio);
  const slotH = makeEven(imageH * scaleRatio);

  const fps = 30;
  const transitionDuration = 0.5;
  const normalizedSlideSeconds = Math.max(
    transitionDuration + 0.2,
    Number(slideSeconds) || 4,
  );

  const totalSlides = slideImagePaths.length;
  const slideVideoPath = path.join(path.dirname(outputPath), "slides.mp4");

  const roundedAlpha = (radius) =>
    `geq=lum='p(X,Y)':a='if(gt(abs(W/2-X),W/2-${radius})*gt(abs(H/2-Y),H/2-${radius}),if(lte(hypot(${radius}-(W/2-abs(W/2-X)),${radius}-(H/2-abs(H/2-Y))),${radius}),255,0),255)'`;

  const slideInputs = slideImagePaths
    .map(
      (slidePath) => `-loop 1 -t ${normalizedSlideSeconds} -i "${slidePath}"`,
    )
    .join(" ");

  const slideFilters = [];

  for (let i = 0; i < totalSlides; i += 1) {
    const outLabel = i === 0 ? "v0src" : `v${i}`;
    slideFilters.push(
      `[${i}:v]trim=duration=${normalizedSlideSeconds},setpts=PTS-STARTPTS,scale=${slotW}:${slotH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${slotW}:${slotH}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},setsar=1,format=yuv420p[${outLabel}]`,
    );
  }

  slideFilters.push(`[v0src]split=2[v0][v0loop]`);

  let lastLabel = "v0";
  let currentOffset = normalizedSlideSeconds - transitionDuration;

  for (let i = 1; i < totalSlides; i += 1) {
    const outLabel = `xf${i}`;
    slideFilters.push(
      `[${lastLabel}][v${i}]xfade=transition=fade:duration=${transitionDuration}:offset=${currentOffset}[${outLabel}]`,
    );
    lastLabel = outLabel;
    currentOffset += normalizedSlideSeconds - transitionDuration;
  }

  slideFilters.push(
    `[${lastLabel}][v0loop]xfade=transition=fade:duration=${transitionDuration}:offset=${currentOffset}[slidesloop]`,
  );

  slideFilters.push(
    `[slidesloop]trim=duration=${seconds},setpts=PTS-STARTPTS[slidesout]`,
  );

  const slideFilter = slideFilters.join(";");

  const slideCmd = `ffmpeg -y ${slideInputs} -filter_complex "${slideFilter}" -map "[slidesout]" -r ${fps} -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "${slideVideoPath}"`;

  await runCommand(slideCmd, "build-slide-video");

  if (!fs.existsSync(slideVideoPath)) {
    throw new Error("Failed to build slideshow video");
  }

  const finalFilter = [
    `[0:v]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH}[bg]`,
    `[1:v]scale=${targetW}:-2,format=yuva420p,${roundedAlpha(cornerRadius)}[base]`,
    `[2:v]scale=${slotW}:${slotH},setsar=1,format=yuva420p,${roundedAlpha(cornerRadius)}[slides]`,
    `[bg][base]overlay=${marginX}:${marginTop}:format=auto[basev]`,
    `[basev][slides]overlay=${slotX}:${slotY}:format=auto[v]`,
  ].join(";");

  const finalCmd = `ffmpeg -y -stream_loop -1 -i "${backgroundVideoPath}" -loop 1 -i "${overlayImagePath}" -stream_loop -1 -i "${slideVideoPath}" -stream_loop -1 -i "${audioPath}" -filter_complex "${finalFilter}" -map "[v]" -map 3:a:0 -t ${seconds} -c:v libx264 -preset medium -crf 21 -c:a aac -b:a 128k -pix_fmt yuv420p -shortest "${outputPath}"`;

  await runCommand(finalCmd, "compose-slide-on-background");

  if (!fs.existsSync(outputPath)) {
    throw new Error("composeSlideOnBackground failed");
  }

  return outputPath;
}

// ─── Core process ────────────────────────────────────────────────────────────
async function processVideo(jobId, onProgress = () => {}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found");
  }

  const {
    mode,
    imageUrl,
    slideImageUrls = [],
    slideSeconds,
    slideLayout,
    audioUrl,
    backgroundUrl,
    seconds,
    fullAudio,
  } = job.payload;

  const requestedSlideMode = mode === "slide" && slideImageUrls.length > 1;

  const tempDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    if (!backgroundUrl && !fs.existsSync(BG_VIDEO_FILE)) {
      throw new Error("Missing background video: us.mp4");
    }

    const imagePath = path.join(tempDir, "image.jpg");
    const audioPath = path.join(tempDir, "audio.mp3");
    const downloadedBgPath = path.join(tempDir, "background.mp4");
    const finalPath = path.join(tempDir, "final.mp4");
    const slideImagePaths = slideImageUrls.map((_, index) =>
      path.join(tempDir, `slide-${index}.jpg`),
    );

    onProgress({
      progress: 10,
      step: "download",
      message: "Đang tải ảnh đầu vào...",
    });
    await downloadFile(imageUrl, imagePath);

    let validSlideImagePaths = [];
    let validSlideImageUrls = [];

    if (requestedSlideMode) {
      for (let index = 0; index < slideImageUrls.length; index += 1) {
        onProgress({
          progress: 12 + Math.round(((index + 1) / slideImageUrls.length) * 8),
          step: "download-slides",
          message: `Đang tải ảnh slide ${index + 1}/${slideImageUrls.length}...`,
        });

        const ok = await tryDownloadFile(
          slideImageUrls[index],
          slideImagePaths[index],
        );

        if (ok) {
          validSlideImagePaths.push(slideImagePaths[index]);
          validSlideImageUrls.push(slideImageUrls[index]);
        }
      }
    }

    const isSlideMode = requestedSlideMode && validSlideImagePaths.length > 1;
    const fallbackToSingleImage =
      requestedSlideMode && validSlideImagePaths.length <= 1;

    onProgress({
      progress: 22,
      step: "download",
      message: "Đang tải audio...",
    });
    await downloadFile(audioUrl, audioPath);

    let effectiveSeconds = Number(seconds);

    if (fullAudio) {
      onProgress({
        progress: 28,
        step: "probe-audio",
        message: "Đang lấy thời lượng audio...",
      });

      effectiveSeconds = await getMediaDuration(audioPath);
    }

    let backgroundVideoPath = BG_VIDEO_FILE;

    if (backgroundUrl) {
      onProgress({
        progress: 34,
        step: "download",
        message: "Đang tải background video...",
      });
      await downloadFile(backgroundUrl, downloadedBgPath);
      backgroundVideoPath = downloadedBgPath;
    }

    onProgress({
      progress: 45,
      step: "probe",
      message: "Đang phân tích video nền...",
    });
    const { width: canvasW, height: canvasH } =
      await getVideoDimensions(backgroundVideoPath);

    onProgress({
      progress: 65,
      step: "render",
      message: isSlideMode
        ? "Đang render video slide..."
        : fallbackToSingleImage
          ? "Một số ảnh slide lỗi, đang fallback sang ảnh tĩnh..."
          : "Đang render video...",
    });

    if (isSlideMode) {
      await composeSlideOnBackground({
        backgroundVideoPath,
        overlayImagePath: imagePath,
        slideImagePaths: validSlideImagePaths,
        audioPath,
        outputPath: finalPath,
        seconds: effectiveSeconds,
        slideSeconds,
        slideLayout,
        canvasW,
        canvasH,
      });
    } else {
      await composeImageOnBackground({
        backgroundVideoPath,
        imagePath,
        audioPath,
        outputPath: finalPath,
        seconds: effectiveSeconds,
        canvasW,
        canvasH,
      });
    }

    onProgress({
      progress: 88,
      step: "upload",
      message: "Đang upload video...",
    });
    const shortName = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}.mp4`;

    const uploadResult = await uploadVideo(finalPath, shortName);

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
        duration: Number(effectiveSeconds.toFixed(2)),
        requestedDuration: Number(Number(seconds || 0).toFixed(2)),
        fullAudio: Boolean(fullAudio),
        resolution: `${canvasW}x${canvasH}`,
        backgroundSource: backgroundUrl ? "remote_url" : "default_local",
        layout: isSlideMode
          ? "background video + overlay text image + fade slideshow + external audio"
          : "background video + full overlay image + looped external audio",
        slideCount: isSlideMode ? validSlideImagePaths.length : 0,
        slideSeconds: isSlideMode ? Number(slideSeconds) : null,
        fallbackToSingleImage,
        requestedSlideCount: slideImageUrls.length,
        validSlideCount: validSlideImagePaths.length,
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
  const {
    imageUrl,
    audioUrl,
    backgroundUrl,
    seconds,
    mode,
    slideImageUrls,
    slideSeconds,
    slideLayout,
    fullAudio,
  } = req.body || {};

  const normalizedSlideImageUrls = Array.isArray(slideImageUrls)
    ? slideImageUrls
        .filter((url) => typeof url === "string" && url.trim())
        .map((url) => url.trim())
    : [];

  const isSlideMode = mode === "slide" || normalizedSlideImageUrls.length > 1;
  const useFullAudio = Boolean(fullAudio);

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

  if (isSlideMode && normalizedSlideImageUrls.length < 2) {
    return res.status(400).json({
      success: false,
      error: "slideImageUrls must contain at least 2 image URLs",
    });
  }

  const normalizedSlideSeconds = Number(slideSeconds || 4);
  if (
    isSlideMode &&
    (!Number.isFinite(normalizedSlideSeconds) || normalizedSlideSeconds <= 0)
  ) {
    return res.status(400).json({
      success: false,
      error: "slideSeconds must be a positive number",
    });
  }

  if (backgroundUrl != null && typeof backgroundUrl !== "string") {
    return res.status(400).json({
      success: false,
      error: "backgroundUrl must be a string",
    });
  }

  const duration = Number(seconds);
  if (!useFullAudio && (!Number.isFinite(duration) || duration <= 0)) {
    return res.status(400).json({
      success: false,
      error: "seconds must be a positive number when fullAudio is false",
    });
  }

  const job = createJob({
    mode: isSlideMode ? "slide" : "single",
    imageUrl,
    slideImageUrls: normalizedSlideImageUrls,
    slideSeconds: isSlideMode ? normalizedSlideSeconds : null,
    slideLayout: slideLayout || null,
    audioUrl,
    backgroundUrl,
    seconds: useFullAudio ? null : duration,
    fullAudio: useFullAudio,
  });

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║ 🎬 BG IMAGE AUDIO Job: ${job.id}`);
  console.log(`║ 🧩 Mode: ${isSlideMode ? "SLIDE" : "SINGLE"}`);
  console.log(`║ 🖼️  Image: ${imageUrl.substring(0, 60)}`);
  if (isSlideMode) {
    console.log(`║ 🖼️  Slides: ${normalizedSlideImageUrls.length}`);
    console.log(`║ ⏭️  Slide seconds: ${normalizedSlideSeconds}`);
  }
  console.log(`║ 🎵 Audio: ${audioUrl.substring(0, 60)}`);
  console.log(
    `║ 🎞️  Background: ${(backgroundUrl || "DEFAULT_LOCAL_BG").substring(0, 60)}`,
  );
  console.log(`║ ⏱️  Seconds: ${useFullAudio ? "AUTO_FROM_AUDIO" : duration}`);
  console.log(`║ 🎧 Full audio: ${useFullAudio}`);
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
