const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const { uploadVideo } = require("../utils/uploadVps");

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

const DEFAULT_TEXT_COLOR = "#ffffff";
const DEFAULT_ACCENT_COLOR = "#d7ff00";

const MAX_VISIBLE_TEXT_CHARS = 900;
const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024;

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const COMMAND_LOG_TAIL_CHARS = 30000;

const TEMP_ROOT = path.join(__dirname, "..", "temp", "video-story-overlay");

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
  return `video_story_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

function normalizeLanguage(language) {
  const value = String(language || "")
    .trim()
    .toLowerCase();

  if (["jp", "ja", "japan", "japanese"].includes(value)) {
    return "jp";
  }

  if (["kr", "ko", "korea", "korean"].includes(value)) {
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
      bodyLineHeight: 1.28,
      bodyLineGap: 4,

      nameFontSize: 28,
      followFontSize: 24,
      callFontSize: 22,
    };
  }

  if (languageType === "kr") {
    return {
      fontFile: "NotoSansKR-Bold.ttf",
      fontFamily: "StoryFontKR",

      bodyFontSize: 28,
      bodyLineHeight: 1.27,
      bodyLineGap: 4,

      nameFontSize: 28,
      followFontSize: 24,
      callFontSize: 22,
    };
  }

  return {
    fontFile: "Arial Bold.ttf",
    fontFamily: "StoryFontDefault",

    bodyFontSize: 30,
    bodyLineHeight: 1.27,
    bodyLineGap: 4,

    nameFontSize: 30,
    followFontSize: 25,
    callFontSize: 23,
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

/**
 * Giữ dấu cách đầu segment khi Sharp render SVG.
 */
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
    } else if (/[A-ZĂÂÎȘȚÁÀÃÉÈÊÍÌÓÒÔÕÚÙÜÇÑ]/.test(character)) {
      width += fontSize * 0.64;
    } else if (/[a-zăâîșțáàãéèêíìóòôõúùüçñ]/.test(character)) {
      width += fontSize * 0.525;
    } else if (/[0-9]/.test(character)) {
      width += fontSize * 0.54;
    } else if (/\s/.test(character)) {
      width += fontSize * 0.275;
    } else if (/[„“”"'’`]/.test(character)) {
      width += fontSize * 0.25;
    } else if (/[.,:;!?()[\]{}]/.test(character)) {
      width += fontSize * 0.27;
    } else if (/[-–—_/\\]/.test(character)) {
      width += fontSize * 0.36;
    } else {
      width += fontSize * 0.4;
    }
  }

  return width;
}

function getWrapTextWidth(text = "", fontSize = 30) {
  return estimateTextWidth(text, fontSize) * 1.018;
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
// DOWNLOAD HELPERS
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

async function fileToDataUri(filePath) {
  const buffer = await fs.promises.readFile(filePath);

  const metadata = await sharp(buffer).metadata();

  let mime = "image/jpeg";

  if (metadata.format === "png") {
    mime = "image/png";
  } else if (metadata.format === "webp") {
    mime = "image/webp";
  } else if (metadata.format === "gif") {
    mime = "image/gif";
  }

  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function fontToDataUri(fontPath) {
  const buffer = await fs.promises.readFile(fontPath);

  const extension = path.extname(fontPath).toLowerCase();

  const mime = extension === ".otf" ? "font/otf" : "font/ttf";

  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// ======================================================
// SVG BODY TEXT
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

      /*
       * QUAN TRỌNG:
       * Các tspan được nối liền, không có newline hay indentation
       * ở giữa. Nhờ vậy xml:space="preserve" chỉ giữ khoảng trắng
       * thật nằm trong segment.text.
       */
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

      /*
       * Không đặt newline hoặc khoảng trắng trước ${tspans}
       * bên trong thẻ text.
       */
      return `<text x="${startX}" y="${y}" xml:space="preserve" style="white-space:pre" font-family="${fontFamily}" font-size="${fontSize}" font-weight="700" fill="${normalColor}" stroke="rgba(0,0,0,0.56)" stroke-width="1.25" stroke-linejoin="round" paint-order="stroke fill">${tspans}</text>`;
    })
    .join("");
}

// ======================================================
// OVERLAY PNG
// ======================================================

async function createOverlayPng({
  outputPath,
  avatarPath,
  content,
  languageType,
  call,
  name,
  follow,
  textColor,
  accentColor,
}) {
  const layout = getLayoutByLanguage(languageType);

  const fontPath = path.join(FONT_DIR, layout.fontFile);

  if (!fs.existsSync(fontPath)) {
    throw new Error(`Font file not found: ${fontPath}`);
  }

  const fontDataUri = await fontToDataUri(fontPath);

  let avatarDataUri = null;

  if (avatarPath && fs.existsSync(avatarPath)) {
    const normalizedAvatarPath = path.join(
      path.dirname(outputPath),
      "avatar-normalized.png",
    );

    await sharp(avatarPath)
      .resize(168, 168, {
        fit: "cover",
        position: "centre",
      })
      .png()
      .toFile(normalizedAvatarPath);

    avatarDataUri = await fileToDataUri(normalizedAvatarPath);
  }

  const safeName = typeof name === "string" ? name.trim() : "";

  const safeFollow = typeof follow === "string" ? follow.trim() : "";

  const safeCall = typeof call === "string" ? call.trim() : "";

  const hasHeader = Boolean(avatarDataUri || safeName || safeFollow);

  const hasCall = Boolean(safeCall);

  // ====================================================
  // HEADER
  // ====================================================

  const headerOuterX = 24;
  const headerTop = 30;
  const headerHeight = hasHeader ? 110 : 0;

  // ====================================================
  // BODY
  // ====================================================

  const bodyTop = hasHeader ? headerTop + headerHeight + 16 : 32;

  const callReservedHeight = hasCall ? 116 : 34;

  const bodyBottom = H - callReservedHeight;

  const availableBodyHeight = bodyBottom - bodyTop;

  const fontSize = layout.bodyFontSize;

  const baseLineHeight = Math.ceil(fontSize * layout.bodyLineHeight);

  const lineGap = layout.bodyLineGap;

  /*
   * Thu hẹp nhẹ vùng text để không sát mép phải.
   */
  const boxOuterX = 26;
  const boxWidth = W - boxOuterX * 2;

  const contentPaddingX = 27;
  const contentPaddingY = 22;
  const textSafetyX = 9;

  const textStartX = boxOuterX + contentPaddingX + textSafetyX;

  const textRightSafeX = boxOuterX + boxWidth - contentPaddingX - textSafetyX;

  const maxTextWidth = textRightSafeX - textStartX;

  const maxLines = Math.max(
    1,
    Math.floor(
      (availableBodyHeight - contentPaddingY * 2 + lineGap) /
        (baseLineHeight + lineGap),
    ),
  );

  const lines = buildStyledLines({
    text: content,
    maxLineWidth: maxTextWidth,
    maxLines,
    maxVisibleChars: MAX_VISIBLE_TEXT_CHARS,
    fontSize,
  });

  const actualTextHeight =
    lines.length > 0
      ? lines.length * baseLineHeight + Math.max(0, lines.length - 1) * lineGap
      : baseLineHeight;

  const desiredBoxHeight = actualTextHeight + contentPaddingY * 2;

  const contentBoxY = bodyTop;

  const safeBoxHeight = Math.min(desiredBoxHeight, availableBodyHeight);

  const textStartY = contentBoxY + contentPaddingY + fontSize * 0.9;

  const textLinesSvg = renderTextLinesSvg({
    lines,
    startX: textStartX,
    startY: textStartY,
    fontSize,
    lineHeightPx: baseLineHeight + lineGap,
    normalColor: textColor,
    accentColor,
    fontFamily: layout.fontFamily,
    maxRightX: textRightSafeX,
  });

  // ====================================================
  // AVATAR
  // ====================================================

  const avatarSvg = avatarDataUri
    ? `
        <clipPath id="avatarClip">
          <circle
            cx="78"
            cy="84"
            r="42"
          />
        </clipPath>

        <circle
          cx="78"
          cy="84"
          r="45"
          fill="rgba(255,255,255,0.96)"
          filter="url(#smallShadow)"
        />

        <image
          href="${avatarDataUri}"
          x="36"
          y="42"
          width="84"
          height="84"
          preserveAspectRatio="xMidYMid slice"
          clip-path="url(#avatarClip)"
        />
      `
    : "";

  // ====================================================
  // FOLLOW
  // ====================================================

  const followWidth = safeFollow
    ? Math.min(
        180,
        Math.max(
          112,
          getAdvanceTextWidth(safeFollow, layout.followFontSize) + 42,
        ),
      )
    : 0;

  const followHeight = 52;

  const followX = W - 36 - followWidth;

  const followY = 48;

  const followCenterX = followX + followWidth / 2;

  const followCenterY = followY + followHeight / 2;

  const followSvg = safeFollow
    ? `
        <rect
          x="${followX}"
          y="${followY}"
          width="${followWidth}"
          height="${followHeight}"
          rx="${followHeight / 2}"
          fill="rgba(255,255,255,0.96)"
          stroke="rgba(255,255,255,0.50)"
          stroke-width="1"
          filter="url(#smallShadow)"
        />

        <text
          x="${followCenterX}"
          y="${followCenterY}"
          text-anchor="middle"
          dominant-baseline="central"
          xml:space="preserve"
          style="white-space: pre;"
          font-family="${layout.fontFamily}"
          font-size="${layout.followFontSize}"
          font-weight="700"
          fill="#2563eb"
        >${escapeSvgText(safeFollow)}</text>
      `
    : "";

  /*
   * Cursor nằm chạm nhẹ phần trên của nút Follow.
   * Đã hạ xuống so với bản trước.
   */
  const followCursorSvg = safeFollow
    ? `
        <g
          transform="
            translate(
              ${followX + followWidth - 34},
              ${followY + 10}
            )
            scale(1.08)
          "
          filter="url(#cursorShadow)"
        >
          <path
            d="
              M2 1
              L2 23
              L8.2 17.2
              L12.2 26
              L17.1 23.7
              L13.1 15.3
              L21.4 15
              Z
            "
            fill="#ffffff"
            stroke="#111111"
            stroke-width="1.8"
            stroke-linejoin="round"
          />

          <path
            d="
              M2 1
              L2 23
              L8.2 17.2
            "
            fill="none"
            stroke="rgba(255,255,255,0.75)"
            stroke-width="0.7"
            stroke-linecap="round"
          />
        </g>
      `
    : "";

  // ====================================================
  // NAME
  // ====================================================

  const nameX = avatarDataUri ? 138 : 42;

  const nameMaxWidth = safeFollow ? followX - nameX - 24 : W - nameX - 42;

  let displayName = safeName;

  while (
    displayName &&
    getWrapTextWidth(displayName, layout.nameFontSize) > nameMaxWidth
  ) {
    displayName = displayName.slice(0, -1);
  }

  if (displayName && displayName !== safeName) {
    displayName = `${displayName.trim()}...`;
  }

  const nameSvg = displayName
    ? `
        <text
          x="${nameX}"
          y="85"
          dominant-baseline="central"
          xml:space="preserve"
          style="white-space: pre;"
          font-family="${layout.fontFamily}"
          font-size="${layout.nameFontSize}"
          font-weight="700"
          fill="${textColor}"
          stroke="rgba(0,0,0,0.60)"
          stroke-width="1.5"
          stroke-linejoin="round"
          paint-order="stroke fill"
        >${escapeSvgText(displayName)}</text>
      `
    : "";

  // ====================================================
  // CTA
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
          fill="rgba(8,8,8,0.66)"
          stroke="rgba(255,255,255,0.30)"
          stroke-width="1.5"
          filter="url(#mediumShadow)"
        />

        <text
          x="${W / 2}"
          y="${callCenterY}"
          text-anchor="middle"
          dominant-baseline="central"
          xml:space="preserve"
          style="white-space: pre;"
          font-family="${layout.fontFamily}"
          font-size="${layout.callFontSize}"
          font-weight="700"
          fill="${textColor}"
          stroke="rgba(0,0,0,0.52)"
          stroke-width="1"
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
        <style>
          @font-face {
            font-family: '${layout.fontFamily}';
            src: url('${fontDataUri}');
            font-weight: 700;
            font-style: normal;
          }
        </style>

        <filter
          id="contentShadow"
          x="-20%"
          y="-20%"
          width="140%"
          height="140%"
        >
          <feDropShadow
            dx="0"
            dy="6"
            stdDeviation="9"
            flood-color="#000000"
            flood-opacity="0.48"
          />
        </filter>

        <filter
          id="mediumShadow"
          x="-25%"
          y="-25%"
          width="150%"
          height="150%"
        >
          <feDropShadow
            dx="0"
            dy="5"
            stdDeviation="7"
            flood-color="#000000"
            flood-opacity="0.42"
          />
        </filter>

        <filter
          id="smallShadow"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
        >
          <feDropShadow
            dx="0"
            dy="3"
            stdDeviation="5"
            flood-color="#000000"
            flood-opacity="0.36"
          />
        </filter>

        <filter
          id="cursorShadow"
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
        >
          <feDropShadow
            dx="0"
            dy="2"
            stdDeviation="2.5"
            flood-color="#000000"
            flood-opacity="0.62"
          />
        </filter>
      </defs>

      ${
        hasHeader
          ? `
            <rect
              x="${headerOuterX}"
              y="${headerTop}"
              width="${W - headerOuterX * 2}"
              height="${headerHeight}"
              rx="30"
              fill="rgba(8,8,8,0.46)"
              stroke="rgba(255,255,255,0.18)"
              stroke-width="1.2"
              filter="url(#mediumShadow)"
            />

            ${avatarSvg}
            ${nameSvg}
            ${followSvg}
            ${followCursorSvg}
          `
          : ""
      }

      <rect
        x="${boxOuterX}"
        y="${contentBoxY}"
        width="${boxWidth}"
        height="${safeBoxHeight}"
        rx="28"
        fill="rgba(8,8,8,0.60)"
        stroke="rgba(255,255,255,0.18)"
        stroke-width="1.2"
        filter="url(#contentShadow)"
      />

      <rect
        x="${boxOuterX + 1}"
        y="${contentBoxY + 1}"
        width="${boxWidth - 2}"
        height="${Math.max(2, safeBoxHeight - 2)}"
        rx="27"
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        stroke-width="1"
      />

      ${textLinesSvg}

      ${callSvg}
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
    boxHeight: safeBoxHeight,
    maxTextWidth,
  };
}

// ======================================================
// COMMAND RUNNER
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
    throw new Error("Cannot determine background video duration");
  }

  return duration;
}

// ======================================================
// VIDEO RENDER
// ======================================================

async function renderVideo({
  backgroundPath,
  audioPath,
  overlayPath,
  outputPath,
  seconds,
}) {
  const hasRequestedDuration =
    Number.isFinite(Number(seconds)) && Number(seconds) > 0;

  const outputDuration = hasRequestedDuration
    ? Number(seconds)
    : await getVideoDuration(backgroundPath);

  /*
   * Input 0: video nền.
   * Input 1: overlay PNG.
   * Input 2: audio ngoài.
   *
   * Không map 0:a.
   * Audio gốc video nền luôn bị loại bỏ.
   */
  const filterComplex = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${OUTPUT_FPS},setsar=1,format=yuv420p[background]`,

    `[1:v]scale=${W}:${H},format=rgba[overlay]`,

    `[background][overlay]overlay=0:0:format=auto,fps=${OUTPUT_FPS},setsar=1,format=yuv420p[video]`,

    `[2:a]aresample=${OUTPUT_AUDIO_SAMPLE_RATE}:async=1:first_pts=0,volume=1[audio]`,
  ].join(";");

  const args = [
    "-y",

    "-stream_loop",
    "-1",
    "-i",
    backgroundPath,

    "-loop",
    "1",
    "-framerate",
    String(OUTPUT_FPS),
    "-i",
    overlayPath,

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

  await runCommand("ffmpeg", args, "render-video-story-overlay");

  if (!fs.existsSync(outputPath)) {
    throw new Error("FFmpeg did not create output video");
  }

  const stat = await fs.promises.stat(outputPath);

  if (!stat.size) {
    throw new Error("Output video is empty");
  }

  return {
    outputPath,
    duration: Number(outputDuration.toFixed(3)),
    sizeBytes: stat.size,
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
    backgroundUrl,
    audioUrl,
    content,
    language,
    call,
    name,
    avatar,
    follow,
    textColor,
    accentColor,
    whiteTextColor,
    yellowTextColor,
    seconds,
  } = job.payload;

  const tempDir = path.join(TEMP_ROOT, jobId);

  fs.mkdirSync(tempDir, {
    recursive: true,
  });

  const backgroundPath = path.join(tempDir, "background.mp4");

  const audioPath = path.join(tempDir, "external-audio");

  const avatarPath = path.join(tempDir, "avatar-source");

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
      message: "Đang tải video nền và audio...",
    });

    const downloadTasks = [
      downloadFile(backgroundUrl, backgroundPath),

      downloadFile(audioUrl, audioPath),
    ];

    if (avatar && typeof avatar === "string" && avatar.trim()) {
      downloadTasks.push(downloadFile(avatar.trim(), avatarPath));
    }

    await Promise.all(downloadTasks);

    setJob(jobId, {
      progress: 35,
      step: "create-overlay",
      message: "Đang tạo overlay text...",
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

      avatarPath: avatar && fs.existsSync(avatarPath) ? avatarPath : null,

      content,
      languageType,
      call,
      name,
      follow,
      textColor: finalTextColor,
      accentColor: finalAccentColor,
    });

    setJob(jobId, {
      progress: 55,
      step: "render-video",
      message: "Đang ghép video, overlay và audio...",
    });

    const renderResult = await renderVideo({
      backgroundPath,
      audioPath,
      overlayPath,
      outputPath,
      seconds,
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

        duration: renderResult.duration,

        outputSizeBytes: renderResult.sizeBytes,

        fps: OUTPUT_FPS,
        crf: OUTPUT_CRF,
        preset: OUTPUT_PRESET,

        language: overlayResult.language,

        lineCount: overlayResult.lineCount,

        bodyFontSize: overlayResult.bodyFontSize,

        maxTextWidth: overlayResult.maxTextWidth,

        originalBackgroundAudio: "removed",

        audioSource: "audioUrl",

        audioLooped: true,

        backgroundVideoLooped: true,

        layout: "vertical video + rounded text overlay + external audio",
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
    console.error(`Video story job failed ${jobId}:`, error.message);
  }
}

// ======================================================
// POST /
// ======================================================

router.post("/", async (req, res) => {
  const {
    backgroundUrl,
    audioUrl,
    content,
    language,
    call,
    name,
    avatar,
    follow,

    textColor,
    accentColor,

    whiteTextColor,
    yellowTextColor,

    seconds,
  } = req.body || {};

  if (
    !backgroundUrl ||
    typeof backgroundUrl !== "string" ||
    !backgroundUrl.trim()
  ) {
    return res.status(400).json({
      success: false,
      error: "backgroundUrl is required",
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

  if (avatar != null && typeof avatar !== "string") {
    return res.status(400).json({
      success: false,
      error: "avatar must be a string",
    });
  }

  const job = createJob({
    backgroundUrl: backgroundUrl.trim(),

    audioUrl: audioUrl.trim(),

    content: content.trim(),

    language: language || null,

    call: typeof call === "string" ? call : "",

    name: typeof name === "string" ? name : "",

    avatar: typeof avatar === "string" ? avatar : "",

    follow: typeof follow === "string" ? follow : "",

    textColor,
    accentColor,
    whiteTextColor,
    yellowTextColor,

    seconds: seconds != null ? Number(seconds) : null,
  });

  console.log("\n╔══════════════════════════════════════════════════════╗");

  console.log(`║ 🎬 VIDEO STORY Job: ${job.id}`);

  console.log(`║ 🎞️ Background: ${backgroundUrl.trim().substring(0, 60)}`);

  console.log(`║ 🎵 Audio: ${audioUrl.trim().substring(0, 60)}`);

  console.log("║ 🔇 Original background audio: REMOVED");

  console.log(
    `║ ⏱️ Seconds: ${
      seconds != null ? Number(seconds) : "AUTO_FROM_BACKGROUND"
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

    pollUrl: `/api/video-story-overlay/${job.id}`,
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

  return res.json({
    success: true,
    message: "Job deleted",
  });
});

module.exports = router;
module.exports.jobs = jobs;
