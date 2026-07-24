const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const { pipeline } = require("stream");
const { promisify } = require("util");

const { uploadVideo } = require("../utils/uploadMe");
// const { uploadVideo } = require("../utils/uploadService");
// const { uploadVideo } = require("../utils/uploadVps");

const router = express.Router();
const pipelineAsync = promisify(pipeline);

// ======================================================
// CONFIG
// ======================================================

const OUTPUT_W = 720;
const OUTPUT_H = 1280;

const OUTPUT_FPS = 30;
const OUTPUT_CRF = 23;
const OUTPUT_PRESET = "superfast";

const CARD_X = 30;
const CARD_Y = 54;
const CARD_W = OUTPUT_W - CARD_X * 2;
const CARD_H = OUTPUT_H - CARD_Y - 30;

const TEXT_PADDING_LEFT = 24;
const TEXT_PADDING_RIGHT = 28;
const TEXT_PADDING_TOP = 18;
const TEXT_PADDING_BOTTOM = 14;

const MIN_IMAGE_H = 500;
const MAX_TEXT_H = CARD_H - MIN_IMAGE_H;

const MAX_CONTENT_CHARS = 1000;

const MAX_FONT_SIZE = 27;
const MIN_FONT_SIZE = 18;

const CALL_FONT_SIZE = 18;
const CALL_LINE_HEIGHT = 22;
const CALL_GAP = 14;

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const COMMAND_LOG_TAIL_CHARS = 20000;

const TEMP_DIR = path.join(__dirname, "..", "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true,
  });
}

// ======================================================
// JOB STORE
// ======================================================

const jobs = new Map();
const jobEvents = new EventEmitter();

jobEvents.setMaxListeners(1000);

function generateJobId() {
  return `story_card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createJob(payload) {
  const jobId = generateJobId();
  const now = new Date().toISOString();

  const job = {
    id: jobId,
    status: "queued",
    progress: 0,
    step: "queued",
    message: "Job đã được tạo",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    payload,
    result: null,
    error: null,
  };

  jobs.set(jobId, job);

  return job;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

function setJob(jobId, patch) {
  const current = jobs.get(jobId);

  if (!current) {
    return null;
  }

  const updatedJob = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  jobs.set(jobId, updatedJob);
  jobEvents.emit(`job:${jobId}`, updatedJob);

  return updatedJob;
}

function cleanupExpiredJobs() {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    const timestamp = new Date(job.updatedAt || job.createdAt).getTime();

    if (now - timestamp > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

setInterval(cleanupExpiredJobs, 60 * 60 * 1000).unref();

// ======================================================
// GENERAL HELPERS
// ======================================================

function normalizeText(value = "") {
  return String(value)
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clampContentAtWord(text, maxChars = MAX_CONTENT_CHARS) {
  const clean = normalizeText(text);

  if (clean.length <= maxChars) {
    return {
      text: clean,
      truncated: false,
      originalLength: clean.length,
    };
  }

  const safeLimit = Math.max(4, maxChars - 3);

  const sliced = clean.slice(0, safeLimit + 1);

  const lastSpace = sliced.lastIndexOf(" ");

  let result =
    lastSpace > 0 ? sliced.slice(0, lastSpace) : clean.slice(0, safeLimit);

  result = result.replace(/[\s.,!?:;"'”’)\]-]+$/, "");

  return {
    text: `${result}...`,
    truncated: true,
    originalLength: clean.length,
  };
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeSvgText(value = "") {
  return escapeXml(value).replace(/ /g, "&#160;");
}

function q(filePath) {
  return `"${String(filePath).replace(/"/g, '\\"')}"`;
}

function sanitizeError(error) {
  return error?.message || "Unknown error";
}

function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
      });

      console.log(`🗑️ Cleaned: ${tempDir}`);
    }
  } catch (error) {
    console.warn(`Cleanup failed: ${error.message}`);
  }
}

async function downloadFile(url, destination) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 60000,
    family: 4,
    maxRedirects: 8,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: (status) => status >= 200 && status < 300,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
    },
  });

  await pipelineAsync(response.data, fs.createWriteStream(destination));

  const stat = await fs.promises.stat(destination);

  if (!stat.size) {
    throw new Error(`Downloaded file is empty: ${url}`);
  }

  return destination;
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
      reject(new Error(`[${label}] ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });

        return;
      }

      reject(new Error(`[${label}] ${stderr || `FFmpeg exit code ${code}`}`));
    });
  });
}

// ======================================================
// TEXT WIDTH — ÁP DỤNG TỪ ROUTE THAM CHIẾU
// ======================================================

function estimateTextWidth(text = "", fontSize = 28) {
  let width = 0;

  for (const character of Array.from(text)) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(character)) {
      width += fontSize;
    } else if (/[MW]/.test(character)) {
      width += fontSize * 0.9;
    } else if (/[I]/.test(character)) {
      width += fontSize * 0.34;
    } else if (/[A-ZĂÂÎȘȚÁÀÃÄÅÆÉÈÊËÍÌÎÏÓÒÔÕÖØÚÙÛÜÇÑ]/.test(character)) {
      width += fontSize * 0.7;
    } else if (/[mw]/.test(character)) {
      width += fontSize * 0.84;
    } else if (/[ilj]/.test(character)) {
      width += fontSize * 0.31;
    } else if (/[a-zăâîșțáàãäåæéèêëíìîïóòôõöøúùûüçñ]/.test(character)) {
      width += fontSize * 0.57;
    } else if (/[0-9]/.test(character)) {
      width += fontSize * 0.62;
    } else if (/\s/.test(character)) {
      width += fontSize * 0.28;
    } else if (/[„“”"'’`]/.test(character)) {
      width += fontSize * 0.33;
    } else if (/[.,:;!?]/.test(character)) {
      width += fontSize * 0.32;
    } else if (/[()[\]{}]/.test(character)) {
      width += fontSize * 0.42;
    } else if (/[-–—_/\\]/.test(character)) {
      width += fontSize * 0.45;
    } else {
      width += fontSize * 0.52;
    }
  }

  return width;
}

function getWrapTextWidth(text = "", fontSize = 28) {
  return estimateTextWidth(text, fontSize) * 1.15;
}

// ======================================================
// TEXT LINE BUILDING
// ======================================================

function tokenizeText(text = "") {
  const normalized = normalizeText(text);

  if (!normalized) {
    return [];
  }

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({
      text: word,
    }));
}

function getLineWidth(line, fontSize) {
  return line.segments.reduce(
    (total, segment) => total + getWrapTextWidth(segment.text, fontSize),
    0,
  );
}

function removeLastUnit(line) {
  const lastSegment = line.segments[line.segments.length - 1];

  if (!lastSegment) {
    return;
  }

  const hadLeadingSpace = /^\s/.test(lastSegment.text);

  const words = lastSegment.text.trim().split(/\s+/).filter(Boolean);

  if (words.length > 1) {
    words.pop();

    lastSegment.text = `${hadLeadingSpace ? " " : ""}${words.join(" ")}`;

    return;
  }

  line.segments.pop();
}

function addEllipsisToLine(line, maxWidth, fontSize) {
  const ellipsisWidth = getWrapTextWidth("...", fontSize);

  while (
    line.segments.length &&
    getLineWidth(line, fontSize) + ellipsisWidth > maxWidth
  ) {
    removeLastUnit(line);
  }

  if (!line.segments.length) {
    line.segments.push({
      text: "...",
    });

    return line;
  }

  line.segments[line.segments.length - 1].text += "...";

  return line;
}

function buildTextLines({
  text,
  maxLineWidth,
  maxLines,
  maxVisibleChars,
  fontSize,
}) {
  const tokens = tokenizeText(text);

  const lines = [];

  let currentLine = {
    segments: [],
  };

  let currentWidth = 0;
  let visibleLength = 0;
  let truncated = false;

  function pushCurrentLine() {
    if (currentLine.segments.length) {
      lines.push(currentLine);
    }

    currentLine = {
      segments: [],
    };

    currentWidth = 0;
  }

  function appendSegment(textValue) {
    const lastSegment = currentLine.segments[currentLine.segments.length - 1];

    if (lastSegment) {
      lastSegment.text += textValue;
    } else {
      currentLine.segments.push({
        text: textValue,
      });
    }
  }

  for (const token of tokens) {
    const separatorLength = visibleLength > 0 ? 1 : 0;

    const nextLength = visibleLength + separatorLength + token.text.length;

    if (nextLength > maxVisibleChars) {
      truncated = true;
      break;
    }

    const needsSpace = currentWidth > 0;

    const candidateText = `${needsSpace ? " " : ""}${token.text}`;

    const candidateWidth = getWrapTextWidth(candidateText, fontSize);

    if (currentWidth > 0 && currentWidth + candidateWidth > maxLineWidth) {
      pushCurrentLine();
    }

    const finalNeedsSpace = currentWidth > 0;

    const finalText = `${finalNeedsSpace ? " " : ""}${token.text}`;

    appendSegment(finalText);

    currentWidth += getWrapTextWidth(finalText, fontSize);

    visibleLength = nextLength;
  }

  pushCurrentLine();

  if (lines.length > maxLines) {
    truncated = true;
  }

  const visibleLines = lines.slice(0, maxLines);

  if (truncated && visibleLines.length) {
    visibleLines[visibleLines.length - 1] = addEllipsisToLine(
      visibleLines[visibleLines.length - 1],
      maxLineWidth,
      fontSize,
    );
  }

  return {
    lines: visibleLines,
    truncated,
    visibleLength,
  };
}

// ======================================================
// TEXT LAYOUT
// ======================================================

function calculateTextLayout(content, call) {
  const clamped = clampContentAtWord(content, MAX_CONTENT_CHARS);

  const cleanContent = clamped.text;

  const cleanCall = normalizeText(call);

  const textStartX = TEXT_PADDING_LEFT;

  const textRightSafeX = CARD_W - TEXT_PADDING_RIGHT - 10;

  const maxTextWidth = textRightSafeX - textStartX;

  const callLines = cleanCall
    ? buildTextLines({
        text: cleanCall.toUpperCase(),
        maxLineWidth: maxTextWidth,
        maxLines: 2,
        maxVisibleChars: 150,
        fontSize: CALL_FONT_SIZE,
      }).lines
    : [];

  const callReservedHeight =
    callLines.length > 0 ? CALL_GAP + callLines.length * CALL_LINE_HEIGHT : 0;

  for (let fontSize = MAX_FONT_SIZE; fontSize >= MIN_FONT_SIZE; fontSize -= 1) {
    const baseLineHeight = Math.ceil(fontSize * 1.3);

    const lineGap = 2;

    const availableTextHeight =
      MAX_TEXT_H - TEXT_PADDING_TOP - TEXT_PADDING_BOTTOM - callReservedHeight;

    const maxLines = Math.max(
      1,
      Math.floor((availableTextHeight + lineGap) / (baseLineHeight + lineGap)),
    );

    const result = buildTextLines({
      text: cleanContent,
      maxLineWidth: maxTextWidth,
      maxLines,
      maxVisibleChars: MAX_CONTENT_CHARS,
      fontSize,
    });

    const textHeight =
      result.lines.length > 0
        ? result.lines.length * baseLineHeight +
          Math.max(0, result.lines.length - 1) * lineGap
        : baseLineHeight;

    const totalHeight =
      TEXT_PADDING_TOP + textHeight + callReservedHeight + TEXT_PADDING_BOTTOM;

    const contentFits = !result.truncated && totalHeight <= MAX_TEXT_H;

    if (contentFits) {
      return {
        fontSize,
        baseLineHeight,
        lineGap,
        contentLines: result.lines,
        callLines,
        textPanelHeight: Math.max(210, Math.ceil(totalHeight)),
        maxTextWidth,
        truncated: clamped.truncated,
        originalChars: clamped.originalLength,
        renderedChars: result.visibleLength,
      };
    }
  }

  const fontSize = MIN_FONT_SIZE;

  const baseLineHeight = Math.ceil(fontSize * 1.3);

  const lineGap = 2;

  const availableTextHeight =
    MAX_TEXT_H - TEXT_PADDING_TOP - TEXT_PADDING_BOTTOM - callReservedHeight;

  const maxLines = Math.max(
    1,
    Math.floor((availableTextHeight + lineGap) / (baseLineHeight + lineGap)),
  );

  const result = buildTextLines({
    text: cleanContent,
    maxLineWidth: maxTextWidth,
    maxLines,
    maxVisibleChars: MAX_CONTENT_CHARS,
    fontSize,
  });

  const textHeight =
    result.lines.length > 0
      ? result.lines.length * baseLineHeight +
        Math.max(0, result.lines.length - 1) * lineGap
      : baseLineHeight;

  const totalHeight =
    TEXT_PADDING_TOP + textHeight + callReservedHeight + TEXT_PADDING_BOTTOM;

  return {
    fontSize,
    baseLineHeight,
    lineGap,
    contentLines: result.lines,
    callLines,
    textPanelHeight: Math.min(
      MAX_TEXT_H,
      Math.max(210, Math.ceil(totalHeight)),
    ),
    maxTextWidth,
    truncated: clamped.truncated || result.truncated,
    originalChars: clamped.originalLength,
    renderedChars: result.visibleLength,
  };
}

// ======================================================
// SVG TEXT
// ======================================================

function renderTextLinesSvg({
  lines,
  startX,
  startY,
  fontSize,
  lineHeightPx,
  color,
}) {
  return lines
    .map((line, lineIndex) => {
      const y = startY + lineIndex * lineHeightPx;

      const tspans = line.segments
        .map((segment) => {
          const segmentText = String(segment.text || "");

          if (!segmentText) {
            return "";
          }

          return `<tspan fill="${color}">${escapeSvgText(segmentText)}</tspan>`;
        })
        .join("");

      return `<text x="${startX}" y="${y}" xml:space="preserve" style="white-space:pre" font-family="DejaVu Sans" font-size="${fontSize}" font-weight="700" fill="${color}">${tspans}</text>`;
    })
    .join("");
}

// ======================================================
// CREATE TEXT PANEL
// ======================================================

async function createTextPanel({ content, call, mode, outputPath }) {
  const layout = calculateTextLayout(content, call);

  const {
    fontSize,
    baseLineHeight,
    lineGap,
    contentLines,
    callLines,
    textPanelHeight,
    maxTextWidth,
  } = layout;

  const isLight = mode === "light";

  const backgroundColor = isLight ? "#f5f3ee" : "#050505";

  const textColor = isLight ? "#111111" : "#f4f4f4";

  const callColor = isLight ? "#202020" : "#eeeeee";

  const dividerColor = isLight ? "#c9c9c9" : "#343434";

  const textStartX = TEXT_PADDING_LEFT;

  const textStartY = TEXT_PADDING_TOP + fontSize * 0.92;

  const lineHeightPx = baseLineHeight + lineGap;

  const contentTextSvg = renderTextLinesSvg({
    lines: contentLines,
    startX: textStartX,
    startY: textStartY,
    fontSize,
    lineHeightPx,
    color: textColor,
  });

  const contentTextHeight =
    contentLines.length > 0
      ? contentLines.length * baseLineHeight +
        Math.max(0, contentLines.length - 1) * lineGap
      : baseLineHeight;

  let callStartY =
    TEXT_PADDING_TOP + contentTextHeight + CALL_GAP + CALL_FONT_SIZE * 0.92;

  const dividerY =
    TEXT_PADDING_TOP + contentTextHeight + Math.floor(CALL_GAP / 2);

  const callTextSvg = callLines
    .map((line, index) => {
      const y = callStartY + index * CALL_LINE_HEIGHT;

      const textValue = line.segments.map((segment) => segment.text).join("");

      return `<text x="${
        CARD_W / 2
      }" y="${y}" text-anchor="middle" xml:space="preserve" style="white-space:pre" font-family="DejaVu Sans" font-size="${CALL_FONT_SIZE}" font-weight="700" fill="${callColor}">${escapeSvgText(
        textValue,
      )}</text>`;
    })
    .join("");

  const dividerSvg =
    callLines.length > 0
      ? `<line x1="${TEXT_PADDING_LEFT}" y1="${dividerY}" x2="${
          CARD_W - TEXT_PADDING_RIGHT
        }" y2="${dividerY}" stroke="${dividerColor}" stroke-width="1"/>`
      : "";

  const svg = `
    <svg
      width="${CARD_W}"
      height="${textPanelHeight}"
      viewBox="0 0 ${CARD_W} ${textPanelHeight}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="0"
        y="0"
        width="${CARD_W}"
        height="${textPanelHeight}"
        fill="${backgroundColor}"
      />

      ${contentTextSvg}
      ${dividerSvg}
      ${callTextSvg}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to create text panel");
  }

  return {
    outputPath,
    textPanelHeight,
    contentLines: contentLines.length,
    callLines: callLines.length,
    fontSize,
    maxTextWidth,
    truncated: layout.truncated,
    originalChars: layout.originalChars,
    renderedChars: layout.renderedChars,
  };
}

// ======================================================
// IMAGE PANEL
// ======================================================

async function createBlurredBackground({ imagePath, width, height }) {
  return sharp(imagePath, {
    failOn: "none",
  })
    .flatten({
      background: "#000000",
    })
    .resize(width, height, {
      fit: "cover",
      position: "centre",
      kernel: sharp.kernel.lanczos3,
    })
    .grayscale()
    .blur(20)
    .modulate({
      brightness: 0.58,
    })
    .png()
    .toBuffer();
}

async function resizeContainedImage({
  imagePath,
  width,
  height,
  slightVerticalCrop = false,
}) {
  const targetHeight = slightVerticalCrop ? Math.round(height * 1.04) : height;

  let result = await sharp(imagePath, {
    failOn: "none",
  })
    .flatten({
      background: "#000000",
    })
    .resize({
      width,
      height: targetHeight,
      fit: "inside",
      withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3,
    })
    .grayscale()
    .png()
    .toBuffer({
      resolveWithObject: true,
    });

  let buffer = result.data;
  let actualWidth = result.info.width;
  let actualHeight = result.info.height;

  if (actualHeight > height) {
    const cropHeight = Math.min(height, actualHeight);

    const cropTop = Math.max(0, Math.floor((actualHeight - cropHeight) / 2));

    result = await sharp(buffer)
      .extract({
        left: 0,
        top: Math.min(cropTop, actualHeight - cropHeight),
        width: actualWidth,
        height: cropHeight,
      })
      .png()
      .toBuffer({
        resolveWithObject: true,
      });

    buffer = result.data;
    actualWidth = result.info.width;
    actualHeight = result.info.height;
  }

  return {
    buffer,
    width: actualWidth,
    height: actualHeight,
  };
}

async function createAdaptiveImagePanel({
  imagePath,
  outputPath,
  width,
  height,
}) {
  const metadata = await sharp(imagePath, {
    failOn: "none",
  }).metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("Không thể lấy kích thước imageUrl");
  }

  const sourceRatio = metadata.width / metadata.height;

  const panelRatio = width / height;

  const blurredBackground = await createBlurredBackground({
    imagePath,
    width,
    height,
  });

  let foregroundBuffer;
  let foregroundWidth;
  let foregroundHeight;
  let strategy;
  let useSideOverlay = false;

  if (sourceRatio < 0.78) {
    const contained = await resizeContainedImage({
      imagePath,
      width,
      height,
      slightVerticalCrop: true,
    });

    foregroundBuffer = contained.buffer;

    foregroundWidth = contained.width;

    foregroundHeight = contained.height;

    strategy = "portrait-contain-light-crop";

    useSideOverlay = true;
  } else if (sourceRatio <= 1.12) {
    const contained = await resizeContainedImage({
      imagePath,
      width,
      height,
      slightVerticalCrop: false,
    });

    foregroundBuffer = contained.buffer;

    foregroundWidth = contained.width;

    foregroundHeight = contained.height;

    strategy = "square-contain";

    useSideOverlay = true;
  } else if (sourceRatio < panelRatio * 1.12) {
    const contained = await resizeContainedImage({
      imagePath,
      width,
      height,
      slightVerticalCrop: false,
    });

    foregroundBuffer = contained.buffer;

    foregroundWidth = contained.width;

    foregroundHeight = contained.height;

    strategy = "landscape-contain";

    useSideOverlay = true;
  } else {
    const coverResult = await sharp(imagePath, {
      failOn: "none",
    })
      .flatten({
        background: "#000000",
      })
      .resize(width, height, {
        fit: "cover",
        position: "attention",
        kernel: sharp.kernel.lanczos3,
      })
      .grayscale()
      .png()
      .toBuffer({
        resolveWithObject: true,
      });

    foregroundBuffer = coverResult.data;

    foregroundWidth = coverResult.info.width;

    foregroundHeight = coverResult.info.height;

    strategy = "wide-cover";
  }

  const foregroundLeft = Math.max(0, Math.floor((width - foregroundWidth) / 2));

  const foregroundTop = Math.max(
    0,
    Math.floor((height - foregroundHeight) / 2),
  );

  const sideShadeSvg = `
    <svg
      width="${width}"
      height="${height}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id="leftShade"
          x1="0"
          y1="0"
          x2="1"
          y2="0"
        >
          <stop
            offset="0%"
            stop-color="black"
            stop-opacity="0.28"
          />
          <stop
            offset="100%"
            stop-color="black"
            stop-opacity="0"
          />
        </linearGradient>

        <linearGradient
          id="rightShade"
          x1="1"
          y1="0"
          x2="0"
          y2="0"
        >
          <stop
            offset="0%"
            stop-color="black"
            stop-opacity="0.28"
          />
          <stop
            offset="100%"
            stop-color="black"
            stop-opacity="0"
          />
        </linearGradient>
      </defs>

      <rect
        x="0"
        y="0"
        width="${Math.round(width * 0.2)}"
        height="${height}"
        fill="url(#leftShade)"
      />

      <rect
        x="${width - Math.round(width * 0.2)}"
        y="0"
        width="${Math.round(width * 0.2)}"
        height="${height}"
        fill="url(#rightShade)"
      />
    </svg>
  `;

  const layers = [
    {
      input: blurredBackground,
      left: 0,
      top: 0,
    },
    {
      input: foregroundBuffer,
      left: foregroundLeft,
      top: foregroundTop,
    },
  ];

  if (useSideOverlay) {
    layers.push({
      input: Buffer.from(sideShadeSvg),
      left: 0,
      top: 0,
    });
  }

  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 1,
      },
    },
  })
    .composite(layers)
    .png()
    .toFile(outputPath);

  return {
    outputPath,
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    originalRatio: Number(sourceRatio.toFixed(4)),
    panelRatio: Number(panelRatio.toFixed(4)),
    strategy,
    usedBlurSideBackground: useSideOverlay,
  };
}

// ======================================================
// BUILD CARD
// ======================================================

async function createStoryCard({
  imagePath,
  content,
  call,
  mode,
  tempDir,
  outputPath,
}) {
  const textPanelPath = path.join(tempDir, "text-panel.png");

  const imagePanelPath = path.join(tempDir, "image-panel.png");

  const textResult = await createTextPanel({
    content,
    call,
    mode,
    outputPath: textPanelPath,
  });

  const imagePanelHeight = Math.max(
    MIN_IMAGE_H,
    CARD_H - textResult.textPanelHeight,
  );

  const safeTextPanelHeight = CARD_H - imagePanelHeight;

  let finalTextPanelPath = textPanelPath;

  if (safeTextPanelHeight !== textResult.textPanelHeight) {
    finalTextPanelPath = path.join(tempDir, "text-panel-safe.png");

    const sourceMetadata = await sharp(textPanelPath).metadata();

    const sourceHeight = sourceMetadata.height || textResult.textPanelHeight;

    if (safeTextPanelHeight < sourceHeight) {
      await sharp(textPanelPath)
        .extract({
          left: 0,
          top: 0,
          width: CARD_W,
          height: safeTextPanelHeight,
        })
        .png()
        .toFile(finalTextPanelPath);
    } else {
      await sharp(textPanelPath)
        .extend({
          top: 0,
          bottom: safeTextPanelHeight - sourceHeight,
          left: 0,
          right: 0,
          background: mode === "light" ? "#f5f3ee" : "#050505",
        })
        .png()
        .toFile(finalTextPanelPath);
    }
  }

  const imageResult = await createAdaptiveImagePanel({
    imagePath,
    outputPath: imagePanelPath,
    width: CARD_W,
    height: imagePanelHeight,
  });

  const dividerColor =
    mode === "light"
      ? {
          r: 190,
          g: 190,
          b: 190,
          alpha: 1,
        }
      : {
          r: 35,
          g: 35,
          b: 35,
          alpha: 1,
        };

  const divider = await sharp({
    create: {
      width: CARD_W,
      height: 2,
      channels: 4,
      background: dividerColor,
    },
  })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: CARD_W,
      height: CARD_H,
      channels: 4,
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
      },
    },
  })
    .composite([
      {
        input: finalTextPanelPath,
        left: 0,
        top: 0,
      },
      {
        input: divider,
        left: 0,
        top: safeTextPanelHeight - 1,
      },
      {
        input: imagePanelPath,
        left: 0,
        top: safeTextPanelHeight,
      },
    ])
    .png()
    .toFile(outputPath);

  return {
    outputPath,
    textPanelHeight: safeTextPanelHeight,
    imagePanelHeight,
    contentLines: textResult.contentLines,
    callLines: textResult.callLines,
    fontSize: textResult.fontSize,
    maxTextWidth: textResult.maxTextWidth,
    truncated: textResult.truncated,
    originalChars: textResult.originalChars,
    renderedChars: textResult.renderedChars,
    imageRatio: imageResult.originalRatio,
    panelRatio: imageResult.panelRatio,
    imageStrategy: imageResult.strategy,
    usedBlurSideBackground: imageResult.usedBlurSideBackground,
  };
}

// ======================================================
// VIDEO COMPOSITION
// ======================================================

async function composeVideo({
  backgroundPath,
  cardPath,
  audioPath,
  outputPath,
  seconds,
  tempDir,
}) {
  const duration = Number(seconds);

  if (!Number.isFinite(duration) || duration < 3) {
    throw new Error("Invalid video duration");
  }

  const filter = [
    // Chỉ xử lý hình ảnh từ video nền.
    // Không đưa audio của background video vào output.
    `[0:v]scale=${OUTPUT_W}:${OUTPUT_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUTPUT_W}:${OUTPUT_H},fps=${OUTPUT_FPS},setsar=1,format=gray,eq=contrast=1.08:brightness=-0.035,format=yuv420p[bg]`,

    `[1:v]format=rgba[card]`,

    `[bg][card]overlay=${CARD_X}:${CARD_Y}:format=auto,fps=${OUTPUT_FPS},format=yuv420p[v]`,

    // Chuẩn hóa audioUrl và cắt đúng thời lượng video.
    `[2:a]aresample=async=1:first_pts=0,asetpts=N/SR/TB,atrim=duration=${duration.toFixed(
      3,
    )}[a]`,
  ].join(";");

  const filterPath = path.join(tempDir, "story-card-filter.txt");

  fs.writeFileSync(filterPath, filter, "utf8");

  const command = [
    `ffmpeg -y`,

    // Input 0: video nền. Chỉ sử dụng video track.
    `-stream_loop -1 -i ${q(backgroundPath)}`,

    // Input 1: card ảnh tĩnh.
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(cardPath)}`,

    // Input 2: audio bắt buộc.
    // Lặp audio nếu ngắn hơn thời lượng video.
    `-stream_loop -1 -i ${q(audioPath)}`,

    `-filter_complex_script ${q(filterPath)}`,

    // Chỉ map video đã dựng.
    `-map "[v]"`,

    // Chỉ map audio từ audioUrl.
    `-map "[a]"`,

    `-t ${duration.toFixed(3)}`,

    `-c:v libx264`,

    `-preset ${OUTPUT_PRESET}`,

    `-crf ${OUTPUT_CRF}`,

    `-pix_fmt yuv420p`,

    `-r ${OUTPUT_FPS}`,

    `-c:a aac`,

    `-b:a 128k`,

    `-ar 44100`,

    `-ac 2`,

    `-movflags +faststart`,

    q(outputPath),
  ].join(" ");

  await runCommand(command, "compose-story-card-video");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Không tạo được video đầu ra");
  }

  return outputPath;
}

// ======================================================
// PROCESS JOB
// ======================================================

async function processVideo(jobId, onProgress = () => {}) {
  const job = getJob(jobId);

  if (!job) {
    throw new Error("Job not found");
  }

  const { content, second, call, mode, backgroundUrl, imageUrl, audioUrl } =
    job.payload;

  const tempDir = path.join(TEMP_DIR, jobId);

  fs.mkdirSync(tempDir, {
    recursive: true,
  });

  const backgroundPath = path.join(tempDir, "background.mp4");

  const imagePath = path.join(tempDir, "image-source");

  const audioPath = path.join(tempDir, "audio-source");

  const cardPath = path.join(tempDir, "story-card.png");

  const finalPath = path.join(tempDir, "final.mp4");

  try {
    onProgress({
      progress: 10,
      step: "download",
      message: "Đang tải video nền, hình ảnh và audio...",
    });

    await Promise.all([
      downloadFile(backgroundUrl, backgroundPath),
      downloadFile(imageUrl, imagePath),
      downloadFile(audioUrl, audioPath),
    ]);

    onProgress({
      progress: 35,
      step: "create-card",
      message: "Đang dựng khối nội dung và hình ảnh...",
    });

    const cardResult = await createStoryCard({
      imagePath,
      content,
      call,
      mode,
      tempDir,
      outputPath: cardPath,
    });

    onProgress({
      progress: 58,
      step: "render-video",
      message: "Đang ghép card, video nền và audio...",
    });

    await composeVideo({
      backgroundPath,
      cardPath,
      audioPath,
      outputPath: finalPath,
      seconds: second,
      tempDir,
    });

    onProgress({
      progress: 88,
      step: "upload",
      message: "Đang upload video...",
    });

    const fileName = `${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 7)}.mp4`;

    const uploadResult = await uploadVideo(finalPath, fileName);

    if (!uploadResult?.url) {
      throw new Error("Upload video thất bại");
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
      message: "Hoàn thành",
    });

    return {
      success: true,
      url: uploadResult.url,
      service: uploadResult.service,
      permanent: uploadResult.permanent || false,

      metadata: {
        duration: Number(Number(second).toFixed(2)),

        resolution: `${OUTPUT_W}x${OUTPUT_H}`,

        fps: OUTPUT_FPS,
        crf: OUTPUT_CRF,
        preset: OUTPUT_PRESET,

        mode,
        grayscale: true,

        audioSource: "audioUrl",
        backgroundAudioRemoved: true,

        cardX: CARD_X,
        cardY: CARD_Y,
        cardWidth: CARD_W,
        cardHeight: CARD_H,

        textPanelHeight: cardResult.textPanelHeight,
        imagePanelHeight: cardResult.imagePanelHeight,
        contentLines: cardResult.contentLines,
        callLines: cardResult.callLines,
        fontSize: cardResult.fontSize,
        maxTextWidth: cardResult.maxTextWidth,
        contentTruncated: cardResult.truncated,
        originalChars: cardResult.originalChars,
        renderedChars: cardResult.renderedChars,
        maxContentChars: MAX_CONTENT_CHARS,
        imageRatio: cardResult.imageRatio,
        panelRatio: cardResult.panelRatio,
        imageStrategy: cardResult.imageStrategy,
        usedBlurSideBackground: cardResult.usedBlurSideBackground,

        layout:
          "grayscale background video + adaptive dark/light text panel + preserved image ratio with blur background",
      },
    };
  } catch (error) {
    cleanupTempDir(tempDir);
    throw error;
  }
}

async function runJob(jobId) {
  const job = getJob(jobId);

  if (!job) {
    return;
  }

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
      progress: 100,
      step: "failed",
      message: "Xử lý thất bại",
      error: sanitizeError(error),
      finishedAt: new Date().toISOString(),
    });
  }
}

// ======================================================
// POST /
// ======================================================

router.post("/", async (req, res) => {
  const {
    content,
    second,
    call = "",
    mode = "dark",
    backgroundUrl,
    imageUrl,
    audioUrl,
  } = req.body || {};

  const normalizedContent = normalizeText(content);

  const clampedContent = clampContentAtWord(
    normalizedContent,
    MAX_CONTENT_CHARS,
  );

  const normalizedCall = normalizeText(call);

  const normalizedMode = String(mode || "")
    .trim()
    .toLowerCase();

  const duration = Number(second);

  if (!normalizedContent || normalizedContent.length < 10) {
    return res.status(400).json({
      success: false,
      error: "content is required (minimum 10 characters)",
    });
  }

  if (!Number.isFinite(duration) || duration < 3) {
    return res.status(400).json({
      success: false,
      error: "second must be a number greater than or equal to 3",
    });
  }

  if (!["dark", "light"].includes(normalizedMode)) {
    return res.status(400).json({
      success: false,
      error: 'mode must be "dark" or "light"',
    });
  }

  if (!backgroundUrl || typeof backgroundUrl !== "string") {
    return res.status(400).json({
      success: false,
      error: "backgroundUrl is required",
    });
  }

  if (!imageUrl || typeof imageUrl !== "string") {
    return res.status(400).json({
      success: false,
      error: "imageUrl is required",
    });
  }

  if (!audioUrl || typeof audioUrl !== "string" || !audioUrl.trim()) {
    return res.status(400).json({
      success: false,
      error: "audioUrl is required",
    });
  }

  const job = createJob({
    content: clampedContent.text,

    second: duration,

    call: normalizedCall,

    mode: normalizedMode,

    backgroundUrl: backgroundUrl.trim(),

    imageUrl: imageUrl.trim(),

    audioUrl: audioUrl.trim(),
  });

  console.log("\n╔══════════════════════════════════════════════════════╗");

  console.log(`║ 🎬 Story Card Job: ${job.id}`);

  console.log(`║ 🌓 Mode: ${normalizedMode}`);

  console.log(`║ ⏱️ Duration: ${duration}s`);

  console.log(
    `║ 📝 Content: ${normalizedContent.length} -> ${clampedContent.text.length} chars`,
  );

  console.log(`║ 📣 Call: ${normalizedCall || "NONE"}`);
  console.log(`║ 🎵 Audio: ${audioUrl.trim()}`);

  console.log("╚══════════════════════════════════════════════════════╝");

  res.status(202).json({
    success: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    message: job.message,
    pollUrl: `/api/black-video/${job.id}`,
    eventsUrl: `/api/black-video/${job.id}/events`,
  });

  setImmediate(() => {
    runJob(job.id).catch((error) => {
      console.error(`Background job crashed: ${error.message}`);

      setJob(job.id, {
        status: "failed",
        progress: 100,
        step: "failed",
        message: "Background job crashed",
        error: sanitizeError(error),
        finishedAt: new Date().toISOString(),
      });
    });
  });
});

// ======================================================
// GET /:jobId
// ======================================================

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
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.status === "done" ? job.result : null,
  });
});

// ======================================================
// GET /:jobId/events
// ======================================================

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

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  send({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    message: job.message,
    error: job.error,
    result: job.status === "done" ? job.result : null,
  });

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

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

  req.on("close", () => {
    clearInterval(heartbeat);

    jobEvents.off(`job:${jobId}`, listener);
  });
});

// ======================================================
// DELETE /:jobId
// ======================================================

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

module.exports = router;
module.exports.jobs = jobs;
