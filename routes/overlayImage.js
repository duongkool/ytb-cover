const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { promisify } = require("util");
const { exec, spawn } = require("child_process");
const { EventEmitter } = require("events");
const { pipeline } = require("stream");

const { uploadVideo } = require("../utils/uploadMedianet");

const execAsync = promisify(exec);
const pipelineAsync = promisify(pipeline);
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

// ─── Tunables ─────────────────────────────────────────────────────────────────
const OUTPUT_FPS = 25;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";
const TRANSITION_DURATION = 0.5;
const COMMAND_LOG_TAIL_CHARS = 20000;

// ─── Helpers: Job ─────────────────────────────────────────────────────────────
function generateJobId() {
  return `bg_image_audio_opt_${Date.now()}_${Math.random()
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

// ─── Helpers: Media / Command ────────────────────────────────────────────────
async function runCommand(cmd, label) {
  console.log(`\n================ ${label} ================`);
  console.log(cmd);
  console.log("==========================================\n");

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    const appendTail = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > COMMAND_LOG_TAIL_CHARS
        ? next.slice(next.length - COMMAND_LOG_TAIL_CHARS)
        : next;
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });

    child.on("error", (err) => {
      console.error(`[${label}] failed`);
      console.error(`[${label}] message:`, err.message);
      reject(new Error(`[${label}] ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        if (stdout.trim()) console.log(`[${label}] stdout tail:\n${stdout}`);
        if (stderr.trim()) console.log(`[${label}] stderr tail:\n${stderr}`);
        resolve({ stdout, stderr });
        return;
      }

      console.error(`[${label}] failed with exit code ${code}`);
      if (stdout.trim()) console.error(`[${label}] stdout tail:\n${stdout}`);
      if (stderr.trim()) console.error(`[${label}] stderr tail:\n${stderr}`);
      reject(new Error(`[${label}] ${stderr || `exit code ${code}`}`));
    });
  });
}

function q(p) {
  return `"${p}"`;
}

async function downloadFile(url, destPath) {
  const res = await axios.get(url, {
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

  await pipelineAsync(res.data, fs.createWriteStream(destPath));
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
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x ${q(filePath)}`,
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
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${q(filePath)}`,
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

function buildRoundedMaskExpression(radius) {
  return `if(gt(abs(W/2-X),W/2-${radius})*gt(abs(H/2-Y),H/2-${radius}),if(lte(hypot(${radius}-(W/2-abs(W/2-X)),${radius}-(H/2-abs(H/2-Y))),${radius}),255,0),255)`;
}

function buildRoundedAlpha(radius) {
  return `geq=lum='p(X,Y)':a='${buildRoundedMaskExpression(radius)}'`;
}

function buildRoundedLumaMask(radius) {
  return `geq=lum='${buildRoundedMaskExpression(radius)}'`;
}

async function renderRoundedImage({
  inputPath,
  outputPath,
  width,
  radius,
}) {
  const filter = [
    `scale=${makeEven(width)}:-2:flags=bicubic`,
    `format=yuva420p`,
    buildRoundedAlpha(radius),
    `format=rgba`,
  ].join(",");

  const cmd = [
    `ffmpeg -y`,
    `-i ${q(inputPath)}`,
    `-vf "${filter}"`,
    `-frames:v 1 ${q(outputPath)}`,
  ].join(" ");

  await runCommand(cmd, "render-rounded-image");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to render rounded image");
  }

  return outputPath;
}

async function renderRoundedMask({
  outputPath,
  width,
  height,
  radius,
}) {
  const filter = [`format=gray`, buildRoundedLumaMask(radius)].join(",");
  const cmd = [
    `ffmpeg -y`,
    `-f lavfi -i color=white:s=${makeEven(width)}x${makeEven(height)}:d=0.04`,
    `-vf "${filter}"`,
    `-frames:v 1 ${q(outputPath)}`,
  ].join(" ");

  await runCommand(cmd, "render-rounded-mask");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to render rounded mask");
  }

  return outputPath;
}

function getEffectiveTransitionDuration(slideSeconds) {
  const duration = Math.max(0.1, Number(slideSeconds) || 0.1);
  return Math.min(
    TRANSITION_DURATION,
    Math.max(0.01, duration / 3),
    Math.max(0.01, duration - 0.01),
  );
}

function getSlideStepSeconds(slideSeconds, transitionDuration) {
  return Math.max(0.05, Number(slideSeconds) - Number(transitionDuration));
}

function estimateTimelineSlideCount(seconds, slideSeconds, transitionDuration) {
  const stepSeconds = getSlideStepSeconds(slideSeconds, transitionDuration);
  return Math.max(2, Math.ceil(Number(seconds) / stepSeconds) + 2);
}

function buildLoopableCycleSlides(slideImagePaths) {
  return [...slideImagePaths, slideImagePaths[0]];
}

function buildXfadeScriptFile(
  filePath,
  totalSlides,
  slotW,
  slotH,
  fps,
  transitionDuration,
  slideSeconds,
  outputSeconds,
) {
  const parts = [];

  for (let i = 0; i < totalSlides; i += 1) {
    parts.push(
      `[${i}:v]scale=${slotW}:${slotH}:force_original_aspect_ratio=decrease:flags=bicubic,` +
        `pad=${slotW}:${slotH}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `trim=duration=${Number(slideSeconds).toFixed(3)},` +
        `setpts=PTS-STARTPTS,fps=${fps},settb=AVTB,setsar=1,format=yuv420p[v${i}]`,
    );
  }

  let prev = "[v0]";
  for (let i = 1; i < totalSlides; i += 1) {
    const offset = (slideSeconds * i - transitionDuration * i).toFixed(3);
    const label = i === totalSlides - 1 ? "[vout_pre]" : `[vx${i}]`;
    parts.push(
      `${prev}[v${i}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset},fps=${fps},settb=AVTB${label}`,
    );
    prev = label;
  }

  parts.push(
    `[vout_pre]trim=duration=${outputSeconds.toFixed(3)},setpts=PTS-STARTPTS[vout]`,
  );

  fs.writeFileSync(filePath, parts.join(";\n"), "utf8");
}

// ─── Render: single image mode ───────────────────────────────────────────────
async function composeImageOnBackground({
  backgroundVideoPath,
  imagePath,
  audioPath,
  outputPath,
  seconds,
  canvasW,
  canvasH,
  tempDir,
}) {
  const marginX = 10;
  const marginTop = 10;
  const targetW = canvasW - marginX * 2;
  const cornerRadius = 24;
  const roundedImagePath = path.join(tempDir, "rounded-image.png");

  await renderRoundedImage({
    inputPath: imagePath,
    outputPath: roundedImagePath,
    width: targetW,
    radius: cornerRadius,
  });

  const filter = [
    `[0:v]fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),setsar=1,format=yuv420p[bg]`,
    `[1:v]fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),format=rgba[fg]`,
    `[bg][fg]overlay=${marginX}:${marginTop}:format=auto,fps=${OUTPUT_FPS},format=yuv420p,setpts=N/(${OUTPUT_FPS}*TB)[v]`,
  ].join(";");

  const cmd = [
    `ffmpeg -y`,
    `-stream_loop -1 -i ${q(backgroundVideoPath)}`,
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(roundedImagePath)}`,
    `-stream_loop -1 -i ${q(audioPath)}`,
    `-filter_complex "${filter}"`,
    `-map "[v]" -map 2:a:0`,
    `-t ${Number(seconds).toFixed(3)}`,
    `-c:v libx264 -preset ${OUTPUT_PRESET} -crf ${OUTPUT_CRF} -pix_fmt yuv420p -r ${OUTPUT_FPS}`,
    `-c:a aac -b:a 128k`,
    `-movflags +faststart ${q(outputPath)}`,
  ].join(" ");

  await runCommand(cmd, "compose-image-on-background");

  if (!fs.existsSync(outputPath)) {
    throw new Error("composeImageOnBackground failed");
  }

  return outputPath;
}

// ─── Step 1: build slideshow video safely ────────────────────────────────────
async function buildSlideVideo({
  slideImagePaths,
  slideSeconds,
  seconds,
  slotW,
  slotH,
  tempDir,
  outputPath,
}) {
  const normalizedSlideSeconds = Number(slideSeconds) || 4;
  const transitionDuration =
    getEffectiveTransitionDuration(normalizedSlideSeconds);
  const cycleSlides = buildLoopableCycleSlides(slideImagePaths);
  const stepSeconds = getSlideStepSeconds(
    normalizedSlideSeconds,
    transitionDuration,
  );
  const cycleDuration =
    slideImagePaths.length * stepSeconds + transitionDuration;

  const scriptPath = path.join(tempDir, "slides_xfade.txt");
  buildXfadeScriptFile(
    scriptPath,
    cycleSlides.length,
    slotW,
    slotH,
    OUTPUT_FPS,
    transitionDuration,
    normalizedSlideSeconds,
    cycleDuration,
  );

  const inputArgs = cycleSlides
    .map(
      (p) =>
        `-framerate ${OUTPUT_FPS} -loop 1 -t ${normalizedSlideSeconds.toFixed(
          3,
        )} -i ${q(p)}`,
    )
    .join(" ");
  const cmd = [
    `ffmpeg -y ${inputArgs}`,
    `-filter_complex_script ${q(scriptPath)}`,
    `-map "[vout]"`,
    `-c:v libx264 -preset ${OUTPUT_PRESET} -crf ${OUTPUT_CRF} -pix_fmt yuv420p -r ${OUTPUT_FPS}`,
    `-an -movflags +faststart ${q(outputPath)}`,
  ].join(" ");

  await runCommand(cmd, "build-loopable-slide-video");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to build slideshow video");
  }

  return {
    outputPath,
    expandedSlideCount: estimateTimelineSlideCount(
      seconds,
      normalizedSlideSeconds,
      transitionDuration,
    ),
    renderedSlideCount: cycleSlides.length,
    slideCycleSeconds: Number(cycleDuration.toFixed(3)),
    transitionDuration: Number(transitionDuration.toFixed(3)),
  };
}

// ─── Step 2: overlay slideshow on background ─────────────────────────────────
async function composeSlideOnBackgroundOptimized({
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
  tempDir,
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

  const slideVideoPath = path.join(tempDir, "slides.mp4");
  const roundedBasePath = path.join(tempDir, "rounded-base.png");
  const slideMaskPath = path.join(tempDir, "slide-mask.png");
  const [slideBuild] = await Promise.all([
    buildSlideVideo({
      slideImagePaths,
      slideSeconds: Number(slideSeconds) || 4,
      seconds: Number(seconds),
      slotW,
      slotH,
      tempDir,
      outputPath: slideVideoPath,
    }),
    renderRoundedImage({
      inputPath: overlayImagePath,
      outputPath: roundedBasePath,
      width: targetW,
      radius: cornerRadius,
    }),
    renderRoundedMask({
      outputPath: slideMaskPath,
      width: slotW,
      height: slotH,
      radius: cornerRadius,
    }),
  ]);
  const {
    expandedSlideCount,
    renderedSlideCount,
    slideCycleSeconds,
    transitionDuration,
  } = slideBuild;

  const filter = [
    `[0:v]fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),setsar=1,format=yuv420p[bg]`,
    `[1:v]fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),format=rgba[base]`,
    `[2:v]fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),setsar=1,format=rgb24[slidesrgb]`,
    `[3:v]fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),format=gray,setsar=1[slidemask]`,
    `[slidesrgb][slidemask]alphamerge,format=yuva420p[slides]`,
    `[bg][base]overlay=${marginX}:${marginTop}:format=auto[basev]`,
    `[basev][slides]overlay=${slotX}:${slotY}:format=auto,fps=${OUTPUT_FPS},format=yuv420p,setpts=N/(${OUTPUT_FPS}*TB)[v]`,
  ].join(";");

  const cmd = [
    `ffmpeg -y`,
    `-stream_loop -1 -i ${q(backgroundVideoPath)}`,
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(roundedBasePath)}`,
    `-stream_loop -1 -i ${q(slideVideoPath)}`,
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(slideMaskPath)}`,
    `-stream_loop -1 -i ${q(audioPath)}`,
    `-filter_complex "${filter}"`,
    `-map "[v]" -map 4:a:0`,
    `-t ${Number(seconds).toFixed(3)}`,
    `-c:v libx264 -preset ${OUTPUT_PRESET} -crf ${OUTPUT_CRF} -pix_fmt yuv420p -r ${OUTPUT_FPS}`,
    `-c:a aac -b:a 128k`,
    `-movflags +faststart ${q(outputPath)}`,
  ].join(" ");

  await runCommand(cmd, "compose-slide-on-background-optimized");

  if (!fs.existsSync(outputPath)) {
    throw new Error("composeSlideOnBackgroundOptimized failed");
  }

  return {
    outputPath,
    expandedSlideCount,
    renderedSlideCount,
    slideCycleSeconds,
    transitionDuration,
  };
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
      message: "Đang tải file đầu vào...",
    });

    const mainDownloads = [
      downloadFile(imageUrl, imagePath),
      downloadFile(audioUrl, audioPath),
    ];

    if (backgroundUrl) {
      mainDownloads.push(downloadFile(backgroundUrl, downloadedBgPath));
    }

    await Promise.all(mainDownloads);

    let validSlideImagePaths = [];

    if (requestedSlideMode) {
      onProgress({
        progress: 20,
        step: "download-slides",
        message: `Đang tải ${slideImageUrls.length} ảnh slide...`,
      });

      const slideResults = await Promise.all(
        slideImageUrls.map((url, index) =>
          tryDownloadFile(url, slideImagePaths[index]),
        ),
      );

      for (let i = 0; i < slideResults.length; i += 1) {
        if (slideResults[i]) {
          validSlideImagePaths.push(slideImagePaths[i]);
        }
      }
    }

    const isSlideMode = requestedSlideMode && validSlideImagePaths.length > 1;
    const fallbackToSingleImage =
      requestedSlideMode && validSlideImagePaths.length <= 1;

    let effectiveSeconds = Number(seconds);

    if (fullAudio) {
      onProgress({
        progress: 30,
        step: "probe-audio",
        message: "Đang lấy thời lượng audio...",
      });
      effectiveSeconds = await getMediaDuration(audioPath);
    }

    const backgroundVideoPath = backgroundUrl
      ? downloadedBgPath
      : BG_VIDEO_FILE;

    onProgress({
      progress: 38,
      step: "probe",
      message: "Đang phân tích video nền...",
    });

    const { width: canvasW, height: canvasH } =
      await getVideoDimensions(backgroundVideoPath);

    let expandedSlideCount = 0;
    let renderedSlideCount = 0;
    let slideCycleSeconds = null;
    let transitionDuration = null;

    onProgress({
      progress: 55,
      step: "render",
      message: isSlideMode
        ? "Đang render slideshow và ghép nền..."
        : fallbackToSingleImage
          ? "Một số ảnh slide lỗi, fallback sang ảnh tĩnh..."
          : "Đang render video...",
    });

    if (isSlideMode) {
      const slideResult = await composeSlideOnBackgroundOptimized({
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
        tempDir,
      });
      expandedSlideCount = slideResult.expandedSlideCount || 0;
      renderedSlideCount = slideResult.renderedSlideCount || 0;
      slideCycleSeconds = slideResult.slideCycleSeconds || null;
      transitionDuration = slideResult.transitionDuration || null;
    } else {
      await composeImageOnBackground({
        backgroundVideoPath,
        imagePath,
        audioPath,
        outputPath: finalPath,
        seconds: effectiveSeconds,
        canvasW,
        canvasH,
        tempDir,
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
          ? "background video + overlay image + loopable slideshow video + external audio"
          : "background video + full overlay image + external audio",
        slideCount: isSlideMode ? validSlideImagePaths.length : 0,
        slideSeconds: isSlideMode ? Number(slideSeconds) : null,
        fallbackToSingleImage,
        requestedSlideCount: slideImageUrls.length,
        validSlideCount: validSlideImagePaths.length,
        expandedSlideCount,
        renderedSlideCount,
        slideCycleSeconds,
        transitionDuration,
        optimized: true,
        fps: OUTPUT_FPS,
        crf: OUTPUT_CRF,
        preset: OUTPUT_PRESET,
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
  console.log(`║ 🎬 BG IMAGE AUDIO OPT Job: ${job.id}`);
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
  console.log(`║ ⚙️  FPS/CRF: ${OUTPUT_FPS}/${OUTPUT_CRF}`);
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
