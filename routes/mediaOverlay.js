const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { promisify } = require("util");
const { exec, spawn } = require("child_process");
const { pipeline } = require("stream");

const { uploadVideo } = require("../utils/uploadMe");

const execAsync = promisify(exec);
const pipelineAsync = promisify(pipeline);
const router = express.Router();

const DEFAULT_W = 720;
const DEFAULT_H = 1280;
const OUTPUT_FPS = 30;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";
const DEFAULT_MIN_SECONDS = 14;
const DEFAULT_MAX_SECONDS = 16;
const COMMAND_LOG_TAIL_CHARS = 20000;
const TEMP_DIR = path.join(__dirname, "..", "temp");
const BG_VIDEO_FILE = path.join(__dirname, "..", "video1.mp4");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function generateJobId() {
  return `simple_media_overlay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampContent(text, maxChars = 500) {
  const clean = normalizeText(text);
  if (clean.length <= maxChars) return clean;

  const cutoff = maxChars - 3;
  if (cutoff <= 0) return "...";

  const slice = clean.slice(0, cutoff + 1);
  const lastSpace = slice.lastIndexOf(" ");

  if (lastSpace > 0) {
    return slice.slice(0, lastSpace).replace(/[ .,!?:;"'”-]+$/, "") + "...";
  }

  return clean.slice(0, cutoff).replace(/[ .,!?:;"'”-]+$/, "") + "...";
}

function wrapTextMobile(text, maxCharsPerLine = 44, maxLines = 13) {
  const clean = clampContent(text, 500);
  if (!clean) return [""];

  const words = clean.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;

    if (next.length <= maxCharsPerLine) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines - 1) break;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  const joined = lines.join(" ");
  if (clean.length > joined.length && lines.length > 0) {
    lines[lines.length - 1] =
      lines[lines.length - 1].replace(/[ .,!?:;"'”-]+$/, "") + "...";
  }

  return lines;
}

function q(filePath) {
  return `"${filePath}"`;
}

function makeEven(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
}

function getRandomDefaultSeconds() {
  return Number(
    (
      DEFAULT_MIN_SECONDS +
      Math.random() * (DEFAULT_MAX_SECONDS - DEFAULT_MIN_SECONDS)
    ).toFixed(2),
  );
}

function normalizeForTextfile(text) {
  return String(text || "")
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€˜â€™]/g, "'")
    .replace(/\r?\n/g, " ")
    .trim();
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function getFontPathEscaped() {
  return escapeFilterPath(
    path.join(__dirname, "..", "fonts", "DejaVuSans-Bold.ttf"),
  );
}

function buildStandardTextOverlayFilter(content, tempDir, prefix = "line") {
  const clippedContent = clampContent(content, 500);
  const lines = wrapTextMobile(clippedContent, 44, 13);

  const boxX = 28;
  const boxY = 610;
  const boxW = DEFAULT_W - 56;
  const boxH = 460;

  const textAreaW = 610;
  const textAreaX = boxX + Math.floor((boxW - textAreaW) / 2);

  const fontSize = 23;
  const lineHeight = 31;
  const topPadding = 24;
  const bottomPadding = 24;

  const totalTextH = lines.length * lineHeight;
  const availableH = boxH - topPadding - bottomPadding;
  const startY =
    boxY + topPadding + Math.max(0, Math.floor((availableH - totalTextH) / 2));

  const fontPathEscaped = getFontPathEscaped();
  const drawLines = lines.map((line, i) => {
    const y = startY + i * lineHeight;
    const txtPath = path.join(tempDir, `${prefix}_${i + 1}.txt`);
    fs.writeFileSync(txtPath, normalizeForTextfile(line), "utf8");
    const txtPathEscaped = escapeFilterPath(txtPath);

    return `drawtext=fontfile='${fontPathEscaped}':textfile='${txtPathEscaped}':reload=0:fontcolor=white:fontsize=${fontSize}:x=${textAreaX}:y=${y}:bordercolor=black:borderw=1.6`;
  });

  return {
    filter: [
      `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=black@0.72:t=fill`,
      ...drawLines,
    ].join(","),
    lines,
  };
}

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

async function downloadFile(url, destPath) {
  const res = await axios.get(url, {
    responseType: "stream",
    timeout: 30000,
    family: 4,
    maxRedirects: 5,
    maxBodyLength: Infinity,
  });
  await pipelineAsync(res.data, fs.createWriteStream(destPath));
  return destPath;
}

async function getImageDimensions(filePath) {
  const { stdout } = await execAsync(
    `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "${filePath}"`,
    { maxBuffer: 20 * 1024 * 1024 },
  );

  const [width, height] = stdout.trim().split("x").map(Number);
  if (!width || !height) {
    throw new Error(`Cannot get image dimensions: ${filePath}`);
  }
  return { width, height };
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

  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration)) {
    throw new Error(`Cannot get duration: ${filePath}`);
  }
  return duration;
}

async function createVideoFromImage(imagePath, outputPath, seconds) {
  const { width, height } = await getImageDimensions(imagePath);

  const WORK_W = DEFAULT_W * 2;
  const WORK_H = DEFAULT_H * 2;

  const scaleFactor = Math.max(WORK_W / width, WORK_H / height);
  const scaledW = Math.ceil(width * scaleFactor);
  const scaledH = Math.ceil(height * scaleFactor);

  const panRange = Math.max(scaledW - WORK_W, 0);
  const usablePan = Math.max(0, Math.floor(panRange * 0.35));
  const startX = Math.max(0, Math.floor((panRange - usablePan) / 2));

  const xExpr =
    usablePan > 0 ? `${startX}+(${usablePan})*(t/${seconds})*1.18` : "0";

  const vf = [
    `scale=${scaledW}:${scaledH}`,
    `crop=${WORK_W}:${WORK_H}:${xExpr}:0`,
    `scale=${DEFAULT_W}:${DEFAULT_H}`,
    `fps=60`,
    `format=yuv420p`,
  ].join(",");

  const cmd = `ffmpeg -y -loop 1 -framerate 60 -i "${imagePath}" -t ${seconds} -vf "${vf}" -an -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "${outputPath}"`;
  await runCommand(cmd, "create-video-from-image");

  if (!fs.existsSync(outputPath)) {
    throw new Error("createVideoFromImage failed");
  }

  return outputPath;
}

async function createVideoFromSourceVideo(videoPath, outputPath, seconds) {
  const vf = [
    `scale=${DEFAULT_W}:${DEFAULT_H}:force_original_aspect_ratio=increase`,
    `crop=${DEFAULT_W}:${DEFAULT_H}`,
    `fps=30`,
    `format=yuv420p`,
  ].join(",");

  const cmd = `ffmpeg -y -i "${videoPath}" -t ${seconds} -vf "${vf}" -an -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "${outputPath}"`;
  await runCommand(cmd, "create-video-from-source-video");

  if (!fs.existsSync(outputPath)) {
    throw new Error("createVideoFromSourceVideo failed");
  }

  return outputPath;
}

async function renderImageWithTextAndAudio({
  imagePath,
  audioPath,
  outputPath,
  content,
  seconds,
  tempDir,
}) {
  const { width, height } = await getImageDimensions(imagePath);
  const scaleFactor = Math.max(DEFAULT_W / width, DEFAULT_H / height);
  const scaledW = makeEven(Math.ceil(width * scaleFactor));
  const scaledH = makeEven(Math.ceil(height * scaleFactor));
  const panRange = Math.max(scaledW - DEFAULT_W, 0);
  const usablePan = Math.max(0, Math.floor(panRange * 0.35));
  const startX = Math.max(0, Math.floor((panRange - usablePan) / 2));
  const xExpr = usablePan > 0 ? `${startX}+(${usablePan})*(t/${seconds})` : "0";
  const { filter: textFilter } = buildStandardTextOverlayFilter(
    content,
    tempDir,
    "fast_line",
  );

  const filter = [
    `[0:v]scale=${scaledW}:${scaledH}:flags=fast_bilinear,` +
      `crop=${DEFAULT_W}:${DEFAULT_H}:${xExpr}:0,` +
      `fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),format=yuv420p,` +
      `${textFilter}[v]`,
  ].join(";");

  const filterFile = path.join(tempDir, "fast_image_filter.txt");
  fs.writeFileSync(filterFile, filter, "utf8");

  const cmd = [
    `ffmpeg -y`,
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(imagePath)}`,
    `-stream_loop -1 -i ${q(audioPath)}`,
    `-filter_complex_script ${q(filterFile)}`,
    `-map "[v]" -map 1:a:0`,
    `-t ${Number(seconds).toFixed(3)}`,
    `-c:v libx264 -preset ${OUTPUT_PRESET} -crf ${OUTPUT_CRF} -pix_fmt yuv420p -r ${OUTPUT_FPS}`,
    `-c:a aac -b:a 128k`,
    `-movflags +faststart ${q(outputPath)}`,
  ].join(" ");

  await runCommand(cmd, "render-image-text-audio-fast");

  if (!fs.existsSync(outputPath)) {
    throw new Error("renderImageWithTextAndAudio failed");
  }

  return outputPath;
}

async function renderVideoWithTextAndAudio({
  videoPath,
  audioPath,
  outputPath,
  content,
  seconds,
  tempDir,
}) {
  const { filter: textFilter } = buildStandardTextOverlayFilter(
    content,
    tempDir,
    "fast_video_line",
  );

  const filter = [
    `[0:v]scale=${DEFAULT_W}:${DEFAULT_H}:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
      `crop=${DEFAULT_W}:${DEFAULT_H},fps=${OUTPUT_FPS},` +
      `setpts=N/(${OUTPUT_FPS}*TB),format=yuv420p,${textFilter}[v]`,
  ].join(";");

  const filterFile = path.join(tempDir, "fast_video_filter.txt");
  fs.writeFileSync(filterFile, filter, "utf8");

  const cmd = [
    `ffmpeg -y`,
    `-stream_loop -1 -i ${q(videoPath)}`,
    `-stream_loop -1 -i ${q(audioPath)}`,
    `-filter_complex_script ${q(filterFile)}`,
    `-map "[v]" -map 1:a:0`,
    `-t ${Number(seconds).toFixed(3)}`,
    `-c:v libx264 -preset ${OUTPUT_PRESET} -crf ${OUTPUT_CRF} -pix_fmt yuv420p -r ${OUTPUT_FPS}`,
    `-c:a aac -b:a 128k`,
    `-movflags +faststart ${q(outputPath)}`,
  ].join(" ");

  await runCommand(cmd, "render-video-text-audio-fast");

  if (!fs.existsSync(outputPath)) {
    throw new Error("renderVideoWithTextAndAudio failed");
  }

  return outputPath;
}

async function addTextOverlay(inputPath, outputPath, content, tempDir) {
  const clippedContent = clampContent(content, 500);
  const lines = wrapTextMobile(clippedContent, 44, 13);

  const boxX = 28;
  const boxY = 610;
  const boxW = DEFAULT_W - 56;
  const boxH = 460;

  const textAreaW = 610;
  const textAreaX = boxX + Math.floor((boxW - textAreaW) / 2);

  const fontSize = 23;
  const lineHeight = 31;
  const topPadding = 24;
  const bottomPadding = 24;

  const totalTextH = lines.length * lineHeight;
  const availableH = boxH - topPadding - bottomPadding;
  const startY =
    boxY + topPadding + Math.max(0, Math.floor((availableH - totalTextH) / 2));

  const normalizeForTextfile = (text) =>
    String(text || "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\r?\n/g, " ")
      .trim();

  const escapeFilterPath = (filePath) =>
    filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

  const fontPathEscaped = escapeFilterPath(
    path.join(__dirname, "..", "fonts", "DejaVuSans-Bold.ttf"),
  );

  const drawLines = lines.map((line, i) => {
    const y = startY + i * lineHeight;
    const txtPath = path.join(tempDir, `line_${i + 1}.txt`);
    fs.writeFileSync(txtPath, normalizeForTextfile(line), "utf8");

    const txtPathEscaped = escapeFilterPath(txtPath);

    return `drawtext=fontfile='${fontPathEscaped}':textfile='${txtPathEscaped}':reload=0:fontcolor=white:fontsize=${fontSize}:x=${textAreaX}:y=${y}:bordercolor=black:borderw=1.6`;
  });

  const filter = [
    `drawbox=x=${boxX}:y=${boxY}:w=${boxW}:h=${boxH}:color=black@0.72:t=fill`,
    ...drawLines,
  ].join(",");

  const filterFile = path.join(tempDir, "overlay_filter.txt");
  fs.writeFileSync(filterFile, filter, "utf8");

  const cmd = `ffmpeg -y -i "${inputPath}" -filter_script:v "${filterFile}" -an -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p "${outputPath}"`;
  await runCommand(cmd, "add-text-overlay");

  if (!fs.existsSync(outputPath)) {
    throw new Error("addTextOverlay failed");
  }

  return outputPath;
}

async function createImageBackgroundLayout({
  imagePath,
  backgroundVideoPath,
  audioPath,
  outputPath,
  content,
  seconds,
  tempDir,
  canvasW,
  canvasH,
}) {
  const clippedContent = clampContent(content, 800);
  const lines = wrapTextMobile(clippedContent, 40, 12);

  const IMAGE_TOP_Y = 0;
  const IMAGE_MAX_H = Math.round(canvasH * 0.42);
  const OVERLAP_DOWN = Math.max(14, Math.round(canvasH * 0.016));

  const actualImageBottomY = IMAGE_TOP_Y + IMAGE_MAX_H;
  const textBoxY =
    actualImageBottomY - OVERLAP_DOWN + Math.round(canvasH * 0.01);

  const textBoxX = Math.round(canvasW * 0.05);
  const textBoxW = canvasW - textBoxX * 2;

  const fontSize = Math.max(16, Math.round(canvasW * 0.034));
  const lineHeight = Math.round(fontSize * 1.42);

  const topPadding = Math.max(22, Math.round(canvasH * 0.026));
  const bottomPadding = Math.max(26, Math.round(canvasH * 0.032));
  const sidePadding = Math.max(18, Math.round(canvasW * 0.04));
  const extraSafety = Math.max(18, Math.round(fontSize * 0.8));

  const totalTextH = lines.length * lineHeight;

  const textBoxH = Math.max(
    Math.round(canvasH * 0.19),
    Math.min(
      Math.round(canvasH * 0.41),
      totalTextH + topPadding + bottomPadding + extraSafety,
    ),
  );

  const textAreaW = textBoxW - sidePadding * 2;
  const textAreaX = textBoxX + sidePadding;

  const startY =
    textBoxY +
    topPadding +
    Math.max(
      0,
      Math.floor((textBoxH - topPadding - bottomPadding - totalTextH) / 2),
    );

  const normalizeForTextfile = (text) =>
    String(text || "")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\r?\n/g, " ")
      .trim();

  const escapeFilterPath = (filePath) =>
    filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

  const fontPathEscaped = escapeFilterPath(
    path.join(__dirname, "..", "fonts", "DejaVuSans-Bold.ttf"),
  );

  const drawLines = lines.map((line, i) => {
    const y = startY + i * lineHeight;
    const txtPath = path.join(tempDir, `bg_line_${i + 1}.txt`);
    fs.writeFileSync(txtPath, normalizeForTextfile(line), "utf8");
    const txtPathEscaped = escapeFilterPath(txtPath);

    return `drawtext=fontfile='${fontPathEscaped}':textfile='${txtPathEscaped}':reload=0:fontcolor=white:fontsize=${fontSize}:x=${textAreaX}:y=${y}:bordercolor=black:borderw=1.7`;
  });

  const filter = [
    `[0:v]fps=${OUTPUT_FPS},setpts=N/(${OUTPUT_FPS}*TB),setsar=1,format=yuv420p[bg]`,
    `[1:v]scale=${canvasW}:-2:flags=fast_bilinear[imgscaled]`,
    `[imgscaled]crop=${canvasW}:'min(ih,${IMAGE_MAX_H})':0:'max((ih-${IMAGE_MAX_H})/2,0)'[imgcropped]`,
    `[bg][imgcropped]overlay=0:${IMAGE_TOP_Y}[base1]`,
    `[base1]drawbox=x=${textBoxX}:y=${textBoxY}:w=${textBoxW}:h=${textBoxH}:color=black@0.72:t=fill[base2]`,
    `[base2]${drawLines.join(",")},fps=${OUTPUT_FPS},format=yuv420p,setpts=N/(${OUTPUT_FPS}*TB)[v]`,
  ].join(";");

  const filterFile = path.join(tempDir, "bg_layout_filter.txt");
  fs.writeFileSync(filterFile, filter, "utf8");

  const cmd = [
    `ffmpeg -y`,
    `-stream_loop -1 -i ${q(backgroundVideoPath)}`,
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(imagePath)}`,
    `-stream_loop -1 -i ${q(audioPath)}`,
    `-filter_complex_script ${q(filterFile)}`,
    `-map "[v]" -map 2:a:0`,
    `-t ${Number(seconds).toFixed(3)}`,
    `-c:v libx264 -preset ${OUTPUT_PRESET} -crf ${OUTPUT_CRF} -pix_fmt yuv420p -r ${OUTPUT_FPS}`,
    `-c:a aac -b:a 128k`,
    `-movflags +faststart ${q(outputPath)}`,
  ].join(" ");
  await runCommand(cmd, "create-image-background-layout");

  if (!fs.existsSync(outputPath)) {
    throw new Error("createImageBackgroundLayout failed");
  }

  return outputPath;
}

async function muxWithAudio(videoPath, audioPath, outputPath, seconds) {
  const cmd = `ffmpeg -y -stream_loop -1 -i "${audioPath}" -i "${videoPath}" -map 1:v:0 -map 0:a:0 -t ${seconds} -c:v copy -c:a aac -b:a 128k "${outputPath}"`;
  await runCommand(cmd, "mux-with-audio");

  if (!fs.existsSync(outputPath)) {
    throw new Error("muxWithAudio failed");
  }

  return outputPath;
}

router.post("/", async (req, res) => {
  const {
    url,
    content,
    second,
    type = "image",
    option,
    audioPath: customAudioPath,
  } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ success: false, error: "url is required" });
  }

  if (!content || typeof content !== "string" || content.trim().length < 10) {
    return res
      .status(400)
      .json({ success: false, error: "content is required (min 10 chars)" });
  }

  if (!["image", "video"].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'type must be "image" or "video"',
    });
  }

  const jobId = generateJobId();
  const tempDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(tempDir, { recursive: true });

  let outputW = DEFAULT_W;
  let outputH = DEFAULT_H;

  try {
    let seconds;
    let durationMode;

    if (
      second !== undefined &&
      second !== null &&
      String(second).trim() !== ""
    ) {
      seconds = Math.max(3, Number(second) || 10);
      durationMode = "request_second";
    } else {
      seconds = getRandomDefaultSeconds();
      durationMode = "random_default_14_16";
    }

    const sourcePath = path.join(
      tempDir,
      type === "video" ? "source.mp4" : "source.jpg",
    );
    const finalPath = path.join(tempDir, "final.mp4");

    await downloadFile(url, sourcePath);

    let audioToUse = customAudioPath;
    if (!audioToUse) {
      const audioCandidates = ["audio1.mp3", "audio2.mp3", "audio3.mp3"]
        .map((file) => path.join(__dirname, "..", file))
        .filter((filePath) => fs.existsSync(filePath));

      if (audioCandidates.length === 0) {
        throw new Error(
          "No fallback audio found. Expected one of: audio1.mp3, audio2.mp3, audio3.mp3",
        );
      }

      audioToUse =
        audioCandidates[Math.floor(Math.random() * audioCandidates.length)];

      console.log(
        `ðŸŽµ Random fallback audio selected: ${path.basename(audioToUse)}`,
      );
    }

    if (type === "video") {
      await renderVideoWithTextAndAudio({
        videoPath: sourcePath,
        audioPath: audioToUse,
        outputPath: finalPath,
        content,
        seconds,
        tempDir,
      });
      outputW = DEFAULT_W;
      outputH = DEFAULT_H;
    } else if (option === "background") {
      if (!fs.existsSync(BG_VIDEO_FILE)) {
        throw new Error("Missing background video: video1.mp4");
      }

      const { width: canvasW, height: canvasH } =
        await getVideoDimensions(BG_VIDEO_FILE);
      outputW = canvasW;
      outputH = canvasH;

      await createImageBackgroundLayout({
        imagePath: sourcePath,
        backgroundVideoPath: BG_VIDEO_FILE,
        audioPath: audioToUse,
        outputPath: finalPath,
        content,
        seconds,
        tempDir,
        canvasW,
        canvasH,
      });
    } else {
      await renderImageWithTextAndAudio({
        imagePath: sourcePath,
        audioPath: audioToUse,
        outputPath: finalPath,
        content,
        seconds,
        tempDir,
      });
      outputW = DEFAULT_W;
      outputH = DEFAULT_H;
    }

    if (false && !audioToUse) {
      const audioCandidates = ["audio1.mp3", "audio2.mp3", "audio3.mp3"]
        .map((file) => path.join(__dirname, "..", file))
        .filter((filePath) => fs.existsSync(filePath));

      if (audioCandidates.length === 0) {
        throw new Error(
          "No fallback audio found. Expected one of: audio1.mp3, audio2.mp3, audio3.mp3",
        );
      }

      audioToUse =
        audioCandidates[Math.floor(Math.random() * audioCandidates.length)];

      console.log(
        `🎵 Random fallback audio selected: ${path.basename(audioToUse)}`,
      );
    }

    const uploadResult = await uploadVideo(
      finalPath,
      `simple_media_overlay_${jobId}.mp4`,
    );

    if (!uploadResult?.url) {
      throw new Error("Upload failed");
    }

    const finalRenderedText = wrapTextMobile(content, 44, 13).join(" ");

    return res.json({
      success: true,
      jobId,
      url: uploadResult.url,
      service: uploadResult.service,
      permanent: uploadResult.permanent || false,
      metadata: {
        duration: Number(Number(seconds).toFixed(2)),
        durationMode,
        randomDurationRange:
          durationMode === "random_default_14_16"
            ? [DEFAULT_MIN_SECONDS, DEFAULT_MAX_SECONDS]
            : null,
        resolution: `${outputW}x${outputH}`,
        type,
        option: option || null,
        maxCharsInBox: 500,
        renderedChars: finalRenderedText.length,
        renderedLines: wrapTextMobile(content, 44, 13).length,
        layout:
          type === "video"
            ? "source video + portrait crop + bold text box + random looping audio"
            : option === "background"
              ? "original-size background video + top foreground image + dynamic text box + random looping audio"
              : "single image + bigger bold paragraph text + wider text area + slow horizontal pan + random looping audio",
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
