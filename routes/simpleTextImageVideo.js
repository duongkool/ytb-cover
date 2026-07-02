const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { promisify } = require("util");
const { spawn, exec } = require("child_process");
const { pipeline } = require("stream");

const { uploadVideo } = require("../utils/uploadMe");

const router = express.Router();

const execAsync = promisify(exec);
const pipelineAsync = promisify(pipeline);

const DEFAULT_W = 752;
const DEFAULT_H = 1376;
const OUTPUT_FPS = 30;
const OUTPUT_CRF = 23;
const OUTPUT_PRESET = "superfast";

const DEFAULT_MIN_SECONDS = 14;
const DEFAULT_MAX_SECONDS = 20;

const TEMP_DIR = path.join(__dirname, "..", "temp");

const FONT_PATH = path
  .join(__dirname, "..", "fonts", "Anton-Regular.ttf")
  .replace(/\\/g, "/")
  .replace(/^([A-Z]):/, (_, d) => `${d}\\:`);

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function generateJobId() {
  return `simple_text_image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn("Cleanup failed:", err.message);
  }
}

function q(filePath) {
  return `"${filePath}"`;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForTextfile(text) {
  return String(text || "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\r?\n/g, " ")
    .trim();
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function isHexColor(value) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value || "").trim());
}

function safeColor(value, fallback) {
  return isHexColor(value) ? String(value).trim() : fallback;
}

function getRandomDefaultSeconds() {
  return Number(
    (
      DEFAULT_MIN_SECONDS +
      Math.random() * (DEFAULT_MAX_SECONDS - DEFAULT_MIN_SECONDS)
    ).toFixed(2),
  );
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

async function runCommand(cmd, label) {
  console.log(`\n================ ${label} ================`);
  console.log(cmd);
  console.log("==========================================\n");

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, {
      shell: true,
      windowsHide: true,
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 20000) {
        stderr = stderr.slice(stderr.length - 20000);
      }
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr || `Command failed with code ${code}`));
    });
  });
}

function wrapText(text, maxCharsPerLine = 27, maxLines = 11) {
  const clean = normalizeText(text);
  if (!clean) return [];

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

  const renderedText = lines.join(" ");
  if (clean.length > renderedText.length && lines.length > 0) {
    lines[lines.length - 1] =
      lines[lines.length - 1].replace(/[ .,!?:;"'”]+$/, "") + "...";
  }

  return lines;
}

function buildMainTextLines(content, maxLines = 20) {
  const lines = wrapText(content, 46, maxLines);

  return lines.map((line, index) => ({
    text: line,
    colorType: index % 5 === 1 || index % 5 === 2 ? "highlight" : "normal",
  }));
}

function buildTextOverlayFilter({
  content,
  footerText,
  tempDir,
  normalText,
  highlightText,
}) {
  const fontPathEscaped = FONT_PATH.replace(/'/g, "\\'");

  const mainLines = buildMainTextLines(content, 20);

  const fontSize = 32;
  const lineHeight = 52;

  const sideMargin = 36;

  // vùng hiển thị text chính
  const textAreaTop = 130;
  const textAreaBottom = footerText && normalizeText(footerText) ? 1040 : 1160;
  const textAreaH = textAreaBottom - textAreaTop;

  // căn giữa block chữ theo chiều dọc
  const totalTextH = mainLines.length * lineHeight;
  const textTopY =
    textAreaTop + Math.max(0, Math.floor((textAreaH - totalTextH) / 2));
  const drawFilters = [];

  mainLines.forEach((item, index) => {
    const txtPath = path.join(tempDir, `main_line_${index + 1}.txt`);
    fs.writeFileSync(txtPath, normalizeForTextfile(item.text), "utf8");

    const txtPathEscaped = escapeFilterPath(txtPath);
    const color = item.colorType === "highlight" ? highlightText : normalText;
    const y = textTopY + index * lineHeight;

    drawFilters.push(
      `drawtext=fontfile='${fontPathEscaped}':textfile='${txtPathEscaped}':reload=0:fontcolor=${color}:fontsize=${fontSize}:x=max(${sideMargin}\\,(w-text_w)/2):y=${y}:bordercolor=black:borderw=2.6:shadowcolor=black@0.5:shadowx=1:shadowy=2`,
    );
  });

  if (footerText && normalizeText(footerText)) {
    const footerPath = path.join(tempDir, "footer.txt");
    fs.writeFileSync(
      footerPath,
      normalizeForTextfile(normalizeText(footerText).toUpperCase()),
      "utf8",
    );

    const footerPathEscaped = escapeFilterPath(footerPath);

    drawFilters.push(
      `drawtext=fontfile='${fontPathEscaped}':textfile='${footerPathEscaped}':reload=0:fontcolor=${highlightText}:fontsize=38:x=max(${sideMargin}\\,(w-text_w)/2):y=h-text_h-95:bordercolor=black:borderw=2.4:shadowcolor=black@0.5:shadowx=1:shadowy=2`,
    );
  }

  return {
    filter: drawFilters.join(","),
    renderedLines: mainLines.length,
  };
}

async function renderVideo({
  imagePath,
  audioPath,
  outputPath,
  content,
  footerText,
  normalText,
  highlightText,
  seconds,
  tempDir,
}) {
  const { filter: textFilter, renderedLines } = buildTextOverlayFilter({
    content,
    footerText,
    tempDir,
    normalText,
    highlightText,
  });

  const filter = [
    `[0:v]scale=${DEFAULT_W}:${DEFAULT_H}:force_original_aspect_ratio=increase,`,
    `crop=${DEFAULT_W}:${DEFAULT_H},`,
    `fps=${OUTPUT_FPS},`,
    `format=yuv420p,`,
    textFilter,
    `[v]`,
  ].join("");

  const filterFile = path.join(tempDir, "filter.txt");
  fs.writeFileSync(filterFile, filter, "utf8");

  const cmd = [
    `ffmpeg -y`,
    `-loop 1 -framerate ${OUTPUT_FPS} -i ${q(imagePath)}`,
    `-stream_loop -1 -i ${q(audioPath)}`,
    `-filter_complex_script ${q(filterFile)}`,
    `-map "[v]" -map 1:a:0`,
    `-t ${Number(seconds).toFixed(3)}`,
    `-c:v libx264 -preset ${OUTPUT_PRESET} -crf ${OUTPUT_CRF}`,
    `-pix_fmt yuv420p -r ${OUTPUT_FPS}`,
    `-c:a aac -b:a 128k`,
    `-shortest`,
    `-movflags +faststart`,
    q(outputPath),
  ].join(" ");

  await runCommand(cmd, "render-simple-text-image-video");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Render failed");
  }

  return { renderedLines };
}

router.post("/", async (req, res) => {
  const {
    content,
    FooterText,
    footerText,
    audioUrl,
    imageBackground,
    second,
    normalText,
    highlightText,
  } = req.body || {};

  if (!content || typeof content !== "string" || content.trim().length < 10) {
    return res.status(400).json({
      success: false,
      error: "content is required, min 10 chars",
    });
  }

  if (!audioUrl || typeof audioUrl !== "string") {
    return res.status(400).json({
      success: false,
      error: "audioUrl is required",
    });
  }

  if (!imageBackground || typeof imageBackground !== "string") {
    return res.status(400).json({
      success: false,
      error: "imageBackground is required",
    });
  }

  const jobId = generateJobId();
  const tempDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const seconds =
      second !== undefined && second !== null && String(second).trim() !== ""
        ? Math.max(3, Number(second) || 10)
        : getRandomDefaultSeconds();

    const finalNormalText = safeColor(normalText, "#ffffff");
    const finalHighlightText = safeColor(highlightText, "#ffe600");
    const finalFooterText = FooterText || footerText || "";

    const imagePath = path.join(tempDir, "background.jpg");
    const audioPath = path.join(tempDir, "audio.mp3");
    const finalPath = path.join(tempDir, "final.mp4");

    await downloadFile(imageBackground, imagePath);
    await downloadFile(audioUrl, audioPath);

    const renderMeta = await renderVideo({
      imagePath,
      audioPath,
      outputPath: finalPath,
      content,
      footerText: finalFooterText,
      normalText: finalNormalText,
      highlightText: finalHighlightText,
      seconds,
      tempDir,
    });

    const uploadResult = await uploadVideo(
      finalPath,
      `simple_text_image_${jobId}.mp4`,
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
        duration: Number(Number(seconds).toFixed(2)),
        resolution: `${DEFAULT_W}x${DEFAULT_H}`,
        font: "Anton-Regular.ttf",
        normalText: finalNormalText,
        highlightText: finalHighlightText,
        footerText: finalFooterText || null,
        renderedLines: renderMeta.renderedLines,
        layout:
          "portrait image background + Anton bold text + sentence-based color highlight + optional CTA footer",
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
