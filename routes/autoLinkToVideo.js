const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");

const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

// UPLOAD
// const { uploadVideo } = require("../utils/uploadService");

// TEMP UPLOAD
const { uploadVideo } = require("../utils/uploadTempVideo");

// VPS UPLOAD
// const { uploadVideo } = require("../utils/uploadVps");

const pipelineAsync = promisify(pipeline);

const router = express.Router();

/*
 * =========================================================
 * CONFIG
 * =========================================================
 */

const DEFAULT_W = 720;
const DEFAULT_H = 1280;

const OUTPUT_FPS = 30;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";

const COMMAND_LOG_TAIL_CHARS = 20000;

const DEFAULT_SECONDS = 15;

/*
 * =========================================================
 * BODY TYPOGRAPHY
 * =========================================================
 *
 * Font tăng lại lên 27px.
 *
 * Không giảm font để xử lý VPS nữa.
 * Thay vào đó text sẽ wrap sớm hơn ở mép phải.
 */

const BODY_FONT_SIZE = 27;

const BODY_LINE_HEIGHT = 36;

const BODY_LETTER_SPACING = -0.35;

/*
 * Khoảng an toàn chỉ dùng khi tính wrap.
 *
 * Ví dụ PNG body rộng 632px
 * thì text chỉ được phép wrap trong khoảng 608px.
 *
 * Nhờ vậy font trên VPS có rộng hơn local một chút
 * cũng không bị crop bên phải.
 */
const BODY_WRAP_SAFETY = 40;

/*
 * Padding thật hai bên body.
 */
const BODY_PADDING_LEFT = 32;
const BODY_PADDING_RIGHT = 36;

/*
 * =========================================================
 * PATHS
 * =========================================================
 */

const TEMP_DIR = path.join(
  __dirname,
  "..",
  "temp",
);

const BG_VIDEO_FILE = path.join(
  __dirname,
  "..",
  "us.mp4",
);

const FALLBACK_AUDIO_DIR = path.join(
  __dirname,
  "..",
  "demo",
  "audio",
);

const FONT_FILE = path.join(
  __dirname,
  "..",
  "fonts",
  "Arial Bold.ttf",
);

const AUDIO_EXTENSIONS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
];

/*
 * =========================================================
 * FIXED AUDIO
 * =========================================================
 */

const FIXED_AUDIO_LINKS = [
  "https://video.xopboo.com/media/crystaline-quincas-moreira_1.mp3",
  "https://video.xopboo.com/media/frame-dragging-the-grey-room-density-time.mp3",
  "https://video.xopboo.com/media/atlasaudio-instrumental-519455.mp3",
  "https://video.xopboo.com/media/kulakovka-military-283165.mp3",
  "https://video.xopboo.com/media/nh-c-tin-tuc.mp3",
  "https://video.xopboo.com/media/nh-c-chi-n-tranh.mp3",
];

/*
 * =========================================================
 * COLORS
 * =========================================================
 */

const COLOR_WHITE = "#f3f3f3";

const COLOR_HIGHLIGHT = "#f0d400";

const COLOR_TITLE_BG = "#e4c400";

const COLOR_TITLE_TEXT = "#ffffff";

const COLOR_CONTENT_BG = "#121416";

/*
 * =========================================================
 * INIT
 * =========================================================
 */

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(
    TEMP_DIR,
    {
      recursive: true,
    },
  );
}

/*
 * =========================================================
 * HELPERS
 * =========================================================
 */

function generateJobId() {
  return `story_card_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function q(filePath) {
  return `"${filePath}"`;
}

function makeEven(value) {
  return Math.max(
    2,
    Math.round(
      Number(value) / 2,
    ) * 2,
  );
}

function cleanupTempDir(tempDir) {
  try {
    if (
      fs.existsSync(
        tempDir,
      )
    ) {
      fs.rmSync(
        tempDir,
        {
          recursive: true,
          force: true,
        },
      );

      console.log(
        `🗑️ Cleaned: ${tempDir}`,
      );
    }
  } catch (error) {
    console.warn(
      `⚠️ Cleanup failed: ${error.message}`,
    );
  }
}

function normalizeText(text) {
  return String(
    text || "",
  )
    .replace(
      /\s+/g,
      " ",
    )
    .trim();
}

function normalizeForTextfile(
  text,
) {
  return String(
    text || "",
  )
    .replace(
      /[“”]/g,
      '"',
    )
    .replace(
      /[‘’]/g,
      "'",
    )
    .replace(
      /\r?\n/g,
      " ",
    )
    .trim();
}

function escapeFilterPath(
  filePath,
) {
  return filePath
    .replace(
      /\\/g,
      "/",
    )
    .replace(
      /:/g,
      "\\:",
    )
    .replace(
      /'/g,
      "\\'",
    );
}

function escapeXml(text) {
  return String(
    text || "",
  )
    .replace(
      /&/g,
      "&amp;",
    )
    .replace(
      /</g,
      "&lt;",
    )
    .replace(
      />/g,
      "&gt;",
    )
    .replace(
      /"/g,
      "&quot;",
    )
    .replace(
      /'/g,
      "&apos;",
    );
}

/*
 * =========================================================
 * COMMAND
 * =========================================================
 */

async function runCommand(
  cmd,
  label,
) {
  console.log(
    `\n================ ${label} ================`,
  );

  console.log(cmd);

  console.log(
    "==========================================\n",
  );

  return new Promise(
    (
      resolve,
      reject,
    ) => {
      const child =
        spawn(
          cmd,
          {
            shell: true,
            windowsHide: true,
          },
        );

      let stdout = "";
      let stderr = "";

      const appendTail = (
        current,
        chunk,
      ) => {
        const next =
          current +
          chunk.toString();

        return next.length >
          COMMAND_LOG_TAIL_CHARS
          ? next.slice(
              next.length -
                COMMAND_LOG_TAIL_CHARS,
            )
          : next;
      };

      child.stdout.on(
        "data",
        (chunk) => {
          stdout =
            appendTail(
              stdout,
              chunk,
            );
        },
      );

      child.stderr.on(
        "data",
        (chunk) => {
          stderr =
            appendTail(
              stderr,
              chunk,
            );
        },
      );

      child.on(
        "error",
        (error) => {
          reject(
            new Error(
              `[${label}] ${error.message}`,
            ),
          );
        },
      );

      child.on(
        "close",
        (code) => {
          if (
            code === 0
          ) {
            resolve({
              stdout,
              stderr,
            });

            return;
          }

          console.error(
            `[${label}] failed with exit code ${code}`,
          );

          if (
            stderr.trim()
          ) {
            console.error(
              stderr,
            );
          }

          reject(
            new Error(
              `[${label}] ${
                stderr ||
                `exit code ${code}`
              }`,
            ),
          );
        },
      );
    },
  );
}

/*
 * =========================================================
 * DOWNLOAD
 * =========================================================
 */

async function downloadFile(
  url,
  destPath,
) {
  const response =
    await axios.get(
      url,
      {
        responseType:
          "stream",

        timeout:
          30000,

        family:
          4,

        maxRedirects:
          5,

        maxBodyLength:
          Infinity,

        validateStatus:
          (status) =>
            status >=
              200 &&
            status <
              300,

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      },
    );

  await pipelineAsync(
    response.data,
    fs.createWriteStream(
      destPath,
    ),
  );

  return destPath;
}

/*
 * =========================================================
 * AUDIO
 * =========================================================
 */

function getMediaFilesFromDir(
  dirPath,
  allowedExtensions,
) {
  if (
    !fs.existsSync(
      dirPath,
    )
  ) {
    return [];
  }

  return fs
    .readdirSync(
      dirPath,
    )
    .filter(
      (fileName) => {
        const fullPath =
          path.join(
            dirPath,
            fileName,
          );

        const ext =
          path
            .extname(
              fileName,
            )
            .toLowerCase();

        return (
          fs
            .statSync(
              fullPath,
            )
            .isFile() &&
          allowedExtensions.includes(
            ext,
          )
        );
      },
    )
    .map(
      (fileName) =>
        path.join(
          dirPath,
          fileName,
        ),
    );
}

function pickRandomItem(
  items,
) {
  if (
    !items.length
  ) {
    return null;
  }

  return items[
    Math.floor(
      Math.random() *
        items.length,
    )
  ];
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(
    String(
      value || "",
    ).trim(),
  );
}

function pickRandomAudioLink() {
  const links =
    FIXED_AUDIO_LINKS
      .map(
        (link) =>
          String(
            link ||
              "",
          ).trim(),
      )
      .filter(
        isHttpUrl,
      );

  return pickRandomItem(
    links,
  );
}

function pickRandomFallbackAudio() {
  const files =
    getMediaFilesFromDir(
      FALLBACK_AUDIO_DIR,
      AUDIO_EXTENSIONS,
    );

  return pickRandomItem(
    files,
  );
}

/*
 * =========================================================
 * CONTENT LIMIT
 * =========================================================
 */

function clampStoryContentByWords(
  text,
  maxWords = 120,
) {
  const clean =
    normalizeText(
      text,
    );

  if (!clean) {
    return "";
  }

  const words =
    clean
      .split(/\s+/)
      .filter(Boolean);

  if (
    words.length <=
    maxWords
  ) {
    return clean;
  }

  return words
    .slice(
      0,
      maxWords,
    )
    .join(" ")
    .trim();
}

/*
 * =========================================================
 * SENTENCES
 * =========================================================
 */

function splitSentences(
  text,
) {
  const clean =
    normalizeText(
      text,
    );

  if (!clean) {
    return [];
  }

  const matches =
    clean.match(
      /[^.]+\.?/g,
    ) || [];

  return matches
    .map(
      (item) =>
        item.trim(),
    )
    .filter(Boolean);
}

/*
 * =========================================================
 * WIDTH ESTIMATION
 * =========================================================
 *
 * Chỉ dùng để quyết định wrap.
 *
 * BODY_WRAP_SAFETY mới là lớp bảo vệ chính
 * để tránh VPS crop phần cuối dòng.
 */

function estimateTextWidthPx(
  text,
  fontSize,
  letterSpacing = 0,
) {
  const value =
    String(
      text || "",
    );

  let width = 0;

  for (
    const char of value
  ) {
    if (
      char === " "
    ) {
      width +=
        fontSize *
        0.33;
    } else if (
      /[ilI1.,'":;!|]/.test(
        char,
      )
    ) {
      width +=
        fontSize *
        0.29;
    } else if (
      /[mwMW@%&#]/.test(
        char,
      )
    ) {
      width +=
        fontSize *
        0.92;
    } else if (
      /[A-Z]/.test(
        char,
      )
    ) {
      width +=
        fontSize *
        0.67;
    } else if (
      /[0-9]/.test(
        char,
      )
    ) {
      width +=
        fontSize *
        0.57;
    } else {
      width +=
        fontSize *
        0.54;
    }
  }

  const spacingCount =
    Math.max(
      0,
      value.length -
        1,
    );

  width +=
    spacingCount *
    letterSpacing;

  /*
   * Safety estimate cũ vẫn giữ.
   */
  return width * 1.03;
}

/*
 * =========================================================
 * TITLE
 * =========================================================
 */

function buildTitleLines({
  title,
  maxWidth,
  fontSize,
}) {
  const clean =
    normalizeText(
      title,
    );

  if (!clean) {
    return [];
  }

  const words =
    clean
      .split(/\s+/)
      .filter(Boolean);

  const lines = [];

  let currentLine =
    "";

  let index = 0;

  while (
    index <
      words.length &&
    lines.length < 2
  ) {
    const word =
      words[index];

    const candidate =
      currentLine
        ? `${currentLine} ${word}`
        : word;

    if (
      estimateTextWidthPx(
        candidate,
        fontSize,
        0,
      ) <= maxWidth
    ) {
      currentLine =
        candidate;

      index += 1;

      continue;
    }

    if (
      currentLine
    ) {
      lines.push(
        currentLine,
      );

      currentLine =
        "";

      continue;
    }

    /*
     * Safety:
     * 1 word quá dài.
     */
    let safeWord =
      "";

    for (
      const char of word
    ) {
      const next =
        safeWord +
        char;

      if (
        estimateTextWidthPx(
          `${next}...`,
          fontSize,
          0,
        ) >
        maxWidth
      ) {
        break;
      }

      safeWord =
        next;
    }

    lines.push(
      `${safeWord}...`,
    );

    index += 1;
  }

  if (
    currentLine &&
    lines.length < 2
  ) {
    lines.push(
      currentLine,
    );
  }

  const hasRemainingWords =
    index <
    words.length;

  if (
    hasRemainingWords &&
    lines.length > 0
  ) {
    const lastIndex =
      lines.length - 1;

    let lastLine =
      lines[
        lastIndex
      ];

    while (
      lastLine &&
      estimateTextWidthPx(
        `${lastLine}...`,
        fontSize,
        0,
      ) >
        maxWidth
    ) {
      const parts =
        lastLine
          .split(/\s+/)
          .filter(Boolean);

      parts.pop();

      lastLine =
        parts.join(
          " ",
        );
    }

    lines[
      lastIndex
    ] =
      lastLine
        ? `${lastLine
            .replace(
              /[ .,!?:;"'”’)-]+$/,
              "",
            )
            .trim()}...`
        : "...";
  }

  return lines.slice(
    0,
    2,
  );
}

/*
 * =========================================================
 * BODY LAYOUT
 * =========================================================
 *
 * Paragraph liên tục.
 *
 * Mỗi câu đổi màu nhưng không bắt buộc
 * xuống dòng sau dấu ".".
 */

function buildContinuousBodyLines({
  content,
  maxWidth,
  fontSize,
  letterSpacing,
}) {
  const sentences =
    splitSentences(
      content,
    );

  const lines = [];

  let currentLine =
    [];

  let currentWidth =
    0;

  function pushLine() {
    if (
      currentLine.length ===
      0
    ) {
      return;
    }

    lines.push(
      currentLine,
    );

    currentLine =
      [];

    currentWidth =
      0;
  }

  for (
    let sentenceIndex = 0;
    sentenceIndex <
    sentences.length;
    sentenceIndex += 1
  ) {
    const sentence =
      sentences[
        sentenceIndex
      ];

    const color =
      sentenceIndex %
          2 ===
        0
        ? COLOR_WHITE
        : COLOR_HIGHLIGHT;

    const words =
      sentence
        .split(/\s+/)
        .filter(Boolean);

    for (
      let wordIndex = 0;
      wordIndex <
      words.length;
      wordIndex += 1
    ) {
      const word =
        words[
          wordIndex
        ];

      /*
       * Nếu line đã có chữ,
       * thêm đúng 1 dấu cách.
       */
      let text =
        currentLine.length >
        0
          ? ` ${word}`
          : word;

      let width =
        estimateTextWidthPx(
          text,
          fontSize,
          letterSpacing,
        );

      /*
       * maxWidth ở đây đã được giảm
       * bởi BODY_WRAP_SAFETY.
       *
       * Vì vậy wrap xảy ra sớm hơn,
       * không sát cạnh PNG nữa.
       */
      if (
        currentLine.length >
          0 &&
        currentWidth +
          width >
          maxWidth
      ) {
        pushLine();

        text =
          word;

        width =
          estimateTextWidthPx(
            text,
            fontSize,
            letterSpacing,
          );
      }

      const lastSegment =
        currentLine[
          currentLine.length -
            1
        ];

      if (
        lastSegment &&
        lastSegment.color ===
          color
      ) {
        lastSegment.text +=
          text;
      } else {
        currentLine.push({
          text,
          color,
          sentenceIndex,
        });
      }

      currentWidth +=
        width;
    }
  }

  pushLine();

  return lines;
}

/*
 * =========================================================
 * TITLE BACKGROUND
 * =========================================================
 */

async function createRoundedTitleBox({
  outputPath,
  width,
  height,
  radius = 18,
  color = COLOR_TITLE_BG,
}) {
  const safeWidth =
    Math.max(
      2,
      Math.round(
        width,
      ),
    );

  const safeHeight =
    Math.max(
      2,
      Math.round(
        height,
      ),
    );

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

  await sharp(
    Buffer.from(
      svg,
    ),
  )
    .png()
    .toFile(
      outputPath,
    );

  if (
    !fs.existsSync(
      outputPath,
    )
  ) {
    throw new Error(
      "Failed to create rounded title box",
    );
  }

  return outputPath;
}

/*
 * =========================================================
 * BODY PNG
 * =========================================================
 *
 * width:
 *   chiều rộng thật của PNG.
 *
 * wrapWidth:
 *   chiều rộng nhỏ hơn dùng riêng cho wrap.
 *
 * Đây là fix quan trọng nhất cho VPS.
 */

async function createBodyOverlay({
  outputPath,
  content,
  width,

  wrapWidth = width,

  fontSize =
    BODY_FONT_SIZE,

  lineHeight =
    BODY_LINE_HEIGHT,

  letterSpacing =
    BODY_LETTER_SPACING,
}) {
  /*
   * QUAN TRỌNG:
   *
   * maxWidth sử dụng wrapWidth,
   * KHÔNG dùng width thật của PNG.
   */
  const lines =
    buildContinuousBodyLines({
      content,

      maxWidth:
        wrapWidth,

      fontSize,

      letterSpacing,
    });

  const paddingTop =
    5;

  const paddingBottom =
    10;

  const height =
    Math.max(
      lineHeight,

      paddingTop +
        lines.length *
          lineHeight +
        paddingBottom,
    );

  const svgLines =
    lines
      .map(
        (
          segments,
          lineIndex,
        ) => {
          const y =
            paddingTop +
            fontSize +
            lineIndex *
              lineHeight;

          const tspans =
            segments
              .map(
                (
                  segment,
                ) => {
                  return (
                    `<tspan ` +
                    `fill="${segment.color}" ` +
                    `xml:space="preserve">` +
                    `${escapeXml(
                      segment.text,
                    )}` +
                    `</tspan>`
                  );
                },
              )
              .join("");

          return (
            `<text ` +
            `x="0" ` +
            `y="${y}" ` +
            `font-family="Arial" ` +
            `font-size="${fontSize}" ` +
            `font-weight="700" ` +
            `letter-spacing="${letterSpacing}px" ` +
            `xml:space="preserve">` +
            `${tspans}` +
            `</text>`
          );
        },
      )
      .join("");

  /*
   * PNG vẫn dùng WIDTH THẬT.
   *
   * Text chỉ wrap sớm hơn bên trong.
   */
  const svg = `
    <svg
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}"
      xmlns="http://www.w3.org/2000/svg"
    >
      ${svgLines}
    </svg>
  `;

  await sharp(
    Buffer.from(
      svg,
    ),
  )
    .png()
    .toFile(
      outputPath,
    );

  if (
    !fs.existsSync(
      outputPath,
    )
  ) {
    throw new Error(
      "Failed to create body overlay",
    );
  }

  return {
    outputPath,

    width,

    wrapWidth,

    height,

    lineCount:
      lines.length,
  };
}

/*
 * =========================================================
 * TITLE FILTERS
 * =========================================================
 */

function buildTitleFilters({
  title,
  tempDir,
  cardX,
  cardW,
  imageBottomY,
}) {
  const filters = [];

  const titleFontSize =
    28;

  const titleLineHeight =
    34;

  const titlePaddingY =
    10;

  const titleBoxX =
    cardX + 4;

  const titleBoxW =
    cardW - 8;

  const titleTextPaddingX =
    18;

  const titleTextMaxWidth =
    titleBoxW -
    titleTextPaddingX *
      2;

  const titleLines =
    buildTitleLines({
      title,

      maxWidth:
        titleTextMaxWidth,

      fontSize:
        titleFontSize,
    });

  const titleBoxH =
    titleLines.length *
      titleLineHeight +
    titlePaddingY * 2;

  /*
   * Title chỉ đè thumbnail 2px.
   */
  const titleBoxY =
    imageBottomY - 2;

  const fontPath =
    escapeFilterPath(
      FONT_FILE,
    );

  titleLines.forEach(
    (
      line,
      index,
    ) => {
      const txtPath =
        path.join(
          tempDir,
          `title_${index}.txt`,
        );

      fs.writeFileSync(
        txtPath,

        normalizeForTextfile(
          line,
        ),

        "utf8",
      );

      const textPath =
        escapeFilterPath(
          txtPath,
        );

      const y =
        titleBoxY +
        titlePaddingY +
        index *
          titleLineHeight;

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
    },
  );

  return {
    filters,

    titleLines,

    titleBoxX,

    titleBoxY,

    titleBoxW,

    titleBoxH,
  };
}

/*
 * =========================================================
 * RENDER STORY CARD
 * =========================================================
 */

async function renderStoryCard({
  imagePath,
  audioPath,
  title,
  content,
  outputPath,
  tempDir,
  seconds,
}) {
  const canvasW =
    DEFAULT_W;

  const canvasH =
    DEFAULT_H;

  /*
   * =====================================================
   * MAIN CARD
   * =====================================================
   */

  const outerMarginX =
    14;

  const cardX =
    outerMarginX;

  const cardW =
    canvasW -
    outerMarginX * 2;

  const cardY =
    30;

  /*
   * =====================================================
   * THUMBNAIL
   * =====================================================
   */

  const imageW =
    cardW;

  const imageH =
    makeEven(
      (imageW * 9) /
        16,
    );

  const imageBottomY =
    cardY +
    imageH;

  /*
   * =====================================================
   * CONTENT PANEL
   * =====================================================
   */

  const cardBottom =
    canvasH - 40;

  const contentPanelY =
    imageBottomY;

  const contentPanelH =
    cardBottom -
    contentPanelY;

  /*
   * =====================================================
   * CONTENT
   * =====================================================
   */

  const clippedContent =
    clampStoryContentByWords(
      content,
      120,
    );

  /*
   * =====================================================
   * TITLE
   * =====================================================
   */

  const titleLayout =
    buildTitleFilters({
      title,

      tempDir,

      cardX,

      cardW,

      imageBottomY,
    });

  const {
    filters:
      titleTextFilters,

    titleLines,

    titleBoxX,

    titleBoxY,

    titleBoxW,

    titleBoxH,
  } = titleLayout;

  /*
   * =====================================================
   * TITLE BACKGROUND
   * =====================================================
   */

  const roundedTitlePath =
    path.join(
      tempDir,
      "rounded-title.png",
    );

  await createRoundedTitleBox({
    outputPath:
      roundedTitlePath,

    width:
      titleBoxW,

    height:
      titleBoxH,

    radius:
      18,

    color:
      COLOR_TITLE_BG,
  });

  /*
   * =====================================================
   * BODY SETTINGS
   * =====================================================
   */

  const contentFontSize =
    BODY_FONT_SIZE;

  const contentLineHeight =
    BODY_LINE_HEIGHT;

  const contentLetterSpacing =
    BODY_LETTER_SPACING;

  /*
   * Padding thật tăng từ 24 -> 30.
   */
  const contentPaddingX =
    BODY_PADDING_LEFT;

  const contentRightPadding =
    BODY_PADDING_RIGHT;

  const contentX =
    cardX +
    contentPaddingX;

  /*
   * Đây là width thật của PNG body.
   */
  const contentMaxWidth =
    cardW -
    contentPaddingX -
    contentRightPadding;

  /*
   * =====================================================
   * SAFE WRAP WIDTH
   * =====================================================
   *
   * PNG vẫn rộng contentMaxWidth.
   *
   * Nhưng text chỉ wrap trong vùng nhỏ hơn 24px.
   *
   * Ví dụ:
   *
   * contentMaxWidth = 632
   * contentWrapWidth = 608
   *
   * => có buffer bên phải.
   */
  const contentWrapWidth =
    Math.max(
      100,

      contentMaxWidth -
        BODY_WRAP_SAFETY,
    );

  const contentY =
    titleBoxY +
    titleBoxH +
    18;

  /*
   * =====================================================
   * BODY PNG
   * =====================================================
   */

  const bodyOverlayPath =
    path.join(
      tempDir,
      "body-overlay.png",
    );

  const bodyOverlay =
    await createBodyOverlay({
      outputPath:
        bodyOverlayPath,

      content:
        clippedContent,

      /*
       * Width thật của PNG.
       */
      width:
        contentMaxWidth,

      /*
       * Width dùng riêng để wrap.
       */
      wrapWidth:
        contentWrapWidth,

      fontSize:
        contentFontSize,

      lineHeight:
        contentLineHeight,

      letterSpacing:
        contentLetterSpacing,
    });

  /*
   * =====================================================
   * FILTER
   * =====================================================
   */

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
     * TITLE BG
     */
    `[2:v]` +
      `format=rgba` +
      `[titlebg]`,

    /*
     * BODY PNG
     */
    `[3:v]` +
      `format=rgba` +
      `[bodypng]`,

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
    `[panel][thumb]` +
      `overlay=${cardX}:${cardY}:format=auto` +
      `[withthumb]`,

    /*
     * TITLE BACKGROUND
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

    /*
     * TITLE TEXT
     */
    `[withbody]` +
      `${titleTextFilters.join(
        ",",
      )},` +
      `fps=${OUTPUT_FPS},` +
      `format=yuv420p,` +
      `setpts=N/(${OUTPUT_FPS}*TB)` +
      `[v]`,
  ];

  const filterFile =
    path.join(
      tempDir,
      "story_card_filter.txt",
    );

  fs.writeFileSync(
    filterFile,

    filterParts.join(
      ";",
    ),

    "utf8",
  );

  /*
   * =====================================================
   * FFMPEG INPUTS
   * =====================================================
   */

  const cmdParts = [
    `ffmpeg -y`,

    /*
     * 0 = background
     */
    `-stream_loop -1 -i ${q(
      BG_VIDEO_FILE,
    )}`,

    /*
     * 1 = thumbnail
     */
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(
      imagePath,
    )}`,

    /*
     * 2 = title bg
     */
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(
      roundedTitlePath,
    )}`,

    /*
     * 3 = body PNG
     */
    `-framerate ${OUTPUT_FPS} -loop 1 -i ${q(
      bodyOverlayPath,
    )}`,
  ];

  /*
   * =====================================================
   * AUDIO
   * =====================================================
   */

  let audioMap =
    "-an";

  if (
    audioPath
  ) {
    /*
     * 4 = audio
     */
    cmdParts.push(
      `-stream_loop -1 -i ${q(
        audioPath,
      )}`,
    );

    audioMap =
      `-map 4:a:0 ` +
      `-c:a aac ` +
      `-b:a 128k`;
  }

  /*
   * =====================================================
   * OUTPUT
   * =====================================================
   */

  cmdParts.push(
    `-filter_complex_script ${q(
      filterFile,
    )}`,

    `-map "[v]"`,

    audioMap,

    `-t ${Number(
      seconds,
    ).toFixed(3)}`,

    `-c:v libx264`,

    `-preset ${OUTPUT_PRESET}`,

    `-crf ${OUTPUT_CRF}`,

    `-pix_fmt yuv420p`,

    `-r ${OUTPUT_FPS}`,

    `-threads 2`,

    `-movflags +faststart`,

    q(
      outputPath,
    ),
  );

  const cmd =
    cmdParts.join(
      " ",
    );

  await runCommand(
    cmd,
    "render-story-card",
  );

  if (
    !fs.existsSync(
      outputPath,
    )
  ) {
    throw new Error(
      "renderStoryCard failed",
    );
  }

  return {
    outputPath,

    metadata: {
      resolution:
        `${canvasW}x${canvasH}`,

      thumbnailRatio:
        "16:9",

      titleLines:
        titleLines.length,

      titleMaxLines:
        2,

      titleRounded:
        true,

      titleOverlapPx:
        2,

      contentWords:
        clippedContent
          .split(/\s+/)
          .filter(Boolean)
          .length,

      contentChars:
        clippedContent.length,

      contentFontSize,

      contentLineHeight,

      contentLetterSpacing,

      contentPaddingLeft:
        contentPaddingX,

      contentPaddingRight:
        contentRightPadding,

      contentWidth:
        contentMaxWidth,

      contentWrapWidth,

      contentWrapSafety:
        BODY_WRAP_SAFETY,

      contentLines:
        bodyOverlay.lineCount,

      contentAlign:
        "left",

      continuousParagraph:
        true,

      sentenceHighlight:
        true,

      sentenceSpacing:
        "single-space",

      bodyRenderMode:
        "svg-sharp",

      content:
        clippedContent,
    },
  };
}

/*
 * =========================================================
 * POST /
 * =========================================================
 */

router.post(
  "/",
  async (
    req,
    res,
  ) => {
    const {
      image,
      title,
      content,
    } =
      req.body || {};

    /*
     * =====================================================
     * VALIDATE IMAGE
     * =====================================================
     */

    if (
      !image ||
      typeof image !==
        "string" ||
      !image.trim()
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "image is required",
        });
    }

    /*
     * =====================================================
     * VALIDATE TITLE
     * =====================================================
     */

    if (
      !title ||
      typeof title !==
        "string" ||
      !title.trim()
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "title is required",
        });
    }

    /*
     * =====================================================
     * VALIDATE CONTENT
     * =====================================================
     */

    if (
      !content ||
      typeof content !==
        "string" ||
      !content.trim()
    ) {
      return res
        .status(400)
        .json({
          success:
            false,

          error:
            "content is required",
        });
    }

    /*
     * =====================================================
     * CHECK BACKGROUND
     * =====================================================
     */

    if (
      !fs.existsSync(
        BG_VIDEO_FILE,
      )
    ) {
      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Missing background video: us.mp4",
        });
    }

    /*
     * =====================================================
     * CHECK FONT
     * =====================================================
     */

    if (
      !fs.existsSync(
        FONT_FILE,
      )
    ) {
      return res
        .status(500)
        .json({
          success:
            false,

          error:
            "Missing font: Arial Bold.ttf",
        });
    }

    /*
     * =====================================================
     * JOB
     * =====================================================
     */

    const jobId =
      generateJobId();

    const tempDir =
      path.join(
        TEMP_DIR,
        jobId,
      );

    fs.mkdirSync(
      tempDir,
      {
        recursive:
          true,
      },
    );

    const imagePath =
      path.join(
        tempDir,
        "thumbnail.jpg",
      );

    const finalPath =
      path.join(
        tempDir,
        "final.mp4",
      );

    try {
      console.log(
        "\n╔══════════════════════════════════════════╗",
      );

      console.log(
        "║ 🎬 STORY CARD",
      );

      console.log(
        `║ Job: ${jobId}`,
      );

      console.log(
        `║ Image: ${image.substring(
          0,
          70,
        )}`,
      );

      console.log(
        `║ Title: ${title.substring(
          0,
          100,
        )}`,
      );

      console.log(
        `║ Content words: ${
          normalizeText(
            content,
          )
            .split(/\s+/)
            .filter(Boolean)
            .length
        }`,
      );

      console.log(
        `║ Body font: ${BODY_FONT_SIZE}px`,
      );

      console.log(
        `║ Letter spacing: ${BODY_LETTER_SPACING}px`,
      );

      console.log(
        `║ Body padding: L${BODY_PADDING_LEFT}px / R${BODY_PADDING_RIGHT}px`,
      );

      console.log(
        `║ Wrap safety: ${BODY_WRAP_SAFETY}px`,
      );

      console.log(
        "╚══════════════════════════════════════════╝",
      );

      /*
       * =================================================
       * DOWNLOAD IMAGE
       * =================================================
       */

      await downloadFile(
        image.trim(),
        imagePath,
      );

      /*
       * =================================================
       * AUDIO
       * =================================================
       */

      const audioUrl =
        pickRandomAudioLink();

      let audioPath =
        null;

      let audioSource =
        null;

      if (
        audioUrl
      ) {
        audioPath =
          path.join(
            tempDir,
            "audio-source",
          );

        await downloadFile(
          audioUrl,
          audioPath,
        );

        audioSource =
          audioUrl;

        console.log(
          `🎵 Audio URL: ${audioUrl}`,
        );
      } else {
        audioPath =
          pickRandomFallbackAudio();

        audioSource =
          audioPath
            ? path.basename(
                audioPath,
              )
            : null;

        if (
          audioPath
        ) {
          console.log(
            `🎵 Fallback audio: ${path.basename(
              audioPath,
            )}`,
          );
        } else {
          console.log(
            "🔇 No audio found — rendering silent video",
          );
        }
      }

      /*
       * =================================================
       * RENDER
       * =================================================
       */

      const renderResult =
        await renderStoryCard({
          imagePath,

          audioPath,

          title:
            normalizeText(
              title,
            ),

          content:
            normalizeText(
              content,
            ),

          outputPath:
            finalPath,

          tempDir,

          seconds:
            DEFAULT_SECONDS,
        });

      /*
       * =================================================
       * UPLOAD
       * =================================================
       */

      const fileName =
        `${jobId}.mp4`;

      const uploadResult =
        await uploadVideo(
          finalPath,
          fileName,
        );

      if (
        !uploadResult?.url
      ) {
        throw new Error(
          "Upload failed",
        );
      }

      /*
       * =================================================
       * RESPONSE
       * =================================================
       */

      return res.json({
        success:
          true,

        url:
          uploadResult.url,
      });
    } catch (error) {
      console.error(
        "❌ Story card error:",
        error,
      );

      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error?.message ||
            "Unknown error",
        });
    } finally {
      cleanupTempDir(
        tempDir,
      );
    }
  },
);

module.exports = router;