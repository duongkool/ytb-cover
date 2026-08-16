const express = require("express");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const axios = require("axios");
const sharp = require("sharp");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const { uploadVideo } = require("../utils/uploadFilegarden");

const router = express.Router();
const pipelineAsync = promisify(pipeline);

/*
 * =========================================================
 * OUTPUT
 * =========================================================
 */

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;

const SCALE = OUTPUT_WIDTH / 350;

const CARD_RADIUS = Math.round(18 * SCALE);
const CARD_INSET = Math.round(4 * SCALE);

/*
 * =========================================================
 * DEFAULT
 * =========================================================
 */

const DEFAULT_LANGUAGE = "de";
const DEFAULT_TEXT_SIZE = 14;
const DEFAULT_LINE_HEIGHT = 1.4;
const DEFAULT_TEXT_ALIGN = "left";
const DEFAULT_VIDEO_SECONDS = 15;

/*
 * =========================================================
 * VIDEO
 * =========================================================
 */

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
 * VERIFIED
 * =========================================================
 */

const VERIFIED_BADGE_URL =
  "https://cdn-icons-png.flaticon.com/128/15050/15050690.png";

/*
 * =========================================================
 * AVATAR LIBRARY
 * =========================================================
 */

const AVATAR_LIBRARY = [
  {
    id: "avatar-01",
    name: "Alex Morgan",
    src: "https://i.pravatar.cc/400?img=5",
  },
  {
    id: "avatar-02",
    name: "Sophie Bennett",
    src: "https://i.pravatar.cc/400?img=8",
  },
  {
    id: "avatar-03",
    name: "Daniel Carter",
    src: "https://i.pravatar.cc/400?img=12",
  },
  {
    id: "avatar-04",
    name: "Emma Collins",
    src: "https://i.pravatar.cc/400?img=15",
  },
  {
    id: "avatar-05",
    name: "Lucas Martin",
    src: "https://i.pravatar.cc/400?img=18",
  },
  {
    id: "avatar-06",
    name: "Olivia Parker",
    src: "https://i.pravatar.cc/400?img=21",
  },
  {
    id: "avatar-07",
    name: "Noah Wilson",
    src: "https://i.pravatar.cc/400?img=24",
  },
  {
    id: "avatar-08",
    name: "Mia Anderson",
    src: "https://i.pravatar.cc/400?img=28",
  },
  {
    id: "avatar-09",
    name: "Ethan Walker",
    src: "https://i.pravatar.cc/400?img=32",
  },
  {
    id: "avatar-10",
    name: "Charlotte Evans",
    src: "https://i.pravatar.cc/400?img=35",
  },
  {
    id: "avatar-11",
    name: "James Mitchell",
    src: "https://i.pravatar.cc/400?img=38",
  },
  {
    id: "avatar-12",
    name: "Amelia Harris",
    src: "https://i.pravatar.cc/400?img=41",
  },
  {
    id: "avatar-13",
    name: "Benjamin Clark",
    src: "https://i.pravatar.cc/400?img=44",
  },
  {
    id: "avatar-14",
    name: "Isabella Turner",
    src: "https://i.pravatar.cc/400?img=47",
  },
  {
    id: "avatar-15",
    name: "Henry Lewis",
    src: "https://i.pravatar.cc/400?img=59",
  },
  {
    id: "avatar-16",
    name: "Grace Thompson",
    src: "https://i.pravatar.cc/400?img=53",
  },
  {
    id: "avatar-17",
    name: "Samuel Roberts",
    src: "https://i.pravatar.cc/400?img=56",
  },
  {
    id: "avatar-18",
    name: "Lily Edwards",
    src: "https://i.pravatar.cc/400?img=60",
  },
  {
    id: "avatar-19",
    name: "Jack Cooper",
    src: "https://i.pravatar.cc/400?img=64",
  },
  {
    id: "avatar-20",
    name: "Emily Foster",
    src: "https://i.pravatar.cc/400?img=68",
  },
];

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
      source: "library",
    };
  },
);

/*
 * =========================================================
 * BACKGROUND PRESETS
 * =========================================================
 */

const BACKGROUND_PRESETS = [
  {
    id: "midnight",
    name: "Midnight",
    stops: [
      {
        offset: 0,
        color: "#312e81",
      },
      {
        offset: 52,
        color: "#111827",
      },
      {
        offset: 100,
        color: "#020617",
      },
    ],
    textColor: "#ffffff",
    mutedColor: "rgba(255,255,255,0.66)",
    glowOne: "rgba(129,140,248,0.34)",
    glowTwo: "rgba(56,189,248,0.18)",
  },

  {
    id: "aurora",
    name: "Aurora",
    stops: [
      {
        offset: 0,
        color: "#064e3b",
      },
      {
        offset: 42,
        color: "#0f766e",
      },
      {
        offset: 100,
        color: "#172554",
      },
    ],
    textColor: "#ecfeff",
    mutedColor: "rgba(236,254,255,0.7)",
    glowOne: "rgba(45,212,191,0.32)",
    glowTwo: "rgba(59,130,246,0.22)",
  },

  {
    id: "sunset",
    name: "Sunset",
    stops: [
      {
        offset: 0,
        color: "#7c2d12",
      },
      {
        offset: 42,
        color: "#c2410c",
      },
      {
        offset: 100,
        color: "#4c0519",
      },
    ],
    textColor: "#fff7ed",
    mutedColor: "rgba(255,247,237,0.72)",
    glowOne: "rgba(251,146,60,0.38)",
    glowTwo: "rgba(244,63,94,0.22)",
  },

  {
    id: "rose",
    name: "Rose",
    stops: [
      {
        offset: 0,
        color: "#831843",
      },
      {
        offset: 42,
        color: "#be185d",
      },
      {
        offset: 100,
        color: "#312e81",
      },
    ],
    textColor: "#fff1f2",
    mutedColor: "rgba(255,241,242,0.72)",
    glowOne: "rgba(244,114,182,0.36)",
    glowTwo: "rgba(129,140,248,0.22)",
  },

  {
    id: "ocean",
    name: "Ocean",
    stops: [
      {
        offset: 0,
        color: "#0c4a6e",
      },
      {
        offset: 45,
        color: "#0369a1",
      },
      {
        offset: 100,
        color: "#082f49",
      },
    ],
    textColor: "#f0f9ff",
    mutedColor: "rgba(240,249,255,0.7)",
    glowOne: "rgba(56,189,248,0.36)",
    glowTwo: "rgba(14,165,233,0.2)",
  },

  {
    id: "forest",
    name: "Forest",
    stops: [
      {
        offset: 0,
        color: "#14532d",
      },
      {
        offset: 45,
        color: "#166534",
      },
      {
        offset: 100,
        color: "#052e16",
      },
    ],
    textColor: "#f0fdf4",
    mutedColor: "rgba(240,253,244,0.7)",
    glowOne: "rgba(74,222,128,0.28)",
    glowTwo: "rgba(250,204,21,0.14)",
  },

  {
    id: "sand",
    name: "Sand",
    stops: [
      {
        offset: 0,
        color: "#fef3c7",
      },
      {
        offset: 48,
        color: "#fed7aa",
      },
      {
        offset: 100,
        color: "#f5d0fe",
      },
    ],
    textColor: "#422006",
    mutedColor: "rgba(66,32,6,0.64)",
    glowOne: "rgba(251,146,60,0.22)",
    glowTwo: "rgba(192,132,252,0.18)",
  },

  {
    id: "minimal",
    name: "Minimal",
    stops: [
      {
        offset: 0,
        color: "#f8fafc",
      },
      {
        offset: 50,
        color: "#e2e8f0",
      },
      {
        offset: 100,
        color: "#cbd5e1",
      },
    ],
    textColor: "#0f172a",
    mutedColor: "rgba(15,23,42,0.62)",
    glowOne: "rgba(99,102,241,0.14)",
    glowTwo: "rgba(14,165,233,0.1)",
  },
];

/*
 * =========================================================
 * LANGUAGE
 * =========================================================
 */

const LANGUAGE_COPY = {
  en: {
    hoursAgo: (hours) => `${hours} hours ago`,
    footer: "To be continued in C0mments",
  },

  ro: {
    hoursAgo: (hours) => `acum ${hours} ore`,
    footer: "Continuarea în comentarii",
  },

  pl: {
    hoursAgo: (hours) => `${hours} godzin temu`,
    footer: "Ciąg dalszy w komentarzach",
  },

  de: {
    hoursAgo: (hours) => `vor ${hours} Stunden`,
    footer: "Fortsetzung in den Kommentaren",
  },

  es: {
    hoursAgo: (hours) => `hace ${hours} horas`,
    footer: "Continuará en los comentarios",
  },

  pt: {
    hoursAgo: (hours) => `há ${hours} horas`,
    footer: "Continua nos comentários",
  },

  it: {
    hoursAgo: (hours) => `${hours} ore fa`,
    footer: "Continua nei commenti",
  },
};

/*
 * =========================================================
 * CACHE
 * =========================================================
 */

let cachedSatori = null;
let cachedFont = null;

const imageCache = new Map();
const backgroundCache = new Map();
const blurredNameCache = new Map();

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
 * RANDOM
 * =========================================================
 */

function randomItem(items) {
  if (!Array.isArray(items) || !items.length) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function randomBoolean() {
  return Math.random() >= 0.5;
}

function getRandomHoursAgo() {
  return Math.floor(Math.random() * 17) + 4;
}

function resolveBackground(backgroundId) {
  if (!backgroundId) {
    return randomItem(BACKGROUND_PRESETS);
  }

  return (
    BACKGROUND_PRESETS.find((item) => item.id === backgroundId) ||
    randomItem(BACKGROUND_PRESETS)
  );
}

function resolveAvatar(avatarId) {
  if (!avatarId) {
    return randomItem(AVATAR_LIBRARY);
  }

  return (
    AVATAR_LIBRARY.find((item) => item.id === avatarId) ||
    randomItem(AVATAR_LIBRARY)
  );
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

function resolveShowHeader(showHeader) {
  if (typeof showHeader === "boolean") {
    return showHeader;
  }

  return randomBoolean();
}

function resolveAlign(value) {
  if (value === "left" || value === "center" || value === "right") {
    return value;
  }

  return DEFAULT_TEXT_ALIGN;
}

/*
 * =========================================================
 * COLOR
 * =========================================================
 */

function parseRgba(value) {
  const text = String(value || "").trim();

  const match = text.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i,
  );

  if (!match) {
    return {
      color: text,
      opacity: 1,
    };
  }

  return {
    color: `rgb(${match[1]},${match[2]},${match[3]})`,

    opacity: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/*
 * =========================================================
 * BACKGROUND PNG
 * =========================================================
 */

async function createBackgroundDataUri(background) {
  if (backgroundCache.has(background.id)) {
    return backgroundCache.get(background.id);
  }

  const cardX = CARD_INSET;
  const cardY = CARD_INSET;

  const cardWidth = OUTPUT_WIDTH - CARD_INSET * 2;

  const cardHeight = OUTPUT_HEIGHT - CARD_INSET * 2;

  const glowOne = parseRgba(background.glowOne);

  const glowTwo = parseRgba(background.glowTwo);

  const stops = background.stops
    .map(
      (stop) => `<stop offset="${stop.offset}%" stop-color="${stop.color}" />`,
    )
    .join("");

  const svg = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${OUTPUT_WIDTH}"
  height="${OUTPUT_HEIGHT}"
  viewBox="0 0 ${OUTPUT_WIDTH} ${OUTPUT_HEIGHT}"
>

  <defs>

    <clipPath id="cardClip">
      <rect
        x="${cardX}"
        y="${cardY}"
        width="${cardWidth}"
        height="${cardHeight}"
        rx="${CARD_RADIUS}"
        ry="${CARD_RADIUS}"
      />
    </clipPath>

    <linearGradient
      id="mainGradient"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      ${stops}
    </linearGradient>

    <radialGradient id="glowOne">
      <stop
        offset="0%"
        stop-color="${glowOne.color}"
        stop-opacity="${glowOne.opacity}"
      />

      <stop
        offset="18%"
        stop-color="${glowOne.color}"
        stop-opacity="${glowOne.opacity}"
      />

      <stop
        offset="72%"
        stop-color="${glowOne.color}"
        stop-opacity="0"
      />
    </radialGradient>

    <radialGradient id="glowTwo">
      <stop
        offset="0%"
        stop-color="${glowTwo.color}"
        stop-opacity="${glowTwo.opacity}"
      />

      <stop
        offset="18%"
        stop-color="${glowTwo.color}"
        stop-opacity="${glowTwo.opacity}"
      />

      <stop
        offset="74%"
        stop-color="${glowTwo.color}"
        stop-opacity="0"
      />
    </radialGradient>

    <linearGradient
      id="overlay"
      x1="0%"
      y1="0%"
      x2="100%"
      y2="100%"
    >
      <stop
        offset="0%"
        stop-color="#ffffff"
        stop-opacity="0.035"
      />

      <stop
        offset="38%"
        stop-color="#ffffff"
        stop-opacity="0"
      />

      <stop
        offset="100%"
        stop-color="#000000"
        stop-opacity="0.16"
      />
    </linearGradient>

  </defs>

  <rect
    width="${OUTPUT_WIDTH}"
    height="${OUTPUT_HEIGHT}"
    fill="#000000"
  />

  <g clip-path="url(#cardClip)">

    <rect
      x="${cardX}"
      y="${cardY}"
      width="${cardWidth}"
      height="${cardHeight}"
      fill="url(#mainGradient)"
    />

    <ellipse
      cx="${Math.round(cardX + cardWidth * 0.93)}"
      cy="${Math.round(cardY + cardHeight * 0.03)}"
      rx="${Math.round(cardWidth * 0.7)}"
      ry="${Math.round(cardWidth * 0.7)}"
      fill="url(#glowOne)"
    />

    <ellipse
      cx="${Math.round(cardX + cardWidth * 0.05)}"
      cy="${Math.round(cardY + cardHeight * 0.97)}"
      rx="${Math.round(cardWidth * 0.65)}"
      ry="${Math.round(cardWidth * 0.65)}"
      fill="url(#glowTwo)"
    />

    <rect
      x="${cardX}"
      y="${cardY}"
      width="${cardWidth}"
      height="${cardHeight}"
      fill="url(#overlay)"
    />

  </g>

  <rect
    x="${cardX + 1}"
    y="${cardY + 1}"
    width="${cardWidth - 2}"
    height="${cardHeight - 2}"
    rx="${CARD_RADIUS}"
    ry="${CARD_RADIUS}"
    fill="none"
    stroke="#ffffff"
    stroke-opacity="0.08"
    stroke-width="${Math.max(2, Math.round(SCALE))}"
  />

</svg>
`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  const dataUri = `data:image/png;base64,${png.toString("base64")}`;

  backgroundCache.set(background.id, dataUri);

  return dataUri;
}

/*
 * =========================================================
 * REMOTE IMAGE CACHE
 * =========================================================
 */

async function getImageDataUri(url) {
  if (!url) {
    return null;
  }

  if (String(url).startsWith("data:")) {
    return url;
  }

  if (imageCache.has(url)) {
    return imageCache.get(url);
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Cannot load image: ${response.status} ${url}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const contentType = (response.headers.get("content-type") || "image/jpeg")
    .split(";")[0]
    .trim();

  const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;

  imageCache.set(url, dataUri);

  return dataUri;
}

/*
 * =========================================================
 * TEXT
 * =========================================================
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

function wrapTextByWidth(text, maxWidth, fontSize) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();

  if (!normalized) {
    return [];
  }

  const sourceLines = normalized.split("\n");

  const result = [];

  for (const sourceLine of sourceLines) {
    const words = sourceLine.trim().split(/\s+/).filter(Boolean);

    if (!words.length) {
      result.push("");

      continue;
    }

    let currentLine = "";

    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;

      if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
        currentLine = candidate;

        continue;
      }

      if (currentLine) {
        result.push(currentLine);
      }

      currentLine = word;
    }

    if (currentLine) {
      result.push(currentLine);
    }
  }

  return result;
}

function truncateText({ text, maxWidth, maxHeight, fontSize, lineHeight }) {
  const linePixelHeight = fontSize * lineHeight;

  const maxLines = Math.max(1, Math.floor(maxHeight / linePixelHeight));

  let lines = wrapTextByWidth(text, maxWidth, fontSize);

  if (lines.length <= maxLines) {
    return {
      text: String(text || "").trim(),

      truncated: false,

      lineCount: lines.length,

      maxLines,
    };
  }

  lines = lines.slice(0, maxLines);

  let finalLine = lines[lines.length - 1];

  while (
    finalLine.length &&
    estimateTextWidth(`${finalLine}...`, fontSize) > maxWidth
  ) {
    const words = finalLine.split(/\s+/);

    words.pop();

    finalLine = words.join(" ");
  }

  finalLine = finalLine ? `${finalLine}...` : "...";

  lines[lines.length - 1] = finalLine;

  return {
    text: lines.join("\n"),

    truncated: true,

    lineCount: maxLines,

    maxLines,
  };
}

/*
 * =========================================================
 * XML
 * =========================================================
 */

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/*
 * =========================================================
 * BLURRED NAME
 * =========================================================
 */

async function createBlurredNameDataUri({ name, color, fontSize, font }) {
  const safeName = String(name || "");

  const cacheKey = `${safeName}|${color}|${fontSize}`;

  if (blurredNameCache.has(cacheKey)) {
    return blurredNameCache.get(cacheKey);
  }

  const width = Math.round(100 * SCALE);

  const height = Math.round(fontSize * 1.55);

  const blurAmount = 2.2 * SCALE;

  const fontBase64 = font.toString("base64");

  const svg = `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${width}"
  height="${height}"
>

  <defs>

    <style>
      @font-face {
        font-family: StoryBold;
        src: url(data:font/truetype;base64,${fontBase64});
        font-weight: 700;
      }
    </style>

    <filter
      id="nameBlur"
      x="-30%"
      y="-60%"
      width="160%"
      height="220%"
    >
      <feGaussianBlur
        stdDeviation="${blurAmount}"
      />
    </filter>

  </defs>

  <text
    x="10"
    y="${Math.round(fontSize * 1.04)}"
    font-family="StoryBold"
    font-size="${fontSize}"
    font-weight="700"
    fill="${escapeXml(color)}"
    opacity="0.92"
    filter="url(#nameBlur)"
  >${escapeXml(safeName)}</text>

</svg>
`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();

  const dataUri = `data:image/png;base64,${png.toString("base64")}`;

  blurredNameCache.set(cacheKey, dataUri);

  return dataUri;
}

/*
 * =========================================================
 * CREATE STORY ELEMENT
 * =========================================================
 */

function createStoryElement({
  backgroundImage,
  background,

  avatarSrc,
  blurredNameSrc,
  badgeSrc,

  localizedHoursAgo,

  finalShowHeader,
  finalFooterText,

  textResult,
  finalTextAlign,

  safeLineHeight,
  actualTextFontSize,

  cardWidth,
  cardHeight,

  outerPadding,

  avatarSize,
  avatarBorder,
  headerGap,

  badgeSize,

  profileNameWidth,
  profileNameHeight,
  profileTimeFont,

  footerFont,
  footerTopPadding,

  copyPaddingX,
  copyPaddingY,
}) {
  const cardChildren = [];

  /*
   * HEADER
   */

  if (finalShowHeader) {
    cardChildren.push({
      type: "div",

      props: {
        style: {
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          gap: headerGap,
          width: "100%",
        },

        children: [
          {
            type: "div",

            props: {
              style: {
                width: avatarSize,
                height: avatarSize,

                display: "flex",

                alignItems: "center",
                justifyContent: "center",

                flexShrink: 0,

                overflow: "hidden",

                border: `${avatarBorder}px solid rgba(255,255,255,0.65)`,

                borderRadius: 99999,

                backgroundColor: "#64748b",
              },

              children: avatarSrc
                ? {
                    type: "img",

                    props: {
                      src: avatarSrc,

                      width: avatarSize,

                      height: avatarSize,

                      style: {
                        width: avatarSize,

                        height: avatarSize,

                        objectFit: "cover",
                      },
                    },
                  }
                : {
                    type: "span",

                    props: {
                      children: "A",
                    },
                  },
            },
          },

          {
            type: "div",

            props: {
              style: {
                display: "flex",
                flexDirection: "column",

                gap: Math.round(2 * SCALE),

                minWidth: 0,
              },

              children: [
                {
                  type: "div",

                  props: {
                    style: {
                      display: "flex",

                      alignItems: "center",

                      gap: Math.round(5 * SCALE),
                    },

                    children: [
                      {
                        type: "img",

                        props: {
                          src: blurredNameSrc,

                          width: profileNameWidth,

                          height: profileNameHeight,

                          style: {
                            width: profileNameWidth,

                            height: profileNameHeight,

                            objectFit: "contain",

                            flexShrink: 0,
                          },
                        },
                      },

                      badgeSrc
                        ? {
                            type: "img",

                            props: {
                              src: badgeSrc,

                              width: badgeSize,

                              height: badgeSize,

                              style: {
                                width: badgeSize,

                                height: badgeSize,

                                objectFit: "contain",

                                flexShrink: 0,
                              },
                            },
                          }
                        : null,
                    ].filter(Boolean),
                  },
                },

                {
                  type: "span",

                  props: {
                    style: {
                      color: background.mutedColor,

                      fontSize: profileTimeFont,

                      fontWeight: 700,

                      whiteSpace: "nowrap",
                    },

                    children: localizedHoursAgo,
                  },
                },
              ],
            },
          },
        ],
      },
    });
  }

  /*
   * TEXT
   */

  cardChildren.push({
    type: "div",

    props: {
      style: {
        width: "100%",

        flexGrow: 1,
        flexShrink: 1,

        minHeight: 0,

        display: "flex",

        alignItems: "center",
        justifyContent: "center",

        padding: `${Math.round(copyPaddingY)}px ${Math.round(copyPaddingX)}px`,

        boxSizing: "border-box",

        overflow: "hidden",
      },

      children: {
        type: "div",

        props: {
          style: {
            width: "100%",

            display: "flex",

            color: background.textColor,

            fontFamily: "StoryBold",

            fontSize: actualTextFontSize,

            fontWeight: 700,

            lineHeight: safeLineHeight,

            textAlign: finalTextAlign,

            whiteSpace: "pre-wrap",

            wordBreak: "normal",
          },

          children: textResult.text,
        },
      },
    },
  });

  /*
   * FOOTER
   */

  if (finalFooterText) {
    cardChildren.push({
      type: "div",

      props: {
        style: {
          width: "100%",

          flexShrink: 0,

          display: "flex",

          alignItems: "center",

          justifyContent: "center",

          paddingTop: footerTopPadding,

          borderTop: `${Math.max(
            1,
            Math.round(SCALE),
          )}px solid rgba(255,255,255,0.12)`,

          color: background.textColor,

          fontSize: footerFont,

          fontWeight: 700,

          whiteSpace: "nowrap",

          overflow: "hidden",

          textOverflow: "ellipsis",
        },

        children: finalFooterText,
      },
    });
  }

  return {
    type: "div",

    props: {
      style: {
        position: "relative",

        width: OUTPUT_WIDTH,

        height: OUTPUT_HEIGHT,

        display: "flex",

        alignItems: "center",

        justifyContent: "center",

        overflow: "hidden",

        backgroundColor: "#000000",

        fontFamily: "StoryBold",
      },

      children: [
        /*
         * BACKGROUND
         */

        {
          type: "img",

          props: {
            src: backgroundImage,

            width: OUTPUT_WIDTH,

            height: OUTPUT_HEIGHT,

            style: {
              position: "absolute",

              left: 0,
              top: 0,

              width: OUTPUT_WIDTH,

              height: OUTPUT_HEIGHT,
            },
          },
        },

        /*
         * CARD CONTENT
         */

        {
          type: "div",

          props: {
            style: {
              width: cardWidth,

              height: cardHeight,

              display: "flex",

              flexDirection: "column",

              padding: outerPadding,

              boxSizing: "border-box",

              overflow: "hidden",

              borderRadius: CARD_RADIUS,
            },

            children: cardChildren,
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
    console.warn(`[story-video] cleanup failed: ${error.message}`);
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

  await pipelineAsync(response.data, fs.createWriteStream(destinationPath));

  return destinationPath;
}

/*
 * =========================================================
 * FFMPEG
 * =========================================================
 *
 * Điểm quan trọng:
 *
 * ImageBuffer được pipe trực tiếp qua stdin.
 *
 * KHÔNG cần lưu story.jpg xuống disk.
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
       * Image từ stdin.
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
       * Random audio.
       */
      "-stream_loop",
      "-1",

      "-i",
      audioPath,

      /*
       * Chỉ lấy video input 0.
       * Chỉ lấy audio input 1.
       */
      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

      /*
       * Duration.
       */
      "-t",
      Number(seconds).toFixed(3),

      /*
       * Video filter.
       */
      "-vf",
      "scale='if(gt(max(iw,ih),1920),if(gte(iw,ih),1920,-2),trunc(iw/2)*2)':'if(gt(max(iw,ih),1920),if(gte(iw,ih),-2,1920),trunc(ih/2)*2)':flags=lanczos,setsar=1,format=yuv420p",

      /*
       * Video encoder.
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
       * Audio.
       */
      "-c:a",
      "aac",

      "-b:a",
      "128k",

      /*
       * Web streaming.
       */
      "-movflags",
      "+faststart",

      outputPath,
    ];

    console.log("\n================ STORY VIDEO ================");

    console.log("ffmpeg", args.join(" "));

    console.log("=============================================\n");

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

    /*
     * Gửi JPEG trực tiếp vào FFmpeg.
     */
    child.stdin.on("error", () => {});

    child.stdin.end(imageBuffer);
  });
}

/*
 * =========================================================
 * POST
 * =========================================================
 */

router.post("/", async (req, res) => {
  const totalStart = performance.now();

  const requestId = `story_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const tempDir = path.join(TEMP_DIR, requestId);

  const audioPath = path.join(tempDir, "audio.mp4");

  const outputPath = path.join(tempDir, "final.mp4");

  try {
    const {
      content,

      backgroundId,
      avatarId,
      audioId,

      showHeader,

      language = DEFAULT_LANGUAGE,

      footerText,

      showFooter = true,

      textSize = DEFAULT_TEXT_SIZE,

      textAlign = DEFAULT_TEXT_ALIGN,

      lineHeight = DEFAULT_LINE_HEIGHT,

      seconds = DEFAULT_VIDEO_SECONDS,
    } = req.body || {};

    /*
     * ===================================================
     * VALIDATE
     * ===================================================
     */

    const normalizedContent = String(content || "").trim();

    if (!normalizedContent) {
      return res.status(400).json({
        success: false,

        error: "Missing content",
      });
    }

    const videoDuration = Number(seconds);

    if (!Number.isFinite(videoDuration) || videoDuration <= 0) {
      return res.status(400).json({
        success: false,

        error: "seconds must be a positive number",
      });
    }

    /*
     * ===================================================
     * RANDOM
     * ===================================================
     */

    const background = resolveBackground(backgroundId);

    const avatar = resolveAvatar(avatarId);

    const audio = resolveAudio(audioId);

    const finalShowHeader = resolveShowHeader(showHeader);

    const hoursAgo = getRandomHoursAgo();

    const languageCopy =
      LANGUAGE_COPY[language] || LANGUAGE_COPY[DEFAULT_LANGUAGE];

    const localizedHoursAgo = languageCopy.hoursAgo(hoursAgo);

    const finalFooterText = showFooter
      ? typeof footerText === "string"
        ? footerText.trim()
        : languageCopy.footer
      : "";

    /*
     * ===================================================
     * TEXT SETTINGS
     * ===================================================
     */

    const safeTextSize = Number.isFinite(Number(textSize))
      ? Math.min(40, Math.max(8, Number(textSize)))
      : DEFAULT_TEXT_SIZE;

    const safeLineHeight = Number.isFinite(Number(lineHeight))
      ? Math.min(3, Math.max(0.8, Number(lineHeight)))
      : DEFAULT_LINE_HEIGHT;

    const finalTextAlign = resolveAlign(textAlign);

    /*
     * ===================================================
     * LAYOUT
     * ===================================================
     */

    const cardWidth = OUTPUT_WIDTH - CARD_INSET * 2;

    const cardHeight = OUTPUT_HEIGHT - CARD_INSET * 2;

    const outerPadding = Math.round(18 * SCALE);

    const avatarSize = Math.round(36 * SCALE);

    const avatarBorder = Math.max(2, Math.round(2 * SCALE));

    const headerGap = Math.round(11 * SCALE);

    const badgeSize = Math.round(17 * SCALE);

    const profileNameFont = Math.round(14 * SCALE);

    const profileTimeFont = Math.round(11 * SCALE);

    const footerFont = Math.round(14 * SCALE);

    const footerTopPadding = Math.round(12 * SCALE);

    const actualTextFontSize = safeTextSize * SCALE;

    const profileNameWidth = Math.round(100 * SCALE);

    const profileNameHeight = Math.round(profileNameFont * 1.55);

    /*
     * ===================================================
     * TEXT AREA
     * ===================================================
     */

    const availableCardWidth = cardWidth - outerPadding * 2;

    const copyPaddingX = availableCardWidth * 0.025;

    const textMaxWidth = availableCardWidth - copyPaddingX * 2;

    const headerHeight = finalShowHeader ? avatarSize : 0;

    const footerHeight = finalFooterText
      ? footerTopPadding + footerFont * 1.1
      : 0;

    const copyHeight =
      cardHeight - outerPadding * 2 - headerHeight - footerHeight;

    /*
     * Ít padding dọc.
     */
    const copyPaddingY = copyHeight * 0.008;

    const textMaxHeight = copyHeight - copyPaddingY * 2;

    const textResult = truncateText({
      text: normalizedContent,

      maxWidth: textMaxWidth,

      maxHeight: textMaxHeight,

      fontSize: actualTextFontSize,

      lineHeight: safeLineHeight,
    });

    /*
     * ===================================================
     * CORE
     * ===================================================
     */

    const imageStart = performance.now();

    const [satori, font, backgroundImage] = await Promise.all([
      getSatori(),

      getFont(),

      createBackgroundDataUri(background),
    ]);

    /*
     * ===================================================
     * HEADER ASSETS
     * ===================================================
     */

    let avatarSrc = null;

    let badgeSrc = null;

    let blurredNameSrc = null;

    if (finalShowHeader) {
      [avatarSrc, badgeSrc] = await Promise.all([
        getImageDataUri(avatar.src),

        getImageDataUri(VERIFIED_BADGE_URL),
      ]);

      blurredNameSrc = await createBlurredNameDataUri({
        name: avatar.name,

        color: background.textColor,

        fontSize: profileNameFont,

        font,
      });
    }

    /*
     * ===================================================
     * SATORI
     * ===================================================
     */

    const element = createStoryElement({
      backgroundImage,
      background,

      avatarSrc,
      blurredNameSrc,
      badgeSrc,

      localizedHoursAgo,

      finalShowHeader,
      finalFooterText,

      textResult,
      finalTextAlign,

      safeLineHeight,
      actualTextFontSize,

      cardWidth,
      cardHeight,

      outerPadding,

      avatarSize,
      avatarBorder,
      headerGap,

      badgeSize,

      profileNameWidth,
      profileNameHeight,
      profileTimeFont,

      footerFont,
      footerTopPadding,

      copyPaddingX,
      copyPaddingY,
    });

    const svg = await satori(element, {
      width: OUTPUT_WIDTH,

      height: OUTPUT_HEIGHT,

      fonts: [
        {
          name: "StoryBold",

          data: font,

          weight: 700,

          style: "normal",
        },
      ],
    });

    /*
     * ===================================================
     * JPEG BUFFER
     * ===================================================
     */

    const imageBuffer = await sharp(Buffer.from(svg))
      .jpeg({
        quality: 95,
      })
      .toBuffer();

    const imageMs = performance.now() - imageStart;

    /*
     * ===================================================
     * TEMP DIR
     * ===================================================
     */

    fs.mkdirSync(tempDir, {
      recursive: true,
    });

    /*
     * ===================================================
     * DOWNLOAD RANDOM AUDIO
     * ===================================================
     */

    const audioStart = performance.now();

    await downloadFile(audio.src, audioPath);

    const audioMs = performance.now() - audioStart;

    /*
     * ===================================================
     * CREATE VIDEO
     *
     * imageBuffer -> FFmpeg stdin
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
     * UPLOAD VIDEO
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

    console.log("[story-image-video]", {
      image: `${Math.round(imageMs)}ms`,

      audioDownload: `${Math.round(audioMs)}ms`,

      ffmpeg: `${Math.round(ffmpegMs)}ms`,

      upload: `${Math.round(uploadMs)}ms`,

      total: `${Math.round(totalMs)}ms`,

      audio: audio.id,

      background: background.id,

      avatar: finalShowHeader ? avatar.id : null,

      header: finalShowHeader,
    });

    /*
     * ===================================================
     * RESPONSE
     * ===================================================
     */

    return res.status(200).json({
      success: true,

      url: uploadResult.url,

      videoUrl: uploadResult.url,

      service: uploadResult.service || null,

      permanent: uploadResult.permanent || false,

      video: {
        duration: Number(videoDuration.toFixed(2)),

        fps: OUTPUT_FPS,

        crf: OUTPUT_CRF,

        preset: OUTPUT_PRESET,

        layout: "story-image + audio",
      },

      audio: {
        id: audio.id,

        name: audio.name,

        src: audio.src,
      },

      background: {
        id: background.id,

        name: background.name,
      },

      showHeader: finalShowHeader,

      avatar: finalShowHeader
        ? {
            id: avatar.id,

            name: avatar.name,

            src: avatar.src,
          }
        : null,

      hoursAgo: finalShowHeader ? hoursAgo : null,

      language,

      footerText: finalFooterText,

      text: {
        fontSize: safeTextSize,

        lineHeight: safeLineHeight,

        align: finalTextAlign,

        truncated: textResult.truncated,

        lineCount: textResult.lineCount,

        maxLines: textResult.maxLines,
      },

      performance: {
        imageMs: Math.round(imageMs),

        audioDownloadMs: Math.round(audioMs),

        ffmpegMs: Math.round(ffmpegMs),

        uploadMs: Math.round(uploadMs),

        totalMs: Math.round(totalMs),
      },
    });
  } catch (error) {
    console.error(`❌ story image video failed (${requestId}):`, error);

    return res.status(500).json({
      success: false,

      error: error?.message || "Create story video failed",
    });
  } finally {
    /*
     * Xóa:
     *
     * audio.mp4
     * final.mp4
     *
     * Ảnh không hề lưu xuống disk.
     */
    cleanupTempDir(tempDir);
  }
});

module.exports = router;
