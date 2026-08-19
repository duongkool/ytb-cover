const express = require("express");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const axios = require("axios");
const sharp = require("sharp");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

// const { uploadVideo } = require("../utils/uploadFilegarden");
// UPLOAD TEST
// const { uploadVideo } = require("../utils/uploadService");

// UPLOAD TEMP
const { uploadVideo } = require("../utils/uploadTempVideo");

const router = express.Router();
const pipelineAsync = promisify(pipeline);

/*
 * =========================================================
 * OUTPUT
 * =========================================================
 */

const OUTPUT_WIDTH = 1000;
const OUTPUT_HEIGHT = 1600;

const TOP_BLACK_H = 80;
const BOTTOM_BLACK_H = 80;

const CONTENT_HEIGHT = OUTPUT_HEIGHT - TOP_BLACK_H - BOTTOM_BLACK_H;

/*
 * =========================================================
 * CONTENT LAYOUT
 * =========================================================
 */

const CONTENT_PADDING_X = 44;
const CONTENT_PADDING_Y = 40;

const TEXT_WRAP_WIDTH_FACTOR = 1.06;

/*
 * =========================================================
 * TYPOGRAPHY
 * =========================================================
 */

const TITLE_FONT_SIZE = 42;
const TITLE_FONT_WEIGHT = 800;
const TITLE_LINE_HEIGHT = 1.22;

const BODY_FONT_SIZE = 33;
const BODY_FONT_WEIGHT = 700;
const BODY_LINE_HEIGHT = 1.45;

const TITLE_BOTTOM_GAP = 30;
const BOTTOM_TEXT_SAFE_SPACE = 44;

/*
 * =========================================================
 * VIDEO
 * =========================================================
 */

const DEFAULT_VIDEO_SECONDS = 15;

const OUTPUT_FPS = 25;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";

const COMMAND_LOG_TAIL_CHARS = 20000;

/*
 * =========================================================
 * TEMP
 * =========================================================
 */

const TEMP_DIR = path.join(__dirname, "..", "temp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, {
    recursive: true,
  });
}

/*
 * =========================================================
 * AUDIO LIBRARY
 * =========================================================
 */

const AUDIO_LIBRARY = Array.from(
  {
    length: 20,
  },
  (_, index) => {
    const number = index + 1;

    return {
      id: `audio-${String(number).padStart(2, "0")}`,

      name: `Audio ${String(number).padStart(2, "0")}`,

      src: `https://file.garden/aktuFI4G-zH31XWN/au2/au${number}.mp4`,
    };
  },
);

/*
 * =========================================================
 * CACHE
 * =========================================================
 */

let cachedSatori = null;
let cachedFont = null;

/*
 * =========================================================
 * SATORI
 * =========================================================
 */

async function getSatori() {
  if (cachedSatori) {
    return cachedSatori;
  }

  const module = await import("satori");

  cachedSatori = module.default || module;

  return cachedSatori;
}

/*
 * =========================================================
 * FONT
 * =========================================================
 */

async function getFont() {
  if (cachedFont) {
    return cachedFont;
  }

  cachedFont = await fsPromises.readFile(
    path.join(__dirname, "..", "fonts", "Arial Bold.ttf"),
  );

  return cachedFont;
}

/*
 * =========================================================
 * COLOR
 * =========================================================
 */

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHexColor(color) {
  if (typeof color !== "string") {
    return null;
  }

  const value = color.trim();

  return HEX_COLOR_RE.test(value) ? value : null;
}

/*
 * =========================================================
 * CONTENT PARSER
 * =========================================================
 *
 * Block đầu tiên:
 * -> title
 *
 * Các block còn lại:
 * -> body
 *
 * Dòng trống được giữ lại giữa các paragraph.
 */

function parseContent(content) {
  const normalized = String(content || "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!normalized) {
    return {
      title: "",
      body: "",
    };
  }

  /*
   * =========================================================
   * TÌM VỊ TRÍ \n\n ĐẦU TIÊN
   * =========================================================
   */

  const firstParagraphBreak = normalized.search(/\n\s*\n/);

  /*
   * =========================================================
   * TÌM DẤU . ĐẦU TIÊN
   * =========================================================
   *
   * Title ưu tiên là câu đầu tiên kết thúc bằng dấu "."
   */

  const firstDotIndex = normalized.indexOf(".");

  /*
   * =========================================================
   * CASE 1:
   * Có dấu "." và dấu "." nằm trước \n\n đầu tiên
   * =========================================================
   *
   * Ví dụ:
   *
   * Build Better Systems, Not Just Better Goals. Many people...
   *
   * =>
   *
   * title:
   * Build Better Systems, Not Just Better Goals.
   *
   * body:
   * Many people...
   */

  if (
    firstDotIndex !== -1 &&
    (firstParagraphBreak === -1 || firstDotIndex < firstParagraphBreak)
  ) {
    const title = normalized.slice(0, firstDotIndex + 1).trim();

    const body = normalized
      .slice(firstDotIndex + 1)
      .replace(/^\s+/, "")
      .trim();

    return {
      title,
      body,
    };
  }

  /*
   * =========================================================
   * CASE 2:
   * Không có "." trước paragraph break
   * => lấy block trước \n\n làm title
   * =========================================================
   */

  if (firstParagraphBreak !== -1) {
    const title = normalized
      .slice(0, firstParagraphBreak)
      .replace(/\n+/g, " ")
      .trim();

    const body = normalized
      .slice(firstParagraphBreak)
      .replace(/^\n\s*\n/, "")
      .trim();

    return {
      title,
      body,
    };
  }

  /*
   * =========================================================
   * CASE 3:
   * Không có "." và cũng không có \n\n
   *
   * Nếu có xuống dòng đơn:
   * dòng đầu = title
   * còn lại = body
   * =========================================================
   */

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length > 1) {
    return {
      title: lines[0],
      body: lines.slice(1).join(" "),
    };
  }

  /*
   * =========================================================
   * CASE 4:
   * Chỉ có một đoạn duy nhất
   * =========================================================
   */

  return {
    title: normalized,
    body: "",
  };
}

/*
 * =========================================================
 * TEXT WIDTH ESTIMATION
 * =========================================================
 *
 * Dùng để wrap/truncate gần giống cách Satori render.
 *
 * Quan trọng:
 * không dùng slice character.
 */

function getCharacterWeight(char) {
  if (char === " ") {
    return 0.34;
  }

  if (/[ilI1.,'":;!|]/.test(char)) {
    return 0.3;
  }

  if (/[mwMW@%&#]/.test(char)) {
    return 0.95;
  }

  if (/[A-Z]/.test(char)) {
    return 0.67;
  }

  if (/[0-9]/.test(char)) {
    return 0.58;
  }

  return 0.55;
}

function estimateTextWidth(text, fontSize) {
  let width = 0;

  for (const char of String(text || "")) {
    width += getCharacterWeight(char) * fontSize;
  }

  return width;
}

/*
 * =========================================================
 * WRAP ONE PARAGRAPH
 * =========================================================
 */

function wrapParagraphByWords({ text, maxWidth, fontSize }) {
  const normalized = String(text || "").trim();

  if (!normalized) {
    return [];
  }

  const words = normalized.split(/\s+/).filter(Boolean);

  const lines = [];

  let currentLine = "";

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
      currentLine = candidate;

      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    /*
     * Không cắt word.
     *
     * Nếu một word riêng lẻ rộng hơn maxWidth,
     * vẫn giữ nguyên word đó.
     *
     * Satori sẽ tự xử lý phần render.
     */

    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

/*
 * =========================================================
 * SMART BODY TRUNCATE
 * =========================================================
 *
 * - giữ paragraph
 * - wrap theo word
 * - giới hạn số dòng
 * - nếu vượt:
 *   bỏ nguyên word cuối
 *   rồi thêm ...
 */

function truncateBodyByWords({
  text,
  maxWidth,
  maxHeight,
  fontSize,
  lineHeight,
}) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!normalized) {
    return {
      text: "",
      truncated: false,
      lineCount: 0,
      maxLines: 0,
    };
  }

  const linePixelHeight = fontSize * lineHeight;

  /*
   * Satori render line box có thể cao hơn
   * phép tính lý thuyết một chút.
   *
   * +2px mỗi dòng để tránh dòng cuối bị crop.
   */
  const safeLinePixelHeight = linePixelHeight + 2;

  const maxLines = Math.max(1, Math.floor(maxHeight / safeLinePixelHeight));

  /*
   * Body được chia theo paragraph.
   */

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((item) => item.replace(/\n+/g, " ").trim())
    .filter(Boolean);

  /*
   * Mảng item cuối cùng.
   *
   * type:
   * - line
   * - gap
   */

  const layoutItems = [];

  for (
    let paragraphIndex = 0;
    paragraphIndex < paragraphs.length;
    paragraphIndex++
  ) {
    const paragraph = paragraphs[paragraphIndex];

    const lines = wrapParagraphByWords({
      text: paragraph,

      maxWidth,

      fontSize,
    });

    for (const line of lines) {
      layoutItems.push({
        type: "line",
        text: line,
      });
    }

    /*
     * Một dòng trống giữa paragraph.
     *
     * Điều này giúp giữ cảm giác paragraph
     * nhưng không cần PARAGRAPH_GAP riêng.
     */

    if (paragraphIndex < paragraphs.length - 1) {
      layoutItems.push({
        type: "gap",
        text: "",
      });
    }
  }

  /*
   * Số dòng/gap đều chiếm height.
   */

  const truncated = layoutItems.length > maxLines;

  if (!truncated) {
    return {
      text: layoutItems
        .map((item) => (item.type === "gap" ? "" : item.text))
        .join("\n"),

      truncated: false,

      lineCount: layoutItems.length,

      maxLines,
    };
  }

  /*
   * Chỉ lấy số line cho phép.
   */

  let visibleItems = layoutItems.slice(0, maxLines);

  /*
   * Không để output kết thúc bằng gap.
   */

  while (
    visibleItems.length &&
    visibleItems[visibleItems.length - 1].type === "gap"
  ) {
    visibleItems.pop();
  }

  /*
   * Tìm dòng text cuối.
   */

  let lastIndex = visibleItems.length - 1;

  while (lastIndex >= 0 && visibleItems[lastIndex].type !== "line") {
    lastIndex--;
  }

  if (lastIndex < 0) {
    return {
      text: "...",

      truncated: true,

      lineCount: 1,

      maxLines,
    };
  }

  let lastLine = visibleItems[lastIndex].text;

  /*
   * Smart truncate:
   *
   * bỏ nguyên word,
   * không slice character.
   */

  while (lastLine) {
    const candidate = `${lastLine}...`;

    if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
      lastLine = candidate;

      break;
    }

    const words = lastLine.split(/\s+/).filter(Boolean);

    words.pop();

    lastLine = words.join(" ");
  }

  if (!lastLine) {
    lastLine = "...";
  }

  visibleItems[lastIndex].text = lastLine;

  /*
   * Xóa mọi item sau line cuối
   * để không có gap dư.
   */

  visibleItems = visibleItems.slice(0, lastIndex + 1);

  return {
    text: visibleItems
      .map((item) => (item.type === "gap" ? "" : item.text))
      .join("\n"),

    truncated: true,

    lineCount: visibleItems.length,

    maxLines,
  };
}

/*
 * =========================================================
 * AUDIO
 * =========================================================
 */

function randomItem(items) {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function resolveAudio(audioId) {
  if (!audioId) {
    return randomItem(AUDIO_LIBRARY);
  }

  return (
    AUDIO_LIBRARY.find((item) => item.id === audioId) ||
    randomItem(AUDIO_LIBRARY)
  );
}

/*
 * =========================================================
 * CREATE SATORI ELEMENT
 * =========================================================
 */

function createStoryElement({
  backgroundColor,
  textColor,

  title,
  bodyText,
}) {
  return {
    type: "div",

    props: {
      style: {
        width: OUTPUT_WIDTH,

        height: OUTPUT_HEIGHT,

        display: "flex",

        flexDirection: "column",

        backgroundColor: "#000000",

        fontFamily: "ArialStory",
      },

      children: [
        /*
         * =================================================
         * TOP BLACK BAR
         * =================================================
         */

        {
          type: "div",

          props: {
            style: {
              width: OUTPUT_WIDTH,

              height: TOP_BLACK_H,

              display: "flex",

              flexShrink: 0,

              backgroundColor: "#000000",
            },
          },
        },

        /*
         * =================================================
         * CONTENT
         * =================================================
         */

        {
          type: "div",

          props: {
            style: {
              width: OUTPUT_WIDTH,

              height: CONTENT_HEIGHT,

              display: "flex",

              flexDirection: "column",

              flexShrink: 0,

              padding: `${CONTENT_PADDING_Y}px ${CONTENT_PADDING_X}px`,

              boxSizing: "border-box",

              backgroundColor,

              color: textColor,

              textAlign: "left",

              overflow: "hidden",
            },

            children: [
              /*
               * TITLE
               */

              {
                type: "div",

                props: {
                  style: {
                    width: "100%",

                    display: "flex",

                    flexShrink: 0,

                    color: textColor,

                    fontSize: TITLE_FONT_SIZE,

                    fontWeight: TITLE_FONT_WEIGHT,

                    lineHeight: TITLE_LINE_HEIGHT,

                    letterSpacing: "-0.2px",

                    marginBottom: bodyText ? TITLE_BOTTOM_GAP : 0,
                  },

                  children: title,
                },
              },

              /*
               * BODY
               */

              bodyText
                ? {
                    type: "div",

                    props: {
                      style: {
                        width: "100%",

                        display: "flex",

                        flexGrow: 1,

                        minHeight: 0,

                        color: textColor,

                        fontSize: BODY_FONT_SIZE,

                        fontWeight: BODY_FONT_WEIGHT,

                        lineHeight: BODY_LINE_HEIGHT,

                        letterSpacing: "0px",

                        whiteSpace: "pre-wrap",

                        overflow: "hidden",
                      },

                      children: bodyText,
                    },
                  }
                : null,
            ].filter(Boolean),
          },
        },

        /*
         * =================================================
         * BOTTOM BLACK BAR
         * =================================================
         */

        {
          type: "div",

          props: {
            style: {
              width: OUTPUT_WIDTH,

              height: BOTTOM_BLACK_H,

              display: "flex",

              flexShrink: 0,

              backgroundColor: "#000000",
            },
          },
        },
      ],
    },
  };
}

/*
 * =========================================================
 * TEMP CLEANUP
 * =========================================================
 */

function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
      });
    }
  } catch (error) {
    console.warn(`[simple-story-video] cleanup failed: ${error.message}`);
  }
}

/*
 * =========================================================
 * DOWNLOAD AUDIO
 * =========================================================
 */

async function downloadFile(url, destinationPath) {
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

  await pipelineAsync(
    response.data,

    fs.createWriteStream(destinationPath),
  );

  return destinationPath;
}

/*
 * =========================================================
 * FFMPEG
 * =========================================================
 */

async function createVideoFromImageBuffer({
  imageBuffer,
  audioPath,
  outputPath,
  seconds,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",

      /*
       * IMAGE INPUT
       */

      "-loop",
      "1",

      "-framerate",
      String(OUTPUT_FPS),

      "-f",
      "image2pipe",

      "-vcodec",
      "mjpeg",

      "-i",
      "pipe:0",

      /*
       * AUDIO INPUT
       */

      "-stream_loop",
      "-1",

      "-i",
      audioPath,

      /*
       * MAP
       */

      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

      /*
       * DURATION
       */

      "-t",
      Number(seconds).toFixed(3),

      /*
       * FILTER
       *
       * Output đã là 900x1600,
       * nhưng giữ pad để đảm bảo
       * kích thước chẵn.
       */

      "-vf",

      "pad='ceil(iw/2)*2':'ceil(ih/2)*2':0:0:black,setsar=1,format=yuv420p",

      /*
       * VIDEO
       */

      "-c:v",
      "libx264",

      "-preset",
      OUTPUT_PRESET,

      "-crf",
      String(OUTPUT_CRF),

      "-r",
      String(OUTPUT_FPS),

      "-threads",
      "2",

      /*
       * AUDIO
       */

      "-c:a",
      "aac",

      "-b:a",
      "128k",

      /*
       * WEB
       */

      "-movflags",
      "+faststart",

      outputPath,
    ];

    console.log("\n========== SIMPLE STORY VIDEO ==========");

    console.log("ffmpeg", args.join(" "));

    console.log("========================================\n");

    const child = spawn("ffmpeg", args, {
      windowsHide: true,

      stdio: ["pipe", "pipe", "pipe"],
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
      reject(new Error(`FFmpeg error: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        if (!fs.existsSync(outputPath)) {
          reject(new Error("FFmpeg completed but output file does not exist"));

          return;
        }

        resolve({
          stdout,
          stderr,
        });

        return;
      }

      reject(new Error(`FFmpeg failed: ${stderr.trim() || `code ${code}`}`));
    });

    child.stdin.on("error", () => {});

    child.stdin.end(imageBuffer);
  });
}

/*
 * =========================================================
 * POST /
 * =========================================================
 */

router.post("/", async (req, res) => {
  const totalStart = performance.now();

  const requestId = `simple_story_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const tempDir = path.join(TEMP_DIR, requestId);

  const audioPath = path.join(tempDir, "audio.mp4");

  const outputPath = path.join(tempDir, "final.mp4");

  try {
    /*
     * ===================================================
     * INPUT
     * ===================================================
     */

    const {
      content,

      backgroundColor,

      textColor,

      audioId,

      seconds = DEFAULT_VIDEO_SECONDS,
    } = req.body || {};

    /*
     * ===================================================
     * CONTENT
     * ===================================================
     */

    const normalizedContent = String(content || "").trim();

    if (!normalizedContent) {
      return res.status(400).json({
        success: false,

        error: "Missing content",
      });
    }

    /*
     * ===================================================
     * BACKGROUND COLOR
     * ===================================================
     */

    const finalBackgroundColor = normalizeHexColor(backgroundColor);

    if (!finalBackgroundColor) {
      return res.status(400).json({
        success: false,

        error: "Missing or invalid backgroundColor",
      });
    }

    /*
     * ===================================================
     * TEXT COLOR
     * ===================================================
     */

    const finalTextColor = normalizeHexColor(textColor) || "#111111";

    /*
     * ===================================================
     * DURATION
     * ===================================================
     */

    const requestedDuration = Number(seconds);

    if (!Number.isFinite(requestedDuration) || requestedDuration <= 0) {
      return res.status(400).json({
        success: false,

        error: "seconds must be a positive number",
      });
    }

    const videoDuration = Math.min(60, requestedDuration);

    /*
     * ===================================================
     * PARSE
     * ===================================================
     */

    const { title, body } = parseContent(normalizedContent);

    /*
     * ===================================================
     * BODY AVAILABLE HEIGHT
     * ===================================================
     *
     * Canvas cố định.
     *
     * Body chỉ được dùng phần chiều cao còn lại
     * sau title.
     */

    const realTextWidth = OUTPUT_WIDTH - CONTENT_PADDING_X * 2;

    const textMaxWidth = realTextWidth * TEXT_WRAP_WIDTH_FACTOR;

    /*
     * Ước lượng title height.
     *
     * Title thường ngắn,
     * nhưng vẫn tính theo wrap word.
     */

    const titleLines = wrapParagraphByWords({
      text: title,

      maxWidth: textMaxWidth,

      fontSize: TITLE_FONT_SIZE,
    });

    const titleHeight =
      Math.max(1, titleLines.length) * TITLE_FONT_SIZE * TITLE_LINE_HEIGHT;

    const availableBodyHeight =
      CONTENT_HEIGHT -
      CONTENT_PADDING_Y * 2 -
      titleHeight -
      (body ? TITLE_BOTTOM_GAP : 0) -
      BOTTOM_TEXT_SAFE_SPACE;

    /*
     * ===================================================
     * SMART TRUNCATE
     * ===================================================
     */

    const bodyResult = truncateBodyByWords({
      text: body,

      maxWidth: textMaxWidth,

      maxHeight: Math.max(
        BODY_FONT_SIZE * BODY_LINE_HEIGHT,

        availableBodyHeight,
      ),

      fontSize: BODY_FONT_SIZE,

      lineHeight: BODY_LINE_HEIGHT,
    });

    /*
     * ===================================================
     * AUDIO
     * ===================================================
     */

    const audio = resolveAudio(audioId);

    if (!audio?.src) {
      throw new Error("Cannot resolve audio");
    }

    /*
     * ===================================================
     * SATORI
     * ===================================================
     */

    const imageStart = performance.now();

    const [satori, font] = await Promise.all([getSatori(), getFont()]);

    const element = createStoryElement({
      backgroundColor: finalBackgroundColor,

      textColor: finalTextColor,

      title,

      bodyText: bodyResult.text,
    });

    /*
     * ===================================================
     * SATORI → SVG
     * ===================================================
     */

    const svg = await satori(element, {
      width: OUTPUT_WIDTH,

      height: OUTPUT_HEIGHT,

      fonts: [
        {
          name: "ArialStory",

          data: font,

          weight: 700,

          style: "normal",
        },

        {
          name: "ArialStory",

          data: font,

          weight: 800,

          style: "normal",
        },
      ],
    });

    /*
     * ===================================================
     * SVG → JPEG
     * ===================================================
     */

    const imageBuffer = await sharp(Buffer.from(svg))
      .jpeg({
        quality: 95,

        chromaSubsampling: "4:4:4",
      })
      .toBuffer();

    const imageMs = performance.now() - imageStart;

    /*
     * ===================================================
     * TEMP
     * ===================================================
     */

    fs.mkdirSync(tempDir, {
      recursive: true,
    });

    /*
     * ===================================================
     * AUDIO DOWNLOAD
     * ===================================================
     */

    const audioStart = performance.now();

    await downloadFile(audio.src, audioPath);

    const audioMs = performance.now() - audioStart;

    /*
     * ===================================================
     * VIDEO
     * ===================================================
     */

    const ffmpegStart = performance.now();

    await createVideoFromImageBuffer({
      imageBuffer,

      audioPath,

      outputPath,

      seconds: videoDuration,
    });

    const ffmpegMs = performance.now() - ffmpegStart;

    /*
     * ===================================================
     * UPLOAD
     * ===================================================
     */

    const uploadStart = performance.now();

    const fileName = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}.mp4`;

    const uploadResult = await uploadVideo(outputPath, fileName);

    const uploadMs = performance.now() - uploadStart;

    if (!uploadResult?.url) {
      throw new Error("Upload video failed");
    }

    const totalMs = performance.now() - totalStart;

    /*
     * ===================================================
     * LOG
     * ===================================================
     */

    console.log("[simple-story-video]", {
      image: `${Math.round(imageMs)}ms`,

      audioDownload: `${Math.round(audioMs)}ms`,

      ffmpeg: `${Math.round(ffmpegMs)}ms`,

      upload: `${Math.round(uploadMs)}ms`,

      total: `${Math.round(totalMs)}ms`,

      width: OUTPUT_WIDTH,

      height: OUTPUT_HEIGHT,

      backgroundColor: finalBackgroundColor,

      textColor: finalTextColor,

      audio: audio.id,

      truncated: bodyResult.truncated,

      bodyLines: bodyResult.lineCount,

      bodyMaxLines: bodyResult.maxLines,
    });

    /*
     * ===================================================
     * RESPONSE
     * ===================================================
     */

    return res.status(200).json({
      success: true,
      url: uploadResult.url,
      title,
    });
  } catch (error) {
    console.error(`simple story video failed (${requestId}):`, error);

    return res.status(500).json({
      success: false,

      error: error?.message || "Create simple story video failed",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

module.exports = router;
