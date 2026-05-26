const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { promisify } = require("util");
const { exec } = require("child_process");

const { uploadVideo } = require("../utils/uploadMe");

const execAsync = promisify(exec);
const router = express.Router();

const W = 720;
const H = 1280;
const TEMP_DIR = path.join(__dirname, "..", "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const FONT_FILE = path
  .join(__dirname, "..", "fonts", "DejaVuSans-Bold.ttf")
  .replace(/\\/g, "/")
  .replace(/^([A-Z]):/, (_, d) => `${d}\\:`);

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

function escapeDrawtext(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "’")
    .replace(/"/g, '\\"')
    .replace(/:/g, "\\\\:")
    .replace(/,/g, "\\\\,")
    .replace(/;/g, "\\\\;")
    .replace(/\[/g, "\\\\[")
    .replace(/\]/g, "\\\\]")
    .replace(/\(/g, "\\\\(")
    .replace(/\)/g, "\\\\)")
    .replace(/=/g, "\\\\=")
    .replace(/%/g, "\\\\%")
    .replace(/\n/g, " ");
}
function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampContent(text, maxChars = 500) {
  const clean = normalizeText(text);
  if (clean.length <= maxChars) return clean;
  return clean.slice(0, maxChars).replace(/[ .,!?:;"'”-]+$/, "") + "...";
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

  const WORK_W = W * 2;
  const WORK_H = H * 2;

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
    `scale=${W}:${H}`,
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
    `scale=${W}:${H}:force_original_aspect_ratio=increase`,
    `crop=${W}:${H}`,
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

async function addTextOverlay(inputPath, outputPath, content, tempDir) {
  const clippedContent = clampContent(content, 500);
  const lines = wrapTextMobile(clippedContent, 44, 13);

  const boxX = 28;
  const boxY = 610;
  const boxW = W - 56;
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
    second = 10,
    type = "image",
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

  const seconds = Math.max(3, Number(second) || 10);
  const jobId = generateJobId();
  const tempDir = path.join(TEMP_DIR, jobId);

  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const sourcePath = path.join(
      tempDir,
      type === "video" ? "source.mp4" : "source.jpg",
    );
    const baseVideoPath = path.join(tempDir, "base.mp4");
    const overlayVideoPath = path.join(tempDir, "overlay.mp4");
    const finalPath = path.join(tempDir, "final.mp4");

    await downloadFile(url, sourcePath);

    if (type === "video") {
      await createVideoFromSourceVideo(sourcePath, baseVideoPath, seconds);
    } else {
      await createVideoFromImage(sourcePath, baseVideoPath, seconds);
    }

    await addTextOverlay(baseVideoPath, overlayVideoPath, content, tempDir);

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
        `🎵 Random fallback audio selected: ${path.basename(audioToUse)}`,
      );
    }

    await muxWithAudio(overlayVideoPath, audioToUse, finalPath, seconds);

    const uploadResult = await uploadVideo(
      finalPath,
      `simple_media_overlay_${jobId}.mp4`,
    );

    if (!uploadResult?.url) {
      throw new Error("Upload failed");
    }

    cleanupTempDir(tempDir);

    const finalRenderedText = wrapTextMobile(content, 44, 13).join(" ");

    return res.json({
      success: true,
      jobId,
      url: uploadResult.url,
      service: uploadResult.service,
      permanent: uploadResult.permanent || false,
      metadata: {
        duration: seconds,
        resolution: `${W}x${H}`,
        type,
        maxCharsInBox: 500,
        renderedChars: finalRenderedText.length,
        renderedLines: wrapTextMobile(content, 44, 13).length,
        layout:
          type === "video"
            ? "source video + portrait crop + bold text box + random looping audio"
            : "single image + bigger bold paragraph text + wider text area + slow horizontal pan + random looping audio",
      },
    });
  } catch (error) {
    cleanupTempDir(tempDir);
    return res.status(500).json({
      success: false,
      error: error.message || "Unknown error",
    });
  }
});

module.exports = router;
