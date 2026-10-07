const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");

const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

// =========================================================
// UPLOAD
// =========================================================

// const { uploadVideo } = require("../utils/uploadService");

const { uploadVideo } = require("../utils/uploadTempVideo");

// const { uploadVideo } = require("../utils/uploadVps");

const pipelineAsync = promisify(pipeline);

const router = express.Router();

// =========================================================
// CONFIG
// =========================================================

const DEFAULT_W = 720;
const DEFAULT_H = 1280;

const OUTPUT_FPS = 30;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";

const COMMAND_LOG_TAIL_CHARS = 20000;

const DEFAULT_SECONDS = 15;

// =========================================================
// BODY TYPOGRAPHY
// =========================================================
//
// Giữ font size 27.
// Không giảm font.
//
// Fix VPS bằng:
// - padding phải lớn hơn
// - wrap sớm hơn
// - PNG body rộng hơn vùng wrap thật
// =========================================================

const BODY_FONT_SIZE = 27;

const BODY_LINE_HEIGHT = 36;

const BODY_LETTER_SPACING = -0.35;

/*
 * Text sẽ xuống dòng sớm hơn 64px.
 *
 * Đây KHÔNG phải padding thật của PNG.
 * Nó chỉ dùng để quyết định khi nào xuống dòng.
 */
const BODY_WRAP_SAFETY = 64;

/*
 * Padding nhìn thấy của body.
 */
const BODY_PADDING_LEFT = 32;
const BODY_PADDING_RIGHT = 44;

const JP_BODY_PADDING_RIGHT = 24;
const JP_BODY_WRAP_SAFETY = 4;
const JP_MAX_CONTENT_CHARS = 360;

// =========================================================
// PATHS
// =========================================================

const TEMP_DIR = path.join(__dirname, "..", "temp");

const BG_VIDEO_FILE = path.join(__dirname, "..", "us.mp4");

const FALLBACK_AUDIO_DIR = path.join(__dirname, "..", "demo", "audio");

const FONT_FILE = path.join(__dirname, "..", "fonts", "Arial Bold.ttf");
const JP_FONT_FILE = path.join(__dirname, "..", "fonts", "NotoSansJP-Bold.otf");

const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg"];

const DEFAULT_FONT_FAMILY = "Arial";
const JP_FONT_FAMILY = "AutoLinkJP";

const FONT_DATA_URI_CACHE = new Map();

// =========================================================
// FIXED AUDIO
// =========================================================

const FIXED_AUDIO_LINKS = [
  "https://video.xopboo.com/media/crystaline-quincas-moreira_1.mp3",
  "https://video.xopboo.com/media/frame-dragging-the-grey-room-density-time.mp3",
  "https://video.xopboo.com/media/atlasaudio-instrumental-519455.mp3",
  "https://video.xopboo.com/media/kulakovka-military-283165.mp3",
  "https://video.xopboo.com/media/nh-c-tin-tuc.mp3",
  "https://video.xopboo.com/media/nh-c-chi-n-tranh.mp3",
];

// =========================================================
// COLORS
// =========================================================

const COLOR_WHITE = "#f3f3f3";
const COLOR_HIGHLIGHT = "#f0d400";

const COLOR_TITLE_BG = "#e4c400";
const COLOR_TITLE_TEXT = "#ffffff";

const COLOR_CONTENT_BG = "#121416";

// =========================================================
// INIT
// =========================================================

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true,
  });
}

// =========================================================
// BASIC HELPERS
// =========================================================

function generateJobId() {
  return `story_card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function q(filePath) {
  return `"${filePath}"`;
}

function makeEven(value) {
  return Math.max(2, Math.round(Number(value) / 2) * 2);
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
    console.warn(`⚠️ Cleanup failed: ${error.message}`);
  }
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

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fontFileToDataUri(fontPath) {
  if (!fontPath) {
    return "";
  }

  const cached = FONT_DATA_URI_CACHE.get(fontPath);

  if (cached) {
    return cached;
  }

  const buffer = await fs.promises.readFile(fontPath);
  const extension = path.extname(fontPath).toLowerCase();
  const mime = extension === ".otf" ? "font/otf" : "font/ttf";
  const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;

  FONT_DATA_URI_CACHE.set(fontPath, dataUri);

  return dataUri;
}

async function createSvgFontFace({ fontFamily, fontFile }) {
  if (!fontFile) {
    return "";
  }

  const dataUri = await fontFileToDataUri(fontFile);

  return `
    <defs>
      <style>
        @font-face {
          font-family: '${fontFamily}';
          src: url('${dataUri}') format('opentype');
          font-weight: 700;
          font-style: normal;
        }
      </style>
    </defs>
  `;
}

function containsJapanese(text = "") {
  return /[\u3040-\u30ff\u31f0-\u31ff]/.test(String(text || ""));
}

function containsCjk(text = "") {
  return /[\u3000-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uff00-\uffef]/.test(
    String(text || ""),
  );
}

function isCjkCharacter(character) {
  return /[\u3000-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u9fff\uff00-\uffef]/.test(
    character,
  );
}

function isNoLineStartPunctuation(character) {
  return /^[、。，．｡､）」』】〕〉》!?！？:：;；]$/.test(
    String(character || ""),
  );
}

function normalizeLanguage(language, sampleText = "") {
  const value = String(language || "")
    .trim()
    .toLowerCase();

  if (["jp", "ja", "japan", "japanese", "nhật", "nhat"].includes(value)) {
    return "jp";
  }

  if (containsJapanese(sampleText) || containsCjk(sampleText)) {
    return "jp";
  }

  return "default";
}

function getTypographyByLanguage(languageType) {
  if (languageType === "jp") {
    return {
      fontFamily: JP_FONT_FAMILY,
      fontFile: JP_FONT_FILE,
      bodyFontSize: 30,
      bodyLineHeight: 44,
      bodyLetterSpacing: 0,
      bodyPaddingRight: JP_BODY_PADDING_RIGHT,
      bodyWrapSafety: JP_BODY_WRAP_SAFETY,
      maxContentChars: JP_MAX_CONTENT_CHARS,
      titleFontSize: 27,
      titleLineHeight: 36,
    };
  }

  return {
    fontFamily: DEFAULT_FONT_FAMILY,
    fontFile: null,
    bodyFontSize: BODY_FONT_SIZE,
    bodyLineHeight: BODY_LINE_HEIGHT,
    bodyLetterSpacing: BODY_LETTER_SPACING,
    bodyPaddingRight: BODY_PADDING_RIGHT,
    bodyWrapSafety: BODY_WRAP_SAFETY,
    maxContentChars: null,
    titleFontSize: 28,
    titleLineHeight: 34,
  };
}

// =========================================================
// COMMAND
// =========================================================

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

      console.error(`[${label}] failed with exit code ${code}`);

      if (stderr.trim()) {
        console.error(stderr);
      }

      reject(new Error(`[${label}] ${stderr || `exit code ${code}`}`));
    });
  });
}

// =========================================================
// DOWNLOAD
// =========================================================

async function downloadFile(url, destPath) {
  const response = await axios.get(url, {
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

  await pipelineAsync(response.data, fs.createWriteStream(destPath));

  return destPath;
}

// =========================================================
// AUDIO
// =========================================================

function getMediaFilesFromDir(dirPath, allowedExtensions) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath)
    .filter((fileName) => {
      const fullPath = path.join(dirPath, fileName);

      const ext = path.extname(fileName).toLowerCase();

      return fs.statSync(fullPath).isFile() && allowedExtensions.includes(ext);
    })
    .map((fileName) => path.join(dirPath, fileName));
}

function pickRandomItem(items) {
  if (!items.length) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function pickRandomAudioLink() {
  const links = FIXED_AUDIO_LINKS.map((link) =>
    String(link || "").trim(),
  ).filter(isHttpUrl);

  return pickRandomItem(links);
}

function pickRandomFallbackAudio() {
  const files = getMediaFilesFromDir(FALLBACK_AUDIO_DIR, AUDIO_EXTENSIONS);

  return pickRandomItem(files);
}

// =========================================================
// LIMIT CONTENT
// =========================================================

function getTextStats(text, languageType = "default") {
  const clean = normalizeText(text);
  const words = clean ? clean.split(/\s+/).filter(Boolean) : [];
  const characters = Array.from(clean.replace(/\s/g, ""));

  if (languageType === "jp") {
    return {
      countMode: "characters",
      words: words.length,
      characters: characters.length,
      displayUnits: characters.length,
    };
  }

  return {
    countMode: "words",
    words: words.length,
    characters: characters.length,
    displayUnits: words.length,
  };
}

function clampStoryContentByLanguage({
  text,
  languageType = "default",
  maxWords = 120,
  maxCharacters = JP_MAX_CONTENT_CHARS,
}) {
  const clean = normalizeText(text);

  if (!clean) {
    return "";
  }

  if (languageType === "jp") {
    const characters = Array.from(clean);

    if (characters.length <= maxCharacters) {
      return clean;
    }

    return `${characters
      .slice(0, maxCharacters)
      .join("")
      .replace(/[、。！？\s]+$/u, "")
      .trim()}...`;
  }

  const words = clean.split(/\s+/).filter(Boolean);

  if (words.length <= maxWords) {
    return clean;
  }

  return words.slice(0, maxWords).join(" ").trim();
}

// =========================================================
// SPLIT SENTENCES
// =========================================================

function splitSentences(text, languageType = "default") {
  const clean = normalizeText(text);

  if (!clean) {
    return [];
  }

  const sentencePattern =
    languageType === "jp" ? /[^.!?。！？]+[.!?。！？]?/g : /[^.]+\.?/g;

  const matches = clean.match(sentencePattern) || [];

  return matches.map((item) => item.trim()).filter(Boolean);
}

// =========================================================
// WIDTH ESTIMATION
// =========================================================
//
// Chỉ dùng để quyết định xuống dòng.
//
// Không dùng để đặt X giữa các segment màu.
// =========================================================

function estimateTextWidthPx(text, fontSize, letterSpacing = 0) {
  const value = String(text || "");

  let width = 0;

  for (const char of value) {
    if (char === " ") {
      width += fontSize * 0.33;
    } else if (isCjkCharacter(char)) {
      width += fontSize;
    } else if (/[ilI1.,'":;!|]/.test(char)) {
      width += fontSize * 0.29;
    } else if (/[mwMW@%&#]/.test(char)) {
      width += fontSize * 0.92;
    } else if (/[A-Z]/.test(char)) {
      width += fontSize * 0.67;
    } else if (/[0-9]/.test(char)) {
      width += fontSize * 0.57;
    } else {
      width += fontSize * 0.54;
    }
  }

  const spacingCount = Math.max(0, value.length - 1);

  width += spacingCount * letterSpacing;

  /*
   * Safety estimate.
   */
  return width * (containsCjk(value) ? 1 : 1.03);
}

// =========================================================
// TITLE
// =========================================================
//
// Tối đa 2 dòng.
// Nếu còn text thì thêm ...
// =========================================================

function buildTitleLines({ title, maxWidth, fontSize }) {
  const clean = normalizeText(title);

  if (!clean) {
    return [];
  }

  if (containsCjk(clean)) {
    const units = Array.from(clean);
    const lines = [];
    let currentLine = "";
    let index = 0;

    while (index < units.length && lines.length < 2) {
      const unit = units[index];

      if (/\s/.test(unit) && !currentLine) {
        index += 1;
        continue;
      }

      const candidate = currentLine + unit;

      if (
        estimateTextWidthPx(candidate, fontSize, 0) <= maxWidth ||
        isNoLineStartPunctuation(unit)
      ) {
        currentLine = candidate;
        index += 1;
        continue;
      }

      if (currentLine) {
        lines.push(currentLine.trimEnd());
        currentLine = "";
        continue;
      }

      lines.push(`${unit}...`);
      index += 1;
    }

    if (currentLine && lines.length < 2) {
      lines.push(currentLine.trimEnd());
    }

    if (index < units.length && lines.length > 0) {
      const lastIndex = lines.length - 1;
      let lastLine = lines[lastIndex];

      while (
        lastLine &&
        estimateTextWidthPx(`${lastLine}...`, fontSize, 0) > maxWidth
      ) {
        lastLine = Array.from(lastLine).slice(0, -1).join("");
      }

      lines[lastIndex] = lastLine
        ? `${lastLine.replace(/[ .,!?:;"'”’)-。！？、]+$/, "").trim()}...`
        : "...";
    }

    return lines.slice(0, 2);
  }

  const words = clean.split(/\s+/).filter(Boolean);

  const lines = [];

  let currentLine = "";
  let index = 0;

  while (index < words.length && lines.length < 2) {
    const word = words[index];

    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (estimateTextWidthPx(candidate, fontSize, 0) <= maxWidth) {
      currentLine = candidate;

      index += 1;

      continue;
    }

    if (currentLine) {
      lines.push(currentLine);

      currentLine = "";

      continue;
    }

    /*
     * Safety nếu một word
     * tự nó rộng hơn cả box.
     */
    let safeWord = "";

    for (const char of word) {
      const next = safeWord + char;

      if (estimateTextWidthPx(`${next}...`, fontSize, 0) > maxWidth) {
        break;
      }

      safeWord = next;
    }

    lines.push(`${safeWord}...`);

    index += 1;
  }

  if (currentLine && lines.length < 2) {
    lines.push(currentLine);
  }

  const hasRemainingWords = index < words.length;

  /*
   * Nếu còn title chưa hiển thị
   * thì thêm ... ở dòng thứ 2.
   */
  if (hasRemainingWords && lines.length > 0) {
    const lastIndex = lines.length - 1;

    let lastLine = lines[lastIndex];

    while (
      lastLine &&
      estimateTextWidthPx(`${lastLine}...`, fontSize, 0) > maxWidth
    ) {
      const parts = lastLine.split(/\s+/).filter(Boolean);

      parts.pop();

      lastLine = parts.join(" ");
    }

    lines[lastIndex] = lastLine
      ? `${lastLine.replace(/[ .,!?:;"'”’)-]+$/, "").trim()}...`
      : "...";
  }

  return lines.slice(0, 2);
}

function tokenizeBodySentence(sentence) {
  const value = String(sentence || "");

  if (!containsCjk(value)) {
    return value
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => ({
        text: word,
        isSpace: false,
        prependSpace: true,
      }));
  }

  const tokens = [];
  let buffer = "";

  function flushBuffer() {
    const words = buffer.split(/\s+/).filter(Boolean);

    for (const word of words) {
      tokens.push({
        text: word,
        isSpace: false,
        prependSpace: false,
      });
    }

    buffer = "";
  }

  for (const character of Array.from(value)) {
    if (/\s/.test(character)) {
      flushBuffer();

      tokens.push({
        text: " ",
        isSpace: true,
        prependSpace: false,
      });

      continue;
    }

    if (isCjkCharacter(character)) {
      flushBuffer();

      tokens.push({
        text: character,
        isSpace: false,
        prependSpace: false,
      });

      continue;
    }

    buffer += character;
  }

  flushBuffer();

  return tokens;
}

// =========================================================
// BODY LAYOUT
// =========================================================
//
// Body chạy như một paragraph liên tục.
//
// Sentence 1: trắng
// Sentence 2: vàng
// Sentence 3: trắng
// ...
//
// Không bắt buộc xuống dòng sau dấu ".".
// =========================================================

function buildContinuousBodyLines({
  content,
  maxWidth,
  fontSize,
  letterSpacing,
  languageType = "default",
}) {
  const sentences = splitSentences(content, languageType);

  const lines = [];

  let currentLine = [];

  let currentWidth = 0;

  function pushLine() {
    if (currentLine.length === 0) {
      return;
    }

    lines.push(currentLine);

    currentLine = [];

    currentWidth = 0;
  }

  for (
    let sentenceIndex = 0;
    sentenceIndex < sentences.length;
    sentenceIndex += 1
  ) {
    const sentence = sentences[sentenceIndex];

    const color = sentenceIndex % 2 === 0 ? COLOR_WHITE : COLOR_HIGHLIGHT;

    const tokens = tokenizeBodySentence(sentence);

    for (const token of tokens) {
      if (token.isSpace) {
        if (currentLine.length === 0) {
          continue;
        }

        const lastSegment = currentLine[currentLine.length - 1];

        if (lastSegment?.text?.endsWith(" ")) {
          continue;
        }

        const spaceWidth = estimateTextWidthPx(" ", fontSize, letterSpacing);

        if (currentWidth + spaceWidth > maxWidth) {
          pushLine();
          continue;
        }

        if (lastSegment && lastSegment.color === color) {
          lastSegment.text += " ";
        } else {
          currentLine.push({
            text: " ",
            color,
            sentenceIndex,
          });
        }

        currentWidth += spaceWidth;
        continue;
      }

      const shouldPrependSpace = token.prependSpace && currentLine.length > 0;

      let text = shouldPrependSpace ? ` ${token.text}` : token.text;

      let width = estimateTextWidthPx(text, fontSize, letterSpacing);

      /*
       * Nếu token mới vượt safe wrap width,
       * xuống dòng trước khi thêm.
       */
      if (
        currentLine.length > 0 &&
        currentWidth + width > maxWidth &&
        !isNoLineStartPunctuation(token.text)
      ) {
        pushLine();

        /*
         * Đầu dòng mới:
         * không có leading space.
         */
        text = token.text;

        width = estimateTextWidthPx(text, fontSize, letterSpacing);
      }

      const lastSegment = currentLine[currentLine.length - 1];

      /*
       * Nếu cùng màu,
       * nối vào cùng tspan.
       */
      if (lastSegment && lastSegment.color === color) {
        lastSegment.text += text;
      } else {
        currentLine.push({
          text,
          color,
          sentenceIndex,
        });
      }

      currentWidth += width;
    }
  }

  pushLine();

  return lines;
}

// =========================================================
// CREATE ROUNDED TITLE BACKGROUND
// =========================================================

async function createRoundedTitleBox({
  outputPath,
  width,
  height,
  radius = 18,
  color = COLOR_TITLE_BG,
}) {
  const safeWidth = Math.max(2, Math.round(width));

  const safeHeight = Math.max(2, Math.round(height));

  const svg = `
    <svg
      width="${safeWidth}"
      height="${safeHeight}"
      viewBox="0 0 ${safeWidth} ${safeHeight}"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect
        x="0"
        y="0"
        width="${safeWidth}"
        height="${safeHeight}"
        rx="${radius}"
        ry="${radius}"
        fill="${color}"
      />
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to create rounded title box");
  }

  return outputPath;
}

// =========================================================
// CREATE BODY PNG
// =========================================================
//
// QUAN TRỌNG:
//
// width:
//   chiều rộng thật của PNG.
//
// wrapWidth:
//   vùng thực tế được phép chứa text.
//
// width > wrapWidth.
//
// Nhờ vậy text xuống dòng trước,
// nhưng PNG vẫn còn buffer trong suốt bên phải.
// =========================================================

async function createBodyOverlay({
  outputPath,
  content,
  width,

  wrapWidth = width,

  fontSize = BODY_FONT_SIZE,

  lineHeight = BODY_LINE_HEIGHT,

  letterSpacing = BODY_LETTER_SPACING,

  fontFamily = DEFAULT_FONT_FAMILY,

  fontFile = null,

  languageType = "default",
}) {
  /*
   * Chỉ dùng wrapWidth để quyết định line.
   */
  const lines = buildContinuousBodyLines({
    content,

    maxWidth: wrapWidth,

    fontSize,

    letterSpacing,

    languageType,
  });

  const paddingTop = 5;

  const paddingBottom = 10;

  const height = Math.max(
    lineHeight,

    paddingTop + lines.length * lineHeight + paddingBottom,
  );

  const svgLines = lines
    .map((segments, lineIndex) => {
      const y = paddingTop + fontSize + lineIndex * lineHeight;

      const tspans = segments
        .map((segment) => {
          return (
            `<tspan ` +
            `fill="${segment.color}" ` +
            `xml:space="preserve">` +
            `${escapeXml(segment.text)}` +
            `</tspan>`
          );
        })
        .join("");

      return (
        `<text ` +
        `x="0" ` +
        `y="${y}" ` +
        `font-family="${fontFamily}" ` +
        `font-size="${fontSize}" ` +
        `font-weight="700" ` +
        `letter-spacing="${letterSpacing}px" ` +
        `xml:space="preserve">` +
        `${tspans}` +
        `</text>`
      );
    })
    .join("");

  const fontFaceSvg = await createSvgFontFace({
    fontFamily,
    fontFile,
  });

  /*
   * SVG/PNG vẫn có WIDTH LỚN.
   *
   * Đây là điểm khác biệt quan trọng:
   * text wrapWidth nhỏ,
   * PNG width lớn.
   */
  const svg = `
    <svg
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}"
      xmlns="http://www.w3.org/2000/svg"
    >
      ${fontFaceSvg}
      ${svgLines}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to create body overlay");
  }

  return {
    outputPath,

    width,

    wrapWidth,

    height,

    lineCount: lines.length,
  };
}

async function createTitleTextOverlay({
  outputPath,
  lines,
  width,
  height,
  fontSize,
  lineHeight,
  paddingY,
  fontFamily,
  fontFile = null,
}) {
  const safeWidth = Math.max(2, Math.round(width));
  const safeHeight = Math.max(2, Math.round(height));
  const centerX = safeWidth / 2;

  const svgLines = lines
    .map((line, index) => {
      const y = paddingY + fontSize * 0.95 + index * lineHeight;

      return (
        `<text ` +
        `x="${centerX}" ` +
        `y="${y}" ` +
        `text-anchor="middle" ` +
        `font-family="${fontFamily}" ` +
        `font-size="${fontSize}" ` +
        `font-weight="700" ` +
        `fill="${COLOR_TITLE_TEXT}" ` +
        `stroke="rgba(0,0,0,0.35)" ` +
        `stroke-width="1.2" ` +
        `stroke-linejoin="round" ` +
        `paint-order="stroke fill" ` +
        `xml:space="preserve">` +
        `${escapeXml(line)}` +
        `</text>`
      );
    })
    .join("");

  const fontFaceSvg = await createSvgFontFace({
    fontFamily,
    fontFile,
  });

  const svg = `
    <svg
      width="${safeWidth}"
      height="${safeHeight}"
      viewBox="0 0 ${safeWidth} ${safeHeight}"
      xmlns="http://www.w3.org/2000/svg"
    >
      ${fontFaceSvg}
      ${svgLines}
    </svg>
  `;

  await sharp(Buffer.from(svg)).png().toFile(outputPath);

  if (!fs.existsSync(outputPath)) {
    throw new Error("Failed to create title text overlay");
  }

  return outputPath;
}

// =========================================================
// TITLE FILTERS
// =========================================================

function buildTitleFilters({
  title,
  tempDir,
  cardX,
  cardW,
  imageBottomY,
  typography,
  useTitlePng = false,
}) {
  const filters = [];

  const titleFontSize = typography.titleFontSize;

  const titleLineHeight = typography.titleLineHeight;

  const titlePaddingY = 10;

  /*
   * Title box gần full card.
   */
  const titleBoxX = cardX + 4;

  const titleBoxW = cardW - 8;

  /*
   * Padding text title.
   */
  const titleTextPaddingX = 18;

  const titleTextMaxWidth = titleBoxW - titleTextPaddingX * 2;

  const titleLines = buildTitleLines({
    title,

    maxWidth: titleTextMaxWidth,

    fontSize: titleFontSize,
  });

  const titleBoxH = titleLines.length * titleLineHeight + titlePaddingY * 2;

  /*
   * Chỉ overlap thumbnail 2px.
   */
  const titleBoxY = imageBottomY - 2;

  const fontPath = escapeFilterPath(FONT_FILE);

  if (!useTitlePng) {
    titleLines.forEach((line, index) => {
      const txtPath = path.join(tempDir, `title_${index}.txt`);

      fs.writeFileSync(
        txtPath,

        normalizeForTextfile(line),

        "utf8",
      );

      const textPath = escapeFilterPath(txtPath);

      const y = titleBoxY + titlePaddingY + index * titleLineHeight;

      filters.push(
        `drawtext=` +
          `fontfile='${fontPath}':` +
          `textfile='${textPath}':` +
          `reload=0:` +
          `fontcolor=${COLOR_TITLE_TEXT}:` +
          `fontsize=${titleFontSize}:` +
          `x=${titleBoxX}+(${titleBoxW}-text_w)/2:` +
          `y=${y}:` +
          `bordercolor=black@0.35:` +
          `borderw=1`,
      );
    });
  }

  return {
    filters,

    titleLines,

    titleBoxX,

    titleBoxY,

    titleBoxW,

    titleBoxH,

    titleFontSize,

    titleLineHeight,

    titlePaddingY,
  };
}

// =========================================================
// RENDER STORY CARD
// =========================================================

async function renderStoryCard({
  imagePath,
  audioPath,
  title,
  content,
  outputPath,
  tempDir,
  seconds,
  languageType = "default",
}) {
  const canvasW = DEFAULT_W;

  const canvasH = DEFAULT_H;

  const typography = getTypographyByLanguage(languageType);

  const useTitlePng = languageType === "jp";

  // =====================================================
  // MAIN CARD
  // =====================================================

  const outerMarginX = 14;

  const cardX = outerMarginX;

  const cardW = canvasW - outerMarginX * 2;

  const cardY = 30;

  // =====================================================
  // THUMBNAIL 16:9
  // =====================================================

  const imageW = cardW;

  const imageH = makeEven((imageW * 9) / 16);

  const imageBottomY = cardY + imageH;

  // =====================================================
  // CONTENT PANEL
  // =====================================================

  const cardBottom = canvasH - 40;

  const contentPanelY = imageBottomY;

  const contentPanelH = cardBottom - contentPanelY;

  // =====================================================
  // CONTENT
  // =====================================================

  const clippedContent = clampStoryContentByLanguage({
    text: content,
    languageType,
    maxCharacters: typography.maxContentChars || JP_MAX_CONTENT_CHARS,
  });

  const contentStats = getTextStats(clippedContent, languageType);

  // =====================================================
  // TITLE
  // =====================================================

  const titleLayout = buildTitleFilters({
    title,

    tempDir,

    cardX,

    cardW,

    imageBottomY,

    typography,

    useTitlePng,
  });

  const {
    filters: titleTextFilters,

    titleLines,

    titleBoxX,

    titleBoxY,

    titleBoxW,

    titleBoxH,

    titleFontSize,

    titleLineHeight,

    titlePaddingY,
  } = titleLayout;

  const hasTitle = titleLines.length > 0;

  // =====================================================
  // TITLE BACKGROUND
  // =====================================================

  const roundedTitlePath = path.join(tempDir, "rounded-title.png");

  if (hasTitle) {
    await createRoundedTitleBox({
      outputPath: roundedTitlePath,

      width: titleBoxW,

      height: titleBoxH,

      radius: 18,

      color: COLOR_TITLE_BG,
    });
  }

  const titleTextPath = path.join(tempDir, "title-text.png");

  if (hasTitle && useTitlePng) {
    await createTitleTextOverlay({
      outputPath: titleTextPath,

      lines: titleLines,

      width: titleBoxW,

      height: titleBoxH,

      fontSize: titleFontSize,

      lineHeight: titleLineHeight,

      paddingY: titlePaddingY,

      fontFamily: typography.fontFamily,

      fontFile: typography.fontFile,
    });
  }

  // =====================================================
  // BODY SETTINGS
  // =====================================================

  const contentFontSize = typography.bodyFontSize;

  const contentLineHeight = typography.bodyLineHeight;

  const contentLetterSpacing = typography.bodyLetterSpacing;

  const contentPaddingX = BODY_PADDING_LEFT;

  const contentRightPadding = typography.bodyPaddingRight;

  /*
   * Vị trí bắt đầu body.
   */
  const contentX = cardX + contentPaddingX;

  /*
   * =====================================================
   * PNG WIDTH
   * =====================================================
   *
   * KHÔNG trừ padding phải ở đây.
   *
   * PNG được phép kéo dài tới mép phải card.
   *
   * Với:
   *
   * cardW = 692
   * left = 32
   *
   * contentPngWidth = 660
   */
  const contentPngWidth = cardW - contentPaddingX;

  /*
   * =====================================================
   * SAFE WRAP WIDTH
   * =====================================================
   *
   * Nhưng text thực tế chỉ được phép dùng:
   *
   * contentPngWidth
   * - right padding
   * - safety
   *
   * Ví dụ:
   *
   * 660
   * - 44
   * - 64
   * = 552px
   *
   * => xuống dòng sớm đáng kể
   * => có nhiều buffer bên phải
   * => tận dụng phần đen phía dưới.
   */
  const contentWrapSafety = typography.bodyWrapSafety;

  const contentWrapWidth = Math.max(
    100,

    contentPngWidth - contentRightPadding - contentWrapSafety,
  );

  /*
   * Nếu có title, body nằm ngay dưới title.
   * Nếu không có title, body bắt đầu ngay dưới thumbnail.
   */
  const contentY = hasTitle ? titleBoxY + titleBoxH + 18 : imageBottomY + 22;

  // =====================================================
  // CREATE BODY PNG
  // =====================================================

  const bodyOverlayPath = path.join(tempDir, "body-overlay.png");

  const bodyOverlay = await createBodyOverlay({
    outputPath: bodyOverlayPath,

    content: clippedContent,

    /*
     * PNG thật rộng.
     */
    width: contentPngWidth,

    /*
     * Text wrap trong vùng nhỏ hơn.
     */
    wrapWidth: contentWrapWidth,

    fontSize: contentFontSize,

    lineHeight: contentLineHeight,

    letterSpacing: contentLetterSpacing,

    fontFamily: typography.fontFamily,

    fontFile: typography.fontFile,

    languageType,
  });

  // =====================================================
  // FILTER
  //
  // 0 = background
  // 1 = thumbnail
  // Các input còn lại được cấp index theo đúng thứ tự push vào cmdParts.
  // =====================================================

  let nextInputIndex = 2;

  const titleBgInputIndex = hasTitle ? nextInputIndex++ : null;

  const bodyInputIndex = nextInputIndex++;

  const titleTextInputIndex = hasTitle && useTitlePng ? nextInputIndex++ : null;

  const filterParts = [
    /*
     * BACKGROUND
     */
    `[0:v]` +
      `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
      `crop=${canvasW}:${canvasH},` +
      `fps=${OUTPUT_FPS},` +
      `setpts=N/(${OUTPUT_FPS}*TB),` +
      `setsar=1,` +
      `format=yuv420p` +
      `[bg]`,

    /*
     * THUMBNAIL
     */
    `[1:v]` +
      `scale=${imageW}:${imageH}:force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${imageW}:${imageH},` +
      `setsar=1` +
      `[thumb]`,

    /*
     * BODY PNG
     */
    `[${bodyInputIndex}:v]` + `format=rgba` + `[bodypng]`,

    /*
     * BLACK PANEL
     */
    `[bg]` +
      `drawbox=` +
      `x=${cardX}:` +
      `y=${contentPanelY}:` +
      `w=${cardW}:` +
      `h=${contentPanelH}:` +
      `color=${COLOR_CONTENT_BG}:` +
      `t=fill` +
      `[panel]`,

    /*
     * THUMBNAIL
     */
    `[panel][thumb]` + `overlay=${cardX}:${cardY}:format=auto` + `[withthumb]`,
  ];

  if (hasTitle) {
    filterParts.push(
      /*
       * TITLE BACKGROUND
       */
      `[${titleBgInputIndex}:v]` + `format=rgba` + `[titlebg]`,

      /*
       * TITLE BG
       */
      `[withthumb][titlebg]` +
        `overlay=${titleBoxX}:${titleBoxY}:format=auto` +
        `[withtitlebg]`,

      /*
       * BODY
       */
      `[withtitlebg][bodypng]` +
        `overlay=${contentX}:${contentY}:format=auto` +
        `[withbody]`,
    );

    if (useTitlePng) {
      filterParts.push(
        /*
         * TITLE TEXT PNG
         */
        `[${titleTextInputIndex}:v]` + `format=rgba` + `[titletext]`,

        `[withbody][titletext]` +
          `overlay=${titleBoxX}:${titleBoxY}:format=auto,` +
          `fps=${OUTPUT_FPS},` +
          `format=yuv420p,` +
          `setpts=N/(${OUTPUT_FPS}*TB)` +
          `[v]`,
      );
    } else {
      filterParts.push(
        /*
         * TITLE TEXT
         */
        `[withbody]` +
          `${titleTextFilters.join(",")},` +
          `fps=${OUTPUT_FPS},` +
          `format=yuv420p,` +
          `setpts=N/(${OUTPUT_FPS}*TB)` +
          `[v]`,
      );
    }
  } else {
    filterParts.push(
      /*
       * BODY
       */
      `[withthumb][bodypng]` +
        `overlay=${contentX}:${contentY}:format=auto` +
        `[withbody]`,

      `[withbody]` +
        `fps=${OUTPUT_FPS},` +
        `format=yuv420p,` +
        `setpts=N/(${OUTPUT_FPS}*TB)` +
        `[v]`,
    );
  }

  const filterFile = path.join(tempDir, "story_card_filter.txt");

  fs.writeFileSync(
    filterFile,

    filterParts.join(";"),

    "utf8",
  );

  // =====================================================
  // FFMPEG INPUTS
  // =====================================================

  const cmdParts = [
    `ffmpeg -y`,

    /*
     * 0 = background
     */
    `-stream_loop -1 -i ${q(BG_VIDEO_FILE)}`,

    /*
     * 1 = thumbnail
     */
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(imagePath)}`,
  ];

  if (hasTitle) {
    cmdParts.push(
      /*
       * 2 = title background
       */
      `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(roundedTitlePath)}`,
    );
  }

  cmdParts.push(
    /*
     * 2/3 = body PNG
     */
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(bodyOverlayPath)}`,
  );

  if (hasTitle && useTitlePng) {
    cmdParts.push(
      /*
       * title text PNG.
       */
      `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(titleTextPath)}`,
    );
  }

  // =====================================================
  // AUDIO
  // =====================================================

  let audioMap = "-an";

  if (audioPath) {
    cmdParts.push(`-stream_loop -1 -i ${q(audioPath)}`);

    const audioInputIndex = nextInputIndex++;

    audioMap = `-map ${audioInputIndex}:a:0 ` + `-c:a aac ` + `-b:a 128k`;
  }

  // =====================================================
  // OUTPUT
  // =====================================================

  cmdParts.push(
    `-filter_complex_script ${q(filterFile)}`,

    `-map "[v]"`,

    audioMap,

    `-t ${Number(seconds).toFixed(3)}`,

    `-c:v libx264`,

    `-preset ${OUTPUT_PRESET}`,

    `-crf ${OUTPUT_CRF}`,

    `-pix_fmt yuv420p`,

    `-r ${OUTPUT_FPS}`,

    `-threads 2`,

    `-movflags +faststart`,

    q(outputPath),
  );

  const cmd = cmdParts.join(" ");

  await runCommand(cmd, "render-story-card");

  if (!fs.existsSync(outputPath)) {
    throw new Error("renderStoryCard failed");
  }

  return {
    outputPath,

    metadata: {
      resolution: `${canvasW}x${canvasH}`,

      thumbnailRatio: "16:9",

      titlePresent: hasTitle,

      titleLines: titleLines.length,

      titleMaxLines: 2,

      titleRounded: hasTitle,

      titleOverlapPx: hasTitle ? 2 : 0,

      contentWords:
        contentStats.countMode === "characters"
          ? contentStats.displayUnits
          : contentStats.words,

      contentRawWords: contentStats.words,

      contentChars: contentStats.characters,

      contentDisplayUnits: contentStats.displayUnits,

      contentCountMode: contentStats.countMode,

      contentFontSize,

      contentLineHeight,

      contentLetterSpacing,

      language: languageType,

      titleRenderMode: hasTitle
        ? useTitlePng
          ? "svg-sharp"
          : "drawtext"
        : "none",

      bodyFontFamily: typography.fontFamily,

      contentPaddingLeft: contentPaddingX,

      contentPaddingRight: contentRightPadding,

      /*
       * Width thật của PNG.
       */
      contentPngWidth,

      /*
       * Width thật sự dùng để wrap text.
       */
      contentWrapWidth,

      contentWrapSafety,

      contentLines: bodyOverlay.lineCount,

      contentAlign: "left",

      continuousParagraph: true,

      sentenceHighlight: true,

      sentenceSpacing: "single-space",

      bodyRenderMode: "svg-sharp",

      content: clippedContent,
    },
  };
}

// =========================================================
// POST /
// =========================================================

router.post("/", async (req, res) => {
  const { image, title, content, language } = req.body || {};

  const normalizedTitle = typeof title === "string" ? normalizeText(title) : "";

  const languageType = normalizeLanguage(
    language,
    `${normalizedTitle} ${typeof content === "string" ? content : ""}`,
  );

  // =====================================================
  // VALIDATE IMAGE
  // =====================================================

  if (!image || typeof image !== "string" || !image.trim()) {
    return res.status(400).json({
      success: false,

      error: "image is required",
    });
  }

  // =====================================================
  // VALIDATE TITLE
  // =====================================================

  if (title !== undefined && title !== null && typeof title !== "string") {
    return res.status(400).json({
      success: false,

      error: "title must be a string when provided",
    });
  }

  if (
    language !== undefined &&
    language !== null &&
    typeof language !== "string"
  ) {
    return res.status(400).json({
      success: false,

      error: "language must be a string when provided",
    });
  }

  // =====================================================
  // VALIDATE CONTENT
  // =====================================================

  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({
      success: false,

      error: "content is required",
    });
  }

  // =====================================================
  // CHECK BACKGROUND
  // =====================================================

  if (!fs.existsSync(BG_VIDEO_FILE)) {
    return res.status(500).json({
      success: false,

      error: "Missing background video: us.mp4",
    });
  }

  // =====================================================
  // CHECK FONT
  // =====================================================

  if (!fs.existsSync(FONT_FILE)) {
    return res.status(500).json({
      success: false,

      error: "Missing font: Arial Bold.ttf",
    });
  }

  if (languageType === "jp" && !fs.existsSync(JP_FONT_FILE)) {
    return res.status(500).json({
      success: false,

      error: "Missing Japanese font: NotoSansJP-Bold.otf",
    });
  }

  // =====================================================
  // JOB
  // =====================================================

  const jobId = generateJobId();

  const tempDir = path.join(TEMP_DIR, jobId);

  fs.mkdirSync(tempDir, {
    recursive: true,
  });

  const imagePath = path.join(tempDir, "thumbnail.jpg");

  const finalPath = path.join(tempDir, "final.mp4");

  try {
    const requestContentStats = getTextStats(content, languageType);

    console.log("\n╔══════════════════════════════════════════╗");

    console.log("║ 🎬 STORY CARD");

    console.log(`║ Job: ${jobId}`);

    console.log(`║ Image: ${image.substring(0, 70)}`);

    console.log(
      normalizedTitle
        ? `║ Title: ${normalizedTitle.substring(0, 100)}`
        : "║ Title: none",
    );

    console.log(
      `║ Content ${requestContentStats.countMode}: ${requestContentStats.displayUnits}`,
    );

    console.log(`║ Body font: ${BODY_FONT_SIZE}px`);

    console.log(`║ Letter spacing: ${BODY_LETTER_SPACING}px`);

    console.log(`║ Language: ${languageType}`);

    console.log(
      `║ Body padding: L${BODY_PADDING_LEFT}px / R${BODY_PADDING_RIGHT}px`,
    );

    console.log(`║ Wrap safety: ${BODY_WRAP_SAFETY}px`);

    console.log("╚══════════════════════════════════════════╝");

    // =================================================
    // DOWNLOAD IMAGE
    // =================================================

    await downloadFile(image.trim(), imagePath);

    // =================================================
    // AUDIO
    // =================================================

    const audioUrl = pickRandomAudioLink();

    let audioPath = null;

    let audioSource = null;

    if (audioUrl) {
      audioPath = path.join(tempDir, "audio-source");

      await downloadFile(audioUrl, audioPath);

      audioSource = audioUrl;

      console.log(`🎵 Audio URL: ${audioUrl}`);
    } else {
      audioPath = pickRandomFallbackAudio();

      audioSource = audioPath ? path.basename(audioPath) : null;

      if (audioPath) {
        console.log(`🎵 Fallback audio: ${path.basename(audioPath)}`);
      } else {
        console.log("🔇 No audio found — rendering silent video");
      }
    }

    // =================================================
    // RENDER
    // =================================================

    const renderResult = await renderStoryCard({
      imagePath,

      audioPath,

      title: normalizedTitle,

      content: normalizeText(content),

      outputPath: finalPath,

      tempDir,

      seconds: DEFAULT_SECONDS,

      languageType,
    });

    console.log("📐 Render metadata:", renderResult.metadata);

    // =================================================
    // UPLOAD
    // =================================================

    const fileName = `${jobId}.mp4`;

    const uploadResult = await uploadVideo(finalPath, fileName);

    if (!uploadResult?.url) {
      throw new Error("Upload failed");
    }

    // =================================================
    // RESPONSE
    // =================================================

    return res.json({
      success: true,

      url: uploadResult.url,
    });
  } catch (error) {
    console.error("❌ Story card error:", error);

    return res.status(500).json({
      success: false,

      error: error?.message || "Unknown error",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

module.exports = router;
