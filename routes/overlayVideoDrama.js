// routes/video-content-overlay.js

const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const { uploadVideo } = require("../utils/uploadVps");
// const { uploadVideo } = require("../utils/uploadService");

const router = express.Router();
const pipelineAsync = promisify(pipeline);

// ======================================================
// CONFIG
// ======================================================

const W = 720;
const H = 1280;

const OUTPUT_FPS = 25;
const OUTPUT_CRF = 23;
const OUTPUT_PRESET = "veryfast";

const OUTPUT_AUDIO_BITRATE = "128k";
const OUTPUT_AUDIO_SAMPLE_RATE = 44100;

// Âm lượng cho chế độ giữ audio gốc.
const DEFAULT_ORIGINAL_AUDIO_VOLUME = 1;

// audioUrl đóng vai trò nhạc nền khi giữ audio gốc.
const DEFAULT_BACKGROUND_MUSIC_VOLUME = 0.5;

const MIN_AUDIO_VOLUME = 0;
const MAX_AUDIO_VOLUME = 2;

const DEFAULT_TEXT_COLOR = "#ffffff";
const DEFAULT_ACCENT_COLOR = "#d7ff00";

const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024;

// Vùng hiển thị content.
const TEXT_AREA_TOP = 500;
const TEXT_AREA_BOTTOM = 1085;

const DEFAULT_MAX_VISIBLE_CHARS = 850;
const DEFAULT_MAX_LINES = 15;

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const COMMAND_LOG_TAIL_CHARS = 30000;

const TEMP_ROOT = path.join(__dirname, "..", "temp", "video-content-overlay");

const FONT_DIR = path.join(__dirname, "..", "fonts");

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

if (!fs.existsSync(TEMP_ROOT)) {
  fs.mkdirSync(TEMP_ROOT, {
    recursive: true,
  });
}

// ======================================================
// JOB STORE
// ======================================================

const jobs = new Map();

function generateJobId() {
  return `video_content_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function createJob(payload) {
  const now = new Date().toISOString();

  const job = {
    id: generateJobId(),
    status: "queued",
    progress: 0,
    step: "queued",
    message: "Job đã được tạo, đang chờ xử lý",
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    payload,
    result: null,
    error: null,
  };

  jobs.set(job.id, job);

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

  const updated = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  jobs.set(jobId, updated);

  return updated;
}

function cleanupExpiredJobs() {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    const updatedTime = new Date(job.updatedAt || job.createdAt).getTime();

    if (now - updatedTime > JOB_TTL_MS) {
      jobs.delete(jobId);
    }
  }
}

setInterval(cleanupExpiredJobs, 60 * 60 * 1000).unref();

// ======================================================
// GENERIC HELPERS
// ======================================================

function cleanupDirectory(directory) {
  try {
    if (fs.existsSync(directory)) {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
      });
    }
  } catch (error) {
    console.warn(`Cleanup failed: ${error.message}`);
  }
}

function normalizeHexColor(color, fallback) {
  if (typeof color !== "string") {
    return fallback;
  }

  const value = color.trim();

  return HEX_COLOR_RE.test(value) ? value : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }

  return fallback;
}

function normalizeAudioVolume(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(MAX_AUDIO_VOLUME, Math.max(MIN_AUDIO_VOLUME, numericValue));
}

function normalizeLanguage(language) {
  const value = String(language || "")
    .trim()
    .toLowerCase();

  if (["jp", "ja", "japan", "japanese", "nhật", "nhat"].includes(value)) {
    return "jp";
  }

  if (["kr", "ko", "korea", "korean", "hàn", "han"].includes(value)) {
    return "kr";
  }

  return "default";
}

function getLayoutByLanguage(languageType) {
  if (languageType === "jp") {
    return {
      fontFile: "NotoSansJP-Bold.otf",
      fontFamily: "StoryFontJP",

      bodyFontSize: 27,
      bodyLineHeight: 1.22,
      bodyLineGap: 3,

      callFontSize: 22,
      maxLines: 15,
      maxVisibleChars: 720,
    };
  }

  if (languageType === "kr") {
    return {
      fontFile: "NotoSansKR-Bold.ttf",
      fontFamily: "StoryFontKR",

      bodyFontSize: 27,
      bodyLineHeight: 1.22,
      bodyLineGap: 3,

      callFontSize: 22,
      maxLines: 15,
      maxVisibleChars: 740,
    };
  }

  return {
    fontFamily: "DejaVu Sans",

    bodyFontSize: 24,
    bodyLineHeight: 1.18,
    bodyLineGap: 2,

    callFontSize: 22,
    maxLines: 19,
    maxVisibleChars: 1100,
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

function containsCjk(text = "") {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
}

// ======================================================
// TEXT WIDTH
// ======================================================

function estimateTextWidth(text = "", fontSize = 30) {
  let width = 0;

  for (const character of Array.from(text)) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(character)) {
      width += fontSize;
    } else if (/[MW]/.test(character)) {
      width += fontSize * 0.93;
    } else if (/[I]/.test(character)) {
      width += fontSize * 0.35;
    } else if (/[A-ZĂÂÎȘȚÁÀÃÄÅÆÉÈÊËÍÌÎÏÓÒÔÕÖØÚÙÛÜÇÑ]/.test(character)) {
      width += fontSize * 0.72;
    } else if (/[mw]/.test(character)) {
      width += fontSize * 0.86;
    } else if (/[ilj]/.test(character)) {
      width += fontSize * 0.32;
    } else if (/[a-zăâîșțáàãäåæéèêëíìîïóòôõöøúùûüçñ]/.test(character)) {
      width += fontSize * 0.59;
    } else if (/[0-9]/.test(character)) {
      width += fontSize * 0.62;
    } else if (/\s/.test(character)) {
      width += fontSize * 0.33;
    } else if (/[„“”"'’`]/.test(character)) {
      width += fontSize * 0.33;
    } else if (/[.,:;!?]/.test(character)) {
      width += fontSize * 0.32;
    } else if (/[()[\]{}]/.test(character)) {
      width += fontSize * 0.42;
    } else if (/[-–—_/\\]/.test(character)) {
      width += fontSize * 0.46;
    } else {
      width += fontSize * 0.54;
    }
  }

  return width;
}

function getWrapTextWidth(text = "", fontSize = 30) {
  // Hệ số an toàn để tránh chữ tràn mép phải.
  return estimateTextWidth(text, fontSize) * 1.04;
}

function getAdvanceTextWidth(text = "", fontSize = 30) {
  return estimateTextWidth(text, fontSize);
}

// ======================================================
// PARSE [[HIGHLIGHT]]
// ======================================================

function parseMarkedContent(text = "") {
  const normalized = String(text)
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const parts = [];
  const regex = /\[\[(.*?)\]\]/g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(normalized))) {
    const before = normalized.slice(lastIndex, match.index);
    const highlighted = match[1];

    if (before) {
      parts.push({
        text: before,
        accent: false,
      });
    }

    if (highlighted && highlighted.trim()) {
      parts.push({
        text: highlighted.trim(),
        accent: true,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  const after = normalized.slice(lastIndex);

  if (after) {
    parts.push({
      text: after,
      accent: false,
    });
  }

  if (!parts.length) {
    return [
      {
        text: normalized,
        accent: false,
      },
    ];
  }

  return parts;
}

function tokenizeStyledParts(parts = []) {
  const tokens = [];

  for (const part of parts) {
    if (!part?.text) {
      continue;
    }

    if (containsCjk(part.text)) {
      for (const character of Array.from(part.text)) {
        if (/\s/.test(character)) {
          tokens.push({
            text: " ",
            accent: Boolean(part.accent),
            isCjk: true,
            isSpace: true,
          });

          continue;
        }

        tokens.push({
          text: character,
          accent: Boolean(part.accent),
          isCjk: true,
          isSpace: false,
        });
      }

      continue;
    }

    const words = part.text.trim().split(/\s+/).filter(Boolean);

    for (const word of words) {
      tokens.push({
        text: word,
        accent: Boolean(part.accent),
        isCjk: false,
        isSpace: false,
      });
    }
  }

  return tokens;
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

  if (containsCjk(lastSegment.text)) {
    const characters = Array.from(lastSegment.text);

    characters.pop();

    const nextText = characters.join("");

    if (nextText) {
      lastSegment.text = nextText;
    } else {
      line.segments.pop();
    }

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

function addEllipsis(line, maxWidth, fontSize) {
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
      accent: false,
    });

    return line;
  }

  line.segments[line.segments.length - 1].text += "...";

  return line;
}

function buildStyledLines({
  text,
  maxLineWidth,
  maxLines,
  maxVisibleChars,
  fontSize,
}) {
  const parts = parseMarkedContent(text);
  const tokens = tokenizeStyledParts(parts);

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

  function appendSegment(textValue, accent) {
    const lastSegment = currentLine.segments[currentLine.segments.length - 1];

    if (lastSegment && lastSegment.accent === accent) {
      lastSegment.text += textValue;
    } else {
      currentLine.segments.push({
        text: textValue,
        accent,
      });
    }
  }

  function addToken(token) {
    if (token.isSpace) {
      const spaceWidth = getWrapTextWidth(" ", fontSize);

      if (currentWidth > 0 && currentWidth + spaceWidth <= maxLineWidth) {
        appendSegment(" ", token.accent);
        currentWidth += spaceWidth;
      }

      return;
    }

    const needsSpace = currentWidth > 0 && !token.isCjk;

    const candidateText = `${needsSpace ? " " : ""}${token.text}`;

    const candidateWidth = getWrapTextWidth(candidateText, fontSize);

    if (currentWidth > 0 && currentWidth + candidateWidth > maxLineWidth) {
      pushCurrentLine();
    }

    const finalNeedsSpace = currentWidth > 0 && !token.isCjk;

    const finalText = `${finalNeedsSpace ? " " : ""}${token.text}`;

    appendSegment(finalText, token.accent);

    currentWidth += getWrapTextWidth(finalText, fontSize);
  }

  for (const token of tokens) {
    const separatorLength =
      visibleLength > 0 && !token.isCjk && !token.isSpace ? 1 : 0;

    const nextLength = visibleLength + separatorLength + token.text.length;

    if (nextLength > maxVisibleChars) {
      truncated = true;
      break;
    }

    addToken(token);
    visibleLength = nextLength;

    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
  }

  pushCurrentLine();

  if (lines.length > maxLines) {
    truncated = true;
  }

  const visibleLines = lines.slice(0, maxLines);

  if (truncated && visibleLines.length) {
    visibleLines[visibleLines.length - 1] = addEllipsis(
      visibleLines[visibleLines.length - 1],
      maxLineWidth,
      fontSize,
    );
  }

  return visibleLines;
}

// ======================================================
// DOWNLOAD
// ======================================================

async function downloadFile(url, destination) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 60000,
    family: 4,
    maxRedirects: 8,
    maxBodyLength: Infinity,
    maxContentLength: MAX_DOWNLOAD_SIZE,

    validateStatus: (status) => status >= 200 && status < 300,

    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
    },
  });

  const contentLength = Number(response.headers["content-length"] || 0);

  if (contentLength > MAX_DOWNLOAD_SIZE) {
    throw new Error(`File is too large: ${contentLength} bytes`);
  }

  await pipelineAsync(response.data, fs.createWriteStream(destination));

  const stat = await fs.promises.stat(destination);

  if (!stat.size) {
    throw new Error(`Downloaded file is empty: ${url}`);
  }

  return destination;
}

async function fontToDataUri(fontPath) {
  const buffer = await fs.promises.readFile(fontPath);
  const extension = path.extname(fontPath).toLowerCase();

  const mime = extension === ".otf" ? "font/otf" : "font/ttf";

  return `data:${mime};base64,${buffer.toString("base64")}`;
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
  normalColor,
  accentColor,
  fontFamily,
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

          const fill = segment.accent ? accentColor : normalColor;

          return `<tspan fill="${fill}">${escapeSvgText(segmentText)}</tspan>`;
        })
        .join("");

      return `
        <text
          x="${startX}"
          y="${y}"
          xml:space="preserve"
          style="white-space:pre"
          font-family="${fontFamily}"
          font-size="${fontSize}"
          font-weight="800"
          letter-spacing="-0.45"
          fill="${normalColor}"
          stroke="rgba(0,0,0,0.86)"
          stroke-width="1.45"
          stroke-linejoin="round"
          paint-order="stroke fill"
        >${tspans}</text>
      `;
    })
    .join("");
}

// ======================================================
// OVERLAY
// ======================================================

async function createOverlayPng({
  outputPath,
  content,
  call,
  languageType,
  textColor,
  accentColor,
}) {
  const layout = getLayoutByLanguage(languageType);

  let fontFaceSvg = "";

  if (layout.fontFile) {
    const fontPath = path.join(FONT_DIR, layout.fontFile);

    if (!fs.existsSync(fontPath)) {
      throw new Error(`Font file not found: ${fontPath}`);
    }

    const fontDataUri = await fontToDataUri(fontPath);

    fontFaceSvg = `
      <style>
        @font-face {
          font-family: '${layout.fontFamily}';
          src: url('${fontDataUri}');
          font-weight: 700 900;
        }
      </style>
    `;
  }

  const safeContent = typeof content === "string" ? content.trim() : "";

  const safeCall = typeof call === "string" ? call.trim() : "";

  const hasCall = Boolean(safeCall);

  // ====================================================
  // CONTENT
  // ====================================================

  const boxOuterX = 24;
  const boxWidth = W - boxOuterX * 2;

  const contentPaddingLeft = 24;
  const contentPaddingRight = 34;
  const contentPaddingTop = 18;
  const contentPaddingBottom = 20;

  const textStartX = boxOuterX + contentPaddingLeft;

  const maxTextWidth = boxWidth - contentPaddingLeft - contentPaddingRight;

  const fontSize = layout.bodyFontSize;

  const baseLineHeight = Math.ceil(fontSize * layout.bodyLineHeight);

  const lineGap = layout.bodyLineGap;

  const maximumHeight = TEXT_AREA_BOTTOM - TEXT_AREA_TOP;

  const maxLinesByHeight = Math.max(
    1,
    Math.floor(
      (maximumHeight - contentPaddingTop - contentPaddingBottom + lineGap) /
        (baseLineHeight + lineGap),
    ),
  );

  const maxLines = Math.min(layout.maxLines, maxLinesByHeight);

  const lines = buildStyledLines({
    text: safeContent,
    maxLineWidth: maxTextWidth,
    maxLines,
    maxVisibleChars: layout.maxVisibleChars,
    fontSize,
  });

  const actualTextHeight =
    lines.length > 0
      ? lines.length * baseLineHeight + Math.max(0, lines.length - 1) * lineGap
      : baseLineHeight;

  const boxHeight = actualTextHeight + contentPaddingTop + contentPaddingBottom;

  const preferredBoxY = 515;

  const maximumBoxY = TEXT_AREA_BOTTOM - boxHeight;

  const contentBoxY = Math.max(
    TEXT_AREA_TOP,
    Math.min(preferredBoxY, maximumBoxY),
  );

  const textStartY = contentBoxY + contentPaddingTop + fontSize * 0.87;

  const textLinesSvg = renderTextLinesSvg({
    lines,
    startX: textStartX,
    startY: textStartY,
    fontSize,
    lineHeightPx: baseLineHeight + lineGap,
    normalColor: textColor,
    accentColor,
    fontFamily: layout.fontFamily,
  });

  // ====================================================
  // CALL
  // ====================================================

  let displayCall = safeCall;

  const callMaxTextWidth = W - 150;

  while (
    displayCall &&
    getWrapTextWidth(displayCall, layout.callFontSize) > callMaxTextWidth
  ) {
    displayCall = displayCall.slice(0, -1);
  }

  if (displayCall && displayCall !== safeCall) {
    displayCall = `${displayCall.trim()}...`;
  }

  const callWidth = displayCall
    ? Math.min(
        W - 72,
        Math.max(
          280,
          getAdvanceTextWidth(displayCall, layout.callFontSize) + 64,
        ),
      )
    : 0;

  const callHeight = 62;
  const callX = (W - callWidth) / 2;
  const callY = H - 106;
  const callCenterY = callY + callHeight / 2;

  const callSvg = displayCall
    ? `
      <rect
        x="${callX}"
        y="${callY}"
        width="${callWidth}"
        height="${callHeight}"
        rx="${callHeight / 2}"
        fill="rgba(255,255,255,0.08)"
        stroke="rgba(255,255,255,0.18)"
        stroke-width="1.5"
        filter="url(#callShadow)"
      />

      <text
        x="${W / 2}"
        y="${callCenterY}"
        text-anchor="middle"
        dominant-baseline="central"
        xml:space="preserve"
        style="white-space:pre"
        font-family="${layout.fontFamily}"
        font-size="${layout.callFontSize}"
        font-weight="700"
        fill="${accentColor}"
        stroke="rgba(0,0,0,0.72)"
        stroke-width="1.5"
        stroke-linejoin="round"
        paint-order="stroke fill"
      >${escapeSvgText(displayCall)}</text>
    `
    : "";

  // ====================================================
  // FINAL SVG
  // ====================================================

  const svg = `
    <svg
      width="${W}"
      height="${H}"
      viewBox="0 0 ${W} ${H}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        ${fontFaceSvg}

        <filter
          id="contentShadow"
          x="-20%"
          y="-25%"
          width="140%"
          height="150%"
        >
          <feDropShadow
            dx="0"
            dy="5"
            stdDeviation="8"
            flood-color="#000000"
            flood-opacity="0.40"
          />
        </filter>

        <filter
          id="callShadow"
          x="-25%"
          y="-35%"
          width="150%"
          height="170%"
        >
          <feDropShadow
            dx="0"
            dy="5"
            stdDeviation="7"
            flood-color="#000000"
            flood-opacity="0.46"
          />
        </filter>
      </defs>

      <rect
        x="${boxOuterX}"
        y="${contentBoxY}"
        width="${boxWidth}"
        height="${boxHeight}"
        rx="24"
        fill="rgba(5,5,5,0.18)"
        stroke="rgba(255,255,255,0.08)"
        stroke-width="1"
        filter="url(#contentShadow)"
      />

      <rect
        x="${boxOuterX + 1}"
        y="${contentBoxY + 1}"
        width="${boxWidth - 2}"
        height="${Math.max(2, boxHeight - 2)}"
        rx="23"
        fill="rgba(0,0,0,0.05)"
        stroke="rgba(255,255,255,0.06)"
        stroke-width="1"
      />

      ${textLinesSvg}

      ${hasCall ? callSvg : ""}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to create overlay PNG");
  }

  const stat = await fs.promises.stat(outputPath);

  if (!stat.size) {
    throw new Error("Overlay PNG is empty");
  }

  return {
    outputPath,
    lineCount: lines.length,
    language: languageType,
    bodyFontSize: fontSize,
    boxHeight,
    boxY: contentBoxY,
    maxTextWidth,
  };
}

// ======================================================
// COMMAND
// ======================================================

function runCommand(command, args, label) {
  console.log(`\n========== ${label} ==========`);

  console.log(
    command,
    args
      .map((arg) =>
        /\s/.test(String(arg)) ? JSON.stringify(arg) : String(arg),
      )
      .join(" "),
  );

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

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

      reject(new Error(`[${label}] exited with code ${code}\n${stderr}`));
    });
  });
}

// ======================================================
// FFPROBE
// ======================================================

async function getVideoDuration(videoPath) {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ];

  const { stdout } = await runCommand("ffprobe", args, "probe-video-duration");

  const duration = Number(String(stdout).trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Cannot determine source video duration");
  }

  return duration;
}

async function hasAudioStream(videoPath) {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=index",
    "-of",
    "csv=p=0",
    videoPath,
  ];

  const { stdout } = await runCommand("ffprobe", args, "probe-source-audio");

  return Boolean(String(stdout || "").trim());
}

// ======================================================
// VIDEO RENDER
// ======================================================

async function renderVideo({
  videoPath,
  audioPath,
  overlayPath,
  outputPath,
  seconds,

  keepOriginalAudio = false,

  originalAudioVolume = DEFAULT_ORIGINAL_AUDIO_VOLUME,

  backgroundMusicVolume = DEFAULT_BACKGROUND_MUSIC_VOLUME,
}) {
  const sourceDuration = await getVideoDuration(videoPath);

  const sourceHasAudio = await hasAudioStream(videoPath);

  const requestedKeepOriginalAudio = normalizeBoolean(keepOriginalAudio, false);

  const shouldMixOriginalAudio = requestedKeepOriginalAudio && sourceHasAudio;

  const hasRequestedDuration =
    Number.isFinite(Number(seconds)) && Number(seconds) > 0;

  const outputDuration = hasRequestedDuration
    ? Number(seconds)
    : sourceDuration;

  const safeOriginalAudioVolume = normalizeAudioVolume(
    originalAudioVolume,
    DEFAULT_ORIGINAL_AUDIO_VOLUME,
  );

  const safeBackgroundMusicVolume = normalizeAudioVolume(
    backgroundMusicVolume,
    DEFAULT_BACKGROUND_MUSIC_VOLUME,
  );

  const videoFilters = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${OUTPUT_FPS},setsar=1,format=yuv420p[source]`,

    `[1:v]scale=${W}:${H},format=rgba[overlay]`,

    `[source][overlay]overlay=0:0:format=auto,fps=${OUTPUT_FPS},setsar=1,format=yuv420p[video]`,
  ];

  let audioFilters;

  if (shouldMixOriginalAudio) {
    /*
     * 0:a = audio gốc trong video.
     * 2:a = audioUrl dùng làm nhạc nền.
     */
    audioFilters = [
      `[0:a]aresample=${OUTPUT_AUDIO_SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${OUTPUT_AUDIO_SAMPLE_RATE}:channel_layouts=stereo,volume=${safeOriginalAudioVolume}[original_audio]`,

      `[2:a]aresample=${OUTPUT_AUDIO_SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${OUTPUT_AUDIO_SAMPLE_RATE}:channel_layouts=stereo,volume=${safeBackgroundMusicVolume}[background_music]`,

      `[original_audio][background_music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[audio]`,
    ];
  } else {
    /*
     * Chế độ mặc định:
     * loại bỏ audio gốc và dùng audioUrl làm audio chính.
     */
    audioFilters = [
      `[2:a]aresample=${OUTPUT_AUDIO_SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:sample_rates=${OUTPUT_AUDIO_SAMPLE_RATE}:channel_layouts=stereo,volume=1,alimiter=limit=0.95[audio]`,
    ];
  }

  const filterComplex = [...videoFilters, ...audioFilters].join(";");

  const args = [
    "-y",

    // Loop video nếu seconds dài hơn video nguồn.
    "-stream_loop",
    "-1",
    "-i",
    videoPath,

    // Overlay PNG.
    "-loop",
    "1",
    "-framerate",
    String(OUTPUT_FPS),
    "-i",
    overlayPath,

    // Loop audioUrl.
    "-stream_loop",
    "-1",
    "-i",
    audioPath,

    "-filter_complex",
    filterComplex,

    "-map",
    "[video]",

    "-map",
    "[audio]",

    "-t",
    outputDuration.toFixed(3),

    "-c:v",
    "libx264",

    "-preset",
    OUTPUT_PRESET,

    "-crf",
    String(OUTPUT_CRF),

    "-pix_fmt",
    "yuv420p",

    "-r",
    String(OUTPUT_FPS),

    "-c:a",
    "aac",

    "-b:a",
    OUTPUT_AUDIO_BITRATE,

    "-ar",
    String(OUTPUT_AUDIO_SAMPLE_RATE),

    "-ac",
    "2",

    "-movflags",
    "+faststart",

    outputPath,
  ];

  await runCommand(
    "ffmpeg",
    args,
    shouldMixOriginalAudio
      ? "render-video-original-plus-background"
      : "render-video-replacement-audio",
  );

  if (!fs.existsSync(outputPath)) {
    throw new Error("FFmpeg did not create output video");
  }

  const stat = await fs.promises.stat(outputPath);

  if (!stat.size) {
    throw new Error("Output video is empty");
  }

  return {
    outputPath,

    sourceDuration: Number(sourceDuration.toFixed(3)),

    duration: Number(outputDuration.toFixed(3)),

    sizeBytes: stat.size,

    sourceHasAudio,

    requestedKeepOriginalAudio,

    originalAudioKept: shouldMixOriginalAudio,

    audioMode: shouldMixOriginalAudio
      ? "original_plus_background_music"
      : "replacement_audio",

    originalAudioVolume: shouldMixOriginalAudio ? safeOriginalAudioVolume : 0,

    backgroundMusicVolume: shouldMixOriginalAudio
      ? safeBackgroundMusicVolume
      : 1,
  };
}

// ======================================================
// PROCESS JOB
// ======================================================

async function processJob(jobId) {
  const job = getJob(jobId);

  if (!job) {
    throw new Error("Job not found");
  }

  const {
    videoUrl,
    audioUrl,
    content,
    language,
    call,

    textColor,
    accentColor,

    whiteTextColor,
    yellowTextColor,

    seconds,

    keepOriginalAudio,
    originalAudioVolume,
    backgroundMusicVolume,
  } = job.payload;

  const tempDir = path.join(TEMP_ROOT, jobId);

  fs.mkdirSync(tempDir, {
    recursive: true,
  });

  const videoPath = path.join(tempDir, "source-video.mp4");

  const audioPath = path.join(tempDir, "external-audio");

  const overlayPath = path.join(tempDir, "overlay.png");

  const outputPath = path.join(tempDir, "final.mp4");

  try {
    setJob(jobId, {
      status: "processing",
      progress: 5,
      step: "starting",
      message: "Bắt đầu xử lý video",
      startedAt: new Date().toISOString(),
      error: null,
    });

    setJob(jobId, {
      progress: 10,
      step: "download",
      message: "Đang tải video nguồn và audio...",
    });

    await Promise.all([
      downloadFile(videoUrl, videoPath),
      downloadFile(audioUrl, audioPath),
    ]);

    setJob(jobId, {
      progress: 35,
      step: "create-overlay",
      message: "Đang tạo overlay nội dung...",
    });

    const languageType = normalizeLanguage(language);

    const finalTextColor = normalizeHexColor(
      textColor ?? whiteTextColor,
      DEFAULT_TEXT_COLOR,
    );

    const finalAccentColor = normalizeHexColor(
      accentColor ?? yellowTextColor,
      DEFAULT_ACCENT_COLOR,
    );

    const overlayResult = await createOverlayPng({
      outputPath: overlayPath,
      content,
      call,
      languageType,
      textColor: finalTextColor,
      accentColor: finalAccentColor,
    });

    const useOriginalAudio = normalizeBoolean(keepOriginalAudio, false);

    setJob(jobId, {
      progress: 55,
      step: "render-video",
      message: useOriginalAudio
        ? "Đang giữ audio gốc và trộn nhạc nền..."
        : "Đang loại bỏ audio gốc và dùng audio mới...",
    });

    const renderResult = await renderVideo({
      videoPath,
      audioPath,
      overlayPath,
      outputPath,
      seconds,

      keepOriginalAudio: useOriginalAudio,

      originalAudioVolume,

      backgroundMusicVolume,
    });

    setJob(jobId, {
      progress: 88,
      step: "upload",
      message: "Đang upload video...",
    });

    const filename = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}.mp4`;

    const uploadResult = await uploadVideo(outputPath, filename);

    if (!uploadResult?.url) {
      throw new Error("Upload video failed");
    }

    const result = {
      success: true,
      url: uploadResult.url,
      service: uploadResult.service,
      permanent: uploadResult.permanent || false,

      metadata: {
        resolution: `${W}x${H}`,

        sourceDuration: renderResult.sourceDuration,

        duration: renderResult.duration,

        outputSizeBytes: renderResult.sizeBytes,

        fps: OUTPUT_FPS,
        crf: OUTPUT_CRF,
        preset: OUTPUT_PRESET,

        language: overlayResult.language,

        lineCount: overlayResult.lineCount,

        bodyFontSize: overlayResult.bodyFontSize,

        textBoxY: overlayResult.boxY,

        textBoxHeight: overlayResult.boxHeight,

        maxTextWidth: overlayResult.maxTextWidth,

        sourceHasAudio: renderResult.sourceHasAudio,

        requestedKeepOriginalAudio: renderResult.requestedKeepOriginalAudio,

        originalAudioKept: renderResult.originalAudioKept,

        audioMode: renderResult.audioMode,

        originalAudioVolume: renderResult.originalAudioVolume,

        backgroundMusicVolume: renderResult.backgroundMusicVolume,

        audioUrlLooped: true,

        sourceVideoLooped: renderResult.duration > renderResult.sourceDuration,

        layout: "source video + content overlay + configurable audio mixing",
      },
    };

    setJob(jobId, {
      status: "done",
      progress: 100,
      step: "done",
      message: "Hoàn thành",
      result,
      finishedAt: new Date().toISOString(),
    });

    cleanupDirectory(tempDir);

    return result;
  } catch (error) {
    cleanupDirectory(tempDir);

    setJob(jobId, {
      status: "failed",
      progress: 100,
      step: "failed",
      message: "Xử lý thất bại",
      error: error?.message || "Unknown error",
      finishedAt: new Date().toISOString(),
    });

    throw error;
  }
}

// ======================================================
// JOB RUNNER
// ======================================================

async function runJob(jobId) {
  try {
    await processJob(jobId);
  } catch (error) {
    console.error(`Video content job failed ${jobId}:`, error.message);
  }
}

// ======================================================
// POST /
// ======================================================

router.post("/", async (req, res) => {
  const {
    videoUrl,
    audioUrl,
    content,
    language,
    call,

    textColor,
    accentColor,

    whiteTextColor,
    yellowTextColor,

    seconds,

    keepOriginalAudio,

    originalAudioVolume,

    backgroundMusicVolume,
  } = req.body || {};

  if (!videoUrl || typeof videoUrl !== "string" || !videoUrl.trim()) {
    return res.status(400).json({
      success: false,
      error: "videoUrl is required",
    });
  }

  if (!audioUrl || typeof audioUrl !== "string" || !audioUrl.trim()) {
    return res.status(400).json({
      success: false,
      error: "audioUrl is required",
    });
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({
      success: false,
      error: "content is required",
    });
  }

  if (
    seconds != null &&
    (!Number.isFinite(Number(seconds)) || Number(seconds) <= 0)
  ) {
    return res.status(400).json({
      success: false,
      error: "seconds must be a positive number",
    });
  }

  if (
    originalAudioVolume != null &&
    originalAudioVolume !== "" &&
    !Number.isFinite(Number(originalAudioVolume))
  ) {
    return res.status(400).json({
      success: false,
      error: "originalAudioVolume must be a number",
    });
  }

  if (
    backgroundMusicVolume != null &&
    backgroundMusicVolume !== "" &&
    !Number.isFinite(Number(backgroundMusicVolume))
  ) {
    return res.status(400).json({
      success: false,
      error: "backgroundMusicVolume must be a number",
    });
  }

  const normalizedKeepOriginalAudio = normalizeBoolean(
    keepOriginalAudio,
    false,
  );

  const normalizedOriginalAudioVolume = normalizeAudioVolume(
    originalAudioVolume,
    DEFAULT_ORIGINAL_AUDIO_VOLUME,
  );

  const normalizedBackgroundMusicVolume = normalizeAudioVolume(
    backgroundMusicVolume,
    DEFAULT_BACKGROUND_MUSIC_VOLUME,
  );

  const job = createJob({
    videoUrl: videoUrl.trim(),

    audioUrl: audioUrl.trim(),

    content: content.trim(),

    language: language || null,

    call: typeof call === "string" ? call.trim() : "",

    textColor,
    accentColor,

    whiteTextColor,
    yellowTextColor,

    seconds: seconds != null ? Number(seconds) : null,

    keepOriginalAudio: normalizedKeepOriginalAudio,

    originalAudioVolume: normalizedOriginalAudioVolume,

    backgroundMusicVolume: normalizedBackgroundMusicVolume,
  });

  console.log("\n╔══════════════════════════════════════════════════════╗");

  console.log(`║ 🎬 VIDEO CONTENT Job: ${job.id}`);

  console.log(`║ 🎞️ Source: ${videoUrl.trim().substring(0, 60)}`);

  console.log(`║ 🎵 External audio: ${audioUrl.trim().substring(0, 60)}`);

  console.log(`║ 🔊 Keep original audio: ${normalizedKeepOriginalAudio}`);

  console.log(`║ 🎙️ Original volume: ${normalizedOriginalAudioVolume}`);

  console.log(`║ 🎼 Background volume: ${normalizedBackgroundMusicVolume}`);

  console.log(
    `║ ⏱️ Seconds: ${
      seconds != null ? Number(seconds) : "AUTO_FROM_SOURCE_VIDEO"
    }`,
  );

  console.log(`║ ⚙️ FPS/CRF: ${OUTPUT_FPS}/${OUTPUT_CRF}`);

  console.log("╚══════════════════════════════════════════════════════╝");

  res.status(202).json({
    success: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    step: job.step,
    message: job.message,

    audioMode: normalizedKeepOriginalAudio
      ? "original_plus_background_music"
      : "replacement_audio",

    pollUrl: `/api/overlay-story-video-drama/${job.id}`,
  });

  setImmediate(() => {
    runJob(job.id);
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
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,

    result: job.status === "done" ? job.result : null,
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

  cleanupDirectory(path.join(TEMP_ROOT, req.params.jobId));

  return res.json({
    success: true,
    message: "Job deleted",
  });
});

module.exports = router;
module.exports.jobs = jobs;
