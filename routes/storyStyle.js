const express = require("express");
const fsPromises = require("fs/promises");
const path = require("path");
const sharp = require("sharp");

const { uploadTempMedia } = require("../utils/uploadTempVideo");

const router = express.Router();

const W = 720;
const H = 1280;
const COLOR_BG_W = 900;
const COLOR_BG_H = 1400;
const EDITORIAL_LAYOUT_W = 900;
const EDITORIAL_LAYOUT_H = 1400;

const MAX_RETRY = 5;
const MAX_VISIBLE_TEXT_CHARS = 900;
const COLOR_BG_MAX_VISIBLE_TEXT_CHARS = 1400;

const DEFAULT_TEXT_COLOR = "#ffffff";
const DEFAULT_ACCENT_COLOR = "#d7ff00";
const EDITORIAL_TEXT_COLOR = "#101010";
const EDITORIAL_ACCENT_COLOR = "#f4d34f";
const EDITORIAL_DEFAULT_AVATAR = "https://i.pravatar.cc/160?img=47";

const BODY_TEXT_SHADOW =
  "0 2px 3px rgba(0,0,0,0.85), 0 4px 8px rgba(0,0,0,0.45)";
const SOFT_TEXT_SHADOW =
  "0 2px 3px rgba(0,0,0,0.75), 0 3px 6px rgba(0,0,0,0.35)";

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const EDITORIAL_ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "dhr",
  "mevr",
]);

const LANGUAGE_MAP = {
  japan: "jp",
  japanese: "jp",
  ja: "jp",
  jp: "jp",
  korea: "kr",
  korean: "kr",
  ko: "kr",
  kr: "kr",
  greek: "gr",
  greece: "gr",
  el: "gr",
  gr: "gr",
};

const TEMP_DIR = path.join(__dirname, "..", "temp", "story-style");

let cachedSatori = null;
const fontCache = new Map();

async function getSatori() {
  if (cachedSatori) return cachedSatori;

  const satoriModule = await import("satori");
  cachedSatori = satoriModule.default || satoriModule;
  return cachedSatori;
}

function normalizeLanguage(language) {
  if (typeof language !== "string") return null;
  return LANGUAGE_MAP[language.trim().toLowerCase()] || null;
}

function normalizeHexColor(color, fallback) {
  if (typeof color !== "string") return fallback;
  const value = color.trim();
  return HEX_COLOR_RE.test(value) ? value : fallback;
}

function getOptionalHexColor(color) {
  if (typeof color !== "string") return null;
  const value = color.trim();
  return HEX_COLOR_RE.test(value) ? value : null;
}

function isTruthy(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

async function readFont(filename) {
  if (fontCache.has(filename)) return fontCache.get(filename);

  const font = await fsPromises.readFile(
    path.join(__dirname, "..", "fonts", filename),
  );
  fontCache.set(filename, font);
  return font;
}

async function getFontsByLanguage(languageType) {
  let filename = "Arial Bold.ttf";

  if (languageType === "jp" || languageType === "kr") {
    // Source hiện tại chưa có NotoSansKR; NotoSansJP là fallback gần nhất cho CJK.
    filename = "NotoSansJP-Bold.otf";
  } else if (languageType === "gr") {
    filename = "DejaVuSans-Bold.ttf";
  }

  return [
    {
      name: "StoryFont",
      data: await readFont(filename),
      weight: 700,
      style: "normal",
    },
  ];
}

function getLayoutByLanguage(languageType) {
  if (languageType === "jp") {
    return {
      bodyFontSize: 27,
      bodyLineHeight: 1.24,
      bodySidePadding: 28,
      nameFontSize: 28,
      followFontSize: 24,
      callFontSize: 22,
    };
  }

  if (languageType === "kr") {
    return {
      bodyFontSize: 28,
      bodyLineHeight: 1.24,
      bodySidePadding: 28,
      nameFontSize: 28,
      followFontSize: 24,
      callFontSize: 22,
    };
  }

  if (languageType === "gr") {
    return {
      bodyFontSize: 30,
      bodyLineHeight: 1.3,
      bodySidePadding: 32,
      nameFontSize: 29,
      followFontSize: 24,
      callFontSize: 22,
    };
  }

  return {
    bodyFontSize: 32,
    bodyLineHeight: 1.24,
    bodySidePadding: 28,
    nameFontSize: 30,
    followFontSize: 25,
    callFontSize: 23,
  };
}

function containsCjk(text = "") {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text);
}

function estimateTextWidth(text = "", fontSize = 30) {
  let width = 0;

  for (const char of Array.from(text)) {
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(char)) {
      width += fontSize;
    } else if (/[\u0370-\u03ff\u1f00-\u1fff]/.test(char)) {
      width += /[Α-Ω]/.test(char) ? fontSize * 0.68 : fontSize * 0.58;
    } else if (/[\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/.test(char)) {
      width += fontSize;
    } else if (/[\u2010-\u2027\u2500-\u257f]/.test(char)) {
      width += fontSize;
    } else if (/[A-Z]/.test(char)) {
      width += fontSize * 0.66;
    } else if (/[a-z]/.test(char)) {
      width += fontSize * 0.54;
    } else if (/[0-9]/.test(char)) {
      width += fontSize * 0.56;
    } else if (/\s/.test(char)) {
      width += fontSize * 0.28;
    } else {
      width += fontSize * 0.5;
    }
  }

  return width;
}

function parseMarkedContent(text = "") {
  const normalized = String(text)
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return [];

  const parts = [];
  const regex = /\[\[(.*?)\]\]/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(normalized))) {
    const before = normalized.slice(lastIndex, match.index);
    if (before) parts.push({ text: before, accent: false });
    if (match[1] && match[1].trim()) {
      parts.push({ text: match[1].trim(), accent: true });
    }
    lastIndex = match.index + match[0].length;
  }

  const after = normalized.slice(lastIndex);
  if (after) parts.push({ text: after, accent: false });

  return parts.length ? parts : [{ text: normalized, accent: false }];
}

function tokenizeStyledParts(parts = []) {
  const tokens = [];

  for (const part of parts) {
    if (!part || !part.text) continue;

    if (containsCjk(part.text)) {
      for (const char of Array.from(part.text)) {
        if (!char.trim()) continue;
        tokens.push({ text: char, accent: Boolean(part.accent), isCjk: true });
      }
    } else {
      for (const word of part.text.split(/\s+/).filter(Boolean)) {
        tokens.push({ text: word, accent: Boolean(part.accent), isCjk: false });
      }
    }
  }

  return tokens;
}

function removeLastWord(line) {
  const lastSegment = line.segments[line.segments.length - 1];
  if (!lastSegment) return;

  if (containsCjk(lastSegment.text)) {
    const characters = Array.from(lastSegment.text);
    characters.pop();
    if (characters.length) lastSegment.text = characters.join("");
    else line.segments.pop();
    return;
  }

  const hadLeadingSpace = /^\s/.test(lastSegment.text);
  const words = lastSegment.text.trim().split(/\s+/).filter(Boolean);

  if (words.length > 1) {
    words.pop();
    lastSegment.text = `${hadLeadingSpace ? " " : ""}${words.join(" ")}`;
  } else {
    line.segments.pop();
  }
}

function getLineWidth(line, fontSize) {
  return line.segments.reduce(
    (total, segment) => total + estimateTextWidth(segment.text, fontSize),
    0,
  );
}

function addEllipsisByWidth(line, maxLineWidth, fontSize) {
  if (!line.segments.length) {
    line.segments.push({ text: "...", accent: false });
    return line;
  }

  while (
    line.segments.length &&
    getLineWidth(line, fontSize) + estimateTextWidth("...", fontSize) >
      maxLineWidth
  ) {
    removeLastWord(line);
  }

  if (!line.segments.length) {
    line.segments.push({ text: "...", accent: false });
  } else {
    line.segments[line.segments.length - 1].text += "...";
  }

  return line;
}

function buildStyledLines(
  text = "",
  maxLineWidth = 648,
  maxLines = 18,
  maxVisibleChars = MAX_VISIBLE_TEXT_CHARS,
  fontSize = 30,
) {
  const tokens = tokenizeStyledParts(parseMarkedContent(text));
  const lines = [];
  let currentLine = { segments: [] };
  let currentWidth = 0;
  let visibleLength = 0;

  function pushLine() {
    if (currentLine.segments.length) lines.push(currentLine);
    currentLine = { segments: [] };
    currentWidth = 0;
  }

  function addToken(token) {
    const prefix = currentWidth && !token.isCjk ? " " : "";
    const tokenWidth = estimateTextWidth(`${prefix}${token.text}`, fontSize);
    if (currentWidth && currentWidth + tokenWidth > maxLineWidth) pushLine();

    const realPrefix = currentWidth && !token.isCjk ? " " : "";
    const finalText = `${realPrefix}${token.text}`;
    const lastSegment = currentLine.segments[currentLine.segments.length - 1];

    if (lastSegment && lastSegment.accent === token.accent) {
      lastSegment.text += finalText;
    } else {
      currentLine.segments.push({ text: finalText, accent: token.accent });
    }

    currentWidth += estimateTextWidth(finalText, fontSize);
  }

  for (const token of tokens) {
    const separatorLength = visibleLength && !token.isCjk ? 1 : 0;
    const nextVisibleLength = visibleLength + separatorLength + token.text.length;

    if (nextVisibleLength > maxVisibleChars) {
      if (currentLine.segments.length) {
        addEllipsisByWidth(currentLine, maxLineWidth, fontSize);
      } else if (lines.length) {
        addEllipsisByWidth(lines[lines.length - 1], maxLineWidth, fontSize);
      }
      break;
    }

    addToken(token);
    visibleLength = nextVisibleLength;
  }

  if (currentLine.segments.length) pushLine();
  if (lines.length <= maxLines) return lines;

  const visibleLines = lines.slice(0, maxLines);
  addEllipsisByWidth(visibleLines[visibleLines.length - 1], maxLineWidth, fontSize);
  return visibleLines;
}

function isEditorialSentenceBoundary(text, index) {
  const punctuation = text[index];
  if (![".", "!", "?"].includes(punctuation)) return false;
  if (punctuation !== ".") return true;

  const previousCharacter = text[index - 1] || "";
  const nextCharacter = text[index + 1] || "";
  if (/\d/.test(previousCharacter) && /\d/.test(nextCharacter)) return false;
  if (previousCharacter === "." || nextCharacter === ".") return false;

  const wordBeforePeriod =
    text.slice(0, index).match(/([\p{L}]+)$/u)?.[1]?.toLowerCase() || "";
  if (EDITORIAL_ABBREVIATIONS.has(wordBeforePeriod)) return false;

  if (wordBeforePeriod.length === 1) {
    const remainingText = text.slice(index + 1).trimStart();
    if (/^\p{L}/u.test(remainingText)) return false;
  }

  return !/(?:\p{L}\.){2,}$/u.test(text.slice(0, index + 1));
}

function splitEditorialSentences(text = "") {
  const normalized = String(text)
    .replace(/\r/g, " ")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];

  const sentences = [];
  let sentenceStart = 0;

  for (let index = 0; index < normalized.length; index++) {
    if (!isEditorialSentenceBoundary(normalized, index)) continue;

    let sentenceEnd = index + 1;
    while (
      sentenceEnd < normalized.length &&
      /[.!?"'”’»\])}]/.test(normalized[sentenceEnd])
    ) {
      sentenceEnd++;
    }

    const sentence = normalized.slice(sentenceStart, sentenceEnd).trim();
    if (sentence) sentences.push(sentence);
    while (sentenceEnd < normalized.length && /\s/.test(normalized[sentenceEnd])) {
      sentenceEnd++;
    }
    sentenceStart = sentenceEnd;
    index = sentenceEnd - 1;
  }

  const remainingText = normalized.slice(sentenceStart).trim();
  if (remainingText) sentences.push(remainingText);
  return sentences;
}

function selectEditorialHighlight(candidate = "") {
  const text = String(candidate).trim();
  if (!text) return "";

  const clauses = Array.from(text.matchAll(/[^,;:—–]+/g))
    .map((match) => ({
      start: match.index,
      words: Array.from(
        match[0].matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu),
      ),
    }))
    .filter((clause) => clause.words.length >= 2);

  if (!clauses.length) return text;

  const beginsWithQuote = /^["'“‘«]/.test(text);
  const clause = beginsWithQuote ? clauses[0] : clauses[clauses.length - 1];
  const selectedWords = beginsWithQuote
    ? clause.words.slice(0, 5)
    : clause.words.slice(-5);
  const firstWord = selectedWords[0];
  const lastWord = selectedWords[selectedWords.length - 1];
  const highlightStart = clause.start + firstWord.index;
  const wordHighlightEnd = clause.start + lastWord.index + lastWord[0].length;
  const trailingPunctuation =
    text.slice(wordHighlightEnd).match(/^[.!?]+/)?.[0] || "";
  const highlightEnd = wordHighlightEnd + trailingPunctuation.length;

  return `${text.slice(0, highlightStart)}[[${text.slice(
    highlightStart,
    highlightEnd,
  )}]]${text.slice(highlightEnd)}`;
}

function applyEditorialHighlights(text = "") {
  const source = String(text).replace(/\[\[|\]\]/g, "");
  const sentences = splitEditorialSentences(source);
  if (!sentences.length) return source.trim();

  const highlightCount = Math.min(
    5,
    Math.max(1, Math.round(sentences.length * 0.45)),
  );
  const highlightedIndexes = new Set();

  if (highlightCount === 1) {
    highlightedIndexes.add(Math.floor(sentences.length / 2));
  } else {
    for (let index = 0; index < highlightCount; index++) {
      highlightedIndexes.add(
        Math.round((index * (sentences.length - 1)) / (highlightCount - 1)),
      );
    }
  }

  return sentences
    .map((sentence, index) =>
      highlightedIndexes.has(index)
        ? selectEditorialHighlight(sentence)
        : sentence,
    )
    .join(" ");
}

function createEditorialParagraphs(text = "") {
  const sentences = splitEditorialSentences(text);
  const paragraphs = [];

  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index];
    const nextSentence = sentences[index + 1];
    const currentLength = sentence.replace(/\[\[|\]\]/g, "").length;
    const nextLength = nextSentence
      ? nextSentence.replace(/\[\[|\]\]/g, "").length
      : 0;

    if (
      nextSentence &&
      currentLength <= 110 &&
      nextLength <= 110 &&
      currentLength + nextLength <= 190
    ) {
      paragraphs.push(`${sentence} ${nextSentence}`);
      index++;
    } else {
      paragraphs.push(sentence);
    }
  }

  return paragraphs.join("\n");
}

function buildEditorialLines(text = "", maxLineWidth = 760, maxLines = 28, fontSize = 32) {
  const paragraphs = String(text)
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const lines = [];

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const remainingLines = maxLines - lines.length;
    if (remainingLines <= 0) break;

    const paragraphLines = buildStyledLines(
      paragraphs[paragraphIndex],
      maxLineWidth,
      remainingLines,
      2000,
      fontSize,
    );

    paragraphLines.forEach((line, lineIndex) => {
      lines.push({
        ...line,
        paragraphStart: lineIndex === 0 && lines.length > 0,
      });
    });
  }

  if (lines.length === maxLines && lines.length) {
    addEllipsisByWidth(lines[lines.length - 1], maxLineWidth, fontSize);
  }
  return lines;
}

function element(type, style, children, extraProps = {}) {
  return {
    type,
    props: {
      ...extraProps,
      ...(style ? { style } : {}),
      ...(children !== undefined ? { children } : {}),
    },
  };
}

function image(src, width, height, style) {
  return element("img", style, undefined, { src, width, height, alt: "" });
}

function renderLine(line, options) {
  const {
    lineIndex,
    lineHeight,
    lineGap = 0,
    normalColor,
    accentColor,
    accentBackground = null,
    paragraphGap = 0,
    textShadow,
  } = options;

  return element(
    "div",
    {
      display: "flex",
      flexDirection: "row",
      flexWrap: "nowrap",
      width: "100%",
      minHeight: lineHeight,
      marginTop: line.paragraphStart ? paragraphGap : 0,
      marginBottom: lineGap,
    },
    line.segments.map((segment, segmentIndex) =>
      element(
        "span",
        {
          display: "block",
          color: accentBackground ? normalColor : segment.accent ? accentColor : normalColor,
          background: segment.accent && accentBackground ? accentBackground : "transparent",
          padding: segment.accent && accentBackground ? "0 3px" : "0",
          marginLeft:
            segment.accent && accentBackground && /^\s/.test(segment.text) ? 2 : 0,
          fontWeight: 700,
          whiteSpace: "pre",
          ...(textShadow ? { textShadow } : {}),
        },
        segment.text,
        { key: `${lineIndex}-${segmentIndex}` },
      ),
    ),
    { key: lineIndex },
  );
}

function createEditorialElement({
  backgroundUrl,
  avatar,
  name,
  footer,
  lines,
  fontSize,
  lineHeight,
  bodyHeight,
}) {
  return element(
    "div",
    {
      width: EDITORIAL_LAYOUT_W,
      height: EDITORIAL_LAYOUT_H,
      position: "relative",
      overflow: "hidden",
      display: "flex",
      background: "#eef8f0",
      fontFamily: "StoryFont",
    },
    [
      image(backgroundUrl, EDITORIAL_LAYOUT_W, EDITORIAL_LAYOUT_H, {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
      }),
      element("div", {
        position: "absolute",
        inset: 0,
        display: "flex",
        background: "rgba(244,252,246,0.16)",
      }),
      element(
        "div",
        {
          position: "absolute",
          top: 50,
          left: 72,
          right: 72,
          height: 104,
          display: "flex",
          alignItems: "center",
        },
        [
          image(avatar, 86, 86, {
            width: 86,
            height: 86,
            borderRadius: 9999,
            objectFit: "cover",
            flexShrink: 0,
            border: "2px solid rgba(20,20,20,0.24)",
          }),
          element(
            "div",
            {
              marginLeft: 18,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              color: "#454545",
            },
            [
              element(
                "div",
                {
                  display: "flex",
                  alignItems: "center",
                  height: 35,
                  fontSize: 27,
                  fontWeight: 700,
                },
                [
                  element("span", { display: "block", filter: "blur(5px)", opacity: 0.72 }, name),
                  element(
                    "span",
                    {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 23,
                      height: 23,
                      marginLeft: 10,
                      borderRadius: 9999,
                      background: "#1877f2",
                    },
                    element("span", {
                      display: "block",
                      width: 10,
                      height: 6,
                      marginTop: -2,
                      borderLeft: "3px solid #ffffff",
                      borderBottom: "3px solid #ffffff",
                      transform: "rotate(-45deg)",
                    }),
                  ),
                ],
              ),
              element(
                "div",
                {
                  display: "flex",
                  marginTop: 3,
                  color: "#666666",
                  fontSize: 23,
                  fontWeight: 700,
                },
                "Just now · A Text Story",
              ),
            ],
          ),
        ],
      ),
      element(
        "div",
        {
          position: "absolute",
          top: 170,
          left: 72,
          right: 72,
          height: bodyHeight,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          color: EDITORIAL_TEXT_COLOR,
          fontSize,
          fontWeight: 700,
          lineHeight: `${lineHeight}px`,
          textAlign: "left",
        },
        lines.map((line, lineIndex) =>
          renderLine(line, {
            lineIndex,
            lineHeight,
            normalColor: EDITORIAL_TEXT_COLOR,
            accentColor: EDITORIAL_TEXT_COLOR,
            accentBackground: EDITORIAL_ACCENT_COLOR,
            paragraphGap: 16,
          }),
        ),
      ),
      element(
        "div",
        {
          position: "absolute",
          left: 72,
          right: 58,
          bottom: 42,
          display: "flex",
          alignItems: "center",
          color: EDITORIAL_TEXT_COLOR,
          fontSize: 31,
          fontWeight: 700,
          lineHeight: 1.05,
        },
        footer,
      ),
    ],
  );
}

function createStandardElement(options) {
  const {
    canvasWidth,
    canvasHeight,
    backgroundUrl,
    backgroundColor,
    transparent,
    hasHeader,
    hasCall,
    simpleTextMode,
    avatar,
    name,
    follow,
    call,
    textColor,
    accentColor,
    layout,
    bodyTop,
    bodyAreaHeight,
    bodySidePadding,
    textBoxPaddingX,
    textBoxPaddingY,
    bodyFontSize,
    lineHeightPx,
    textLineGap,
    lines,
  } = options;

  const children = [];

  if (!transparent && backgroundColor) {
    children.push(
      element("div", {
        position: "absolute",
        inset: 0,
        display: "flex",
        width: "100%",
        height: "100%",
        background: backgroundColor,
      }),
    );
  } else if (!transparent && backgroundUrl) {
    children.push(
      image(backgroundUrl, canvasWidth, canvasHeight, {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
      }),
    );
  }

  if (hasHeader) {
    const identityChildren = [];
    if (avatar) {
      identityChildren.push(
        image(avatar, 82, 82, {
          width: 82,
          height: 82,
          borderRadius: 9999,
          objectFit: "cover",
          flexShrink: 0,
          border: "3px solid rgba(255,255,255,0.95)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.30)",
        }),
      );
    }
    if (name) {
      identityChildren.push(
        element(
          "div",
          {
            display: "flex",
            alignItems: "center",
            marginLeft: avatar ? 16 : 4,
            color: textColor,
            fontSize: layout.nameFontSize,
            fontWeight: 800,
            lineHeight: 1.1,
            maxWidth: follow ? 400 : 540,
            overflow: "hidden",
            textShadow: SOFT_TEXT_SHADOW,
          },
          String(name),
        ),
      );
    }

    children.push(
      element(
        "div",
        {
          position: "absolute",
          top: 28,
          left: 24,
          right: 24,
          height: 112,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 16px",
          boxSizing: "border-box",
          background: "rgba(20,24,27,0.40)",
          borderRadius: 30,
          border: "1px solid rgba(255,255,255,0.18)",
          boxShadow: "0 6px 18px rgba(0,0,0,0.20)",
        },
        [
          element(
            "div",
            {
              display: "flex",
              alignItems: "center",
              minWidth: 0,
              flex: 1,
            },
            identityChildren,
          ),
          follow
            ? element(
                "div",
                {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginLeft: 14,
                  padding: "11px 18px",
                  borderRadius: 9999,
                  background: "rgba(255,255,255,0.94)",
                  border: "1px solid rgba(255,255,255,0.65)",
                  color: "#1769e0",
                  fontSize: layout.followFontSize,
                  fontWeight: 900,
                  lineHeight: 1,
                  whiteSpace: "nowrap",
                  boxShadow: "0 4px 10px rgba(0,0,0,0.18)",
                },
                String(follow),
              )
            : null,
        ].filter(Boolean),
      ),
    );
  }

  children.push(
    element(
      "div",
      {
        position: "absolute",
        top: bodyTop,
        left: bodySidePadding,
        right: bodySidePadding,
        height: bodyAreaHeight,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        justifyContent: simpleTextMode ? "center" : "flex-start",
        alignItems: "flex-start",
        padding: `${textBoxPaddingY}px ${textBoxPaddingX}px`,
        boxSizing: "border-box",
        // Satori có thể bỏ qua cả subtree khi một absolute flex container hoàn
        // toàn trong suốt. Tô lại đúng màu canvas giữ nguyên hình ảnh đầu ra.
        background: simpleTextMode
          ? backgroundColor
          : "rgba(15,18,20,0.45)",
        ...(simpleTextMode
          ? {}
          : {
              borderRadius: 28,
              border: "1px solid rgba(255,255,255,0.14)",
              boxShadow: "0 7px 20px rgba(0,0,0,0.18)",
            }),
        textAlign: "left",
        color: textColor,
        fontSize: bodyFontSize,
        fontWeight: 700,
        lineHeight: `${lineHeightPx}px`,
        textShadow: BODY_TEXT_SHADOW,
      },
      lines.map((line, lineIndex) =>
        renderLine(line, {
          lineIndex,
          lineHeight: lineHeightPx,
          lineGap: lineIndex === lines.length - 1 ? 0 : textLineGap,
          normalColor: textColor,
          accentColor,
          textShadow: BODY_TEXT_SHADOW,
        }),
      ),
    ),
  );

  if (hasCall) {
    children.push(
      element(
        "div",
        {
          position: "absolute",
          left: 96,
          right: 96,
          bottom: 30,
          minHeight: 80,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: "12px 24px",
          boxSizing: "border-box",
          borderRadius: 9999,
          background: "rgba(15,18,20,0.45)",
          border: "1px solid rgba(255,255,255,0.16)",
          boxShadow: "0 5px 15px rgba(0,0,0,0.20)",
        },
        element(
          "div",
          {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            maxWidth: "100%",
            color: textColor,
            fontSize: layout.callFontSize,
            fontWeight: 700,
            lineHeight: 1.15,
            textAlign: "center",
            textShadow: SOFT_TEXT_SHADOW,
          },
          String(call).trim(),
        ),
      ),
    );
  }

  return element(
    "div",
    {
      width: canvasWidth,
      height: canvasHeight,
      position: "relative",
      overflow: "hidden",
      display: "flex",
      background: transparent ? "rgba(0,0,0,0)" : "#ffffff",
      fontFamily: "StoryFont",
    },
    children,
  );
}

async function renderImage({ elementTree, fonts, width, height, transparent }) {
  const satori = await getSatori();
  const svg = await satori(elementTree, { width, height, fonts });
  const pipeline = sharp(Buffer.from(svg));

  if (transparent) {
    return pipeline.png({ compressionLevel: 6 }).toBuffer();
  }

  return pipeline
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function uploadWithRetry(imageBuffer, filename, mimeType) {
  await fsPromises.mkdir(TEMP_DIR, { recursive: true });
  const sourcePath = path.join(TEMP_DIR, filename);
  let lastError;

  try {
    await fsPromises.writeFile(sourcePath, imageBuffer);

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const result = await uploadTempMedia(sourcePath, filename, {
          mediaType: "image",
          mimeType,
          service: "local-vps-temp-media",
        });
        return { ...result, attempts: attempt };
      } catch (error) {
        lastError = error;
        console.error(
          `[story-style] upload attempt ${attempt}/${MAX_RETRY} failed:`,
          error.message,
        );
        if (attempt < MAX_RETRY) {
          await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
        }
      }
    }

    throw lastError;
  } finally {
    await fsPromises.unlink(sourcePath).catch(() => {});
  }
}

router.post("/", async (req, res) => {
  try {
    const {
      backgroundUrl,
      urlBackgroud,
      backgroundColor,
      content,
      language,
      layout: requestedLayout,
      footer,
      call,
      name,
      avatar,
      follow,
      transparent = false,
      textColor,
      accentColor,
      whiteTextColor,
      yellowTextColor,
    } = req.body || {};

    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, error: "Missing content" });
    }

    const useEditorialLayout = isTruthy(requestedLayout);
    const isTransparent = isTruthy(transparent);
    const languageType = normalizeLanguage(language);
    const fonts = await getFontsByLanguage(languageType);

    if (useEditorialLayout) {
      const editorialBackgroundUrl = urlBackgroud || backgroundUrl;
      if (!editorialBackgroundUrl) {
        return res
          .status(400)
          .json({ success: false, error: "Missing urlBackgroud" });
      }

      const editorialContent = createEditorialParagraphs(
        applyEditorialHighlights(content),
      );
      const contentLength = editorialContent.replace(/\[\[|\]\]/g, "").length;
      const baseFontSize = contentLength <= 500 ? 40 : contentLength <= 900 ? 35 : 32;
      const fontSize = containsCjk(editorialContent)
        ? baseFontSize - 2
        : baseFontSize;
      const lineHeight = Math.ceil(fontSize * 1.13);
      const bodyHeight = 1140;
      const paragraphCount = editorialContent.split("\n").filter(Boolean).length;
      const maxLines = Math.max(
        1,
        Math.min(
          28,
          Math.floor((bodyHeight - Math.max(0, paragraphCount - 1) * 16) / lineHeight),
        ),
      );
      const lines = buildEditorialLines(
        editorialContent,
        756,
        maxLines,
        fontSize,
      );
      const finalFooter =
        footer && String(footer).trim()
          ? String(footer).trim()
          : "Continue Read More...";
      const finalName = name && String(name).trim() ? String(name).trim() : "Emily Carter";

      const elementTree = createEditorialElement({
        backgroundUrl: editorialBackgroundUrl,
        avatar: avatar || EDITORIAL_DEFAULT_AVATAR,
        name: finalName,
        footer: finalFooter,
        lines,
        fontSize,
        lineHeight,
        bodyHeight,
      });
      const imageBuffer = await renderImage({
        elementTree,
        fonts,
        width: EDITORIAL_LAYOUT_W,
        height: EDITORIAL_LAYOUT_H,
        transparent: false,
      });
      const uploadResult = await uploadWithRetry(
        imageBuffer,
        `story-editorial-${Date.now()}.jpg`,
        "image/jpeg",
      );

      return res.json({
        success: true,
        imageUrl: uploadResult.url,
        service: uploadResult.service,
        attempts: uploadResult.attempts,
        width: EDITORIAL_LAYOUT_W,
        height: EDITORIAL_LAYOUT_H,
        language: languageType || "default",
        transparent: false,
        backgroundType: "image",
        backgroundColor: null,
        simpleTextMode: false,
        editorialLayout: true,
        format: "jpg",
      });
    }

    const finalBackgroundColor = getOptionalHexColor(backgroundColor);
    if (!isTransparent && !finalBackgroundColor && !backgroundUrl) {
      return res.status(400).json({
        success: false,
        error: "Missing backgroundUrl or valid backgroundColor",
      });
    }

    const isColorBackgroundMode = !isTransparent && Boolean(finalBackgroundColor);
    const canvasWidth = isColorBackgroundMode ? COLOR_BG_W : W;
    const canvasHeight = isColorBackgroundMode ? COLOR_BG_H : H;
    const layout = getLayoutByLanguage(languageType);
    const finalTextColor = normalizeHexColor(
      textColor ?? whiteTextColor,
      DEFAULT_TEXT_COLOR,
    );
    const finalAccentColor = normalizeHexColor(
      accentColor ?? yellowTextColor,
      DEFAULT_ACCENT_COLOR,
    );
    const hasHeader = Boolean(avatar || name || follow);
    const hasCall = Boolean(call && String(call).trim());
    const simpleTextMode =
      !isTransparent && !hasHeader && !hasCall && Boolean(finalBackgroundColor);
    const imageBackgroundMode =
      !isTransparent && !finalBackgroundColor && Boolean(backgroundUrl);
    const bodyFontSize = simpleTextMode
      ? Math.round(layout.bodyFontSize * 1.35)
      : imageBackgroundMode
        ? Math.round(layout.bodyFontSize * 1.15)
        : layout.bodyFontSize;
    const bodyTop = hasHeader ? 156 : simpleTextMode ? 80 : 34;
    const bodyBottomPadding = hasCall ? 128 : simpleTextMode ? 80 : 34;
    const bodyAreaHeight = canvasHeight - bodyTop - bodyBottomPadding;
    const lineHeightPx = Math.ceil(bodyFontSize * layout.bodyLineHeight);
    const textLineGap = 4;
    const bodySidePadding =
      languageType === "jp"
        ? 40
        : languageType === "kr"
          ? 34
          : layout.bodySidePadding;
    const textBoxPaddingX = simpleTextMode ? 42 : 34;
    const textBoxPaddingY = simpleTextMode ? 30 : 22;
    const maxTextLines = Math.max(
      1,
      Math.floor(
        (bodyAreaHeight - textBoxPaddingY * 2 + textLineGap) /
          (lineHeightPx + textLineGap),
      ),
    );
    const textWidthSafety = languageType === "jp" ? 50 : languageType === "kr" ? 24 : 0;
    const maxLineWidth =
      canvasWidth - bodySidePadding * 2 - textBoxPaddingX * 2 - textWidthSafety;
    const lines = buildStyledLines(
      content,
      maxLineWidth,
      maxTextLines,
      isColorBackgroundMode
        ? COLOR_BG_MAX_VISIBLE_TEXT_CHARS
        : MAX_VISIBLE_TEXT_CHARS,
      bodyFontSize,
    );

    const elementTree = createStandardElement({
      canvasWidth,
      canvasHeight,
      backgroundUrl,
      backgroundColor: finalBackgroundColor,
      transparent: isTransparent,
      hasHeader,
      hasCall,
      simpleTextMode,
      avatar,
      name,
      follow,
      call,
      textColor: finalTextColor,
      accentColor: finalAccentColor,
      layout,
      bodyTop,
      bodyAreaHeight,
      bodySidePadding,
      textBoxPaddingX,
      textBoxPaddingY,
      bodyFontSize,
      lineHeightPx,
      textLineGap,
      lines,
    });
    const imageBuffer = await renderImage({
      elementTree,
      fonts,
      width: canvasWidth,
      height: canvasHeight,
      transparent: isTransparent,
    });
    const extension = isTransparent ? "png" : "jpg";
    const mimeType = isTransparent ? "image/png" : "image/jpeg";
    const uploadResult = await uploadWithRetry(
      imageBuffer,
      `story-overlay-${Date.now()}.${extension}`,
      mimeType,
    );

    return res.json({
      success: true,
      imageUrl: uploadResult.url,
      service: uploadResult.service,
      attempts: uploadResult.attempts,
      width: canvasWidth,
      height: canvasHeight,
      language: languageType || "default",
      transparent: isTransparent,
      backgroundType: isTransparent
        ? "transparent"
        : finalBackgroundColor
          ? "color"
          : "image",
      backgroundColor: !isTransparent ? finalBackgroundColor : null,
      simpleTextMode,
      editorialLayout: false,
      format: extension,
    });
  } catch (error) {
    console.error("[story-style] error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown error",
    });
  }
});

module.exports = router;
