const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn } = require("child_process");
const { pipeline } = require("stream");
const { promisify } = require("util");

const { uploadVideo: uploadVideoVps } = require("../utils/uploadVps");
const { uploadVideo: uploadVideoTemp } = require("../utils/uploadTempVideo");

// UPLOAD TEST
// const { uploadVideo: uploadVideoVps } = require("../utils/uploadService");

// UPLOAD TEMP
// const { uploadVideo } = require("../utils/uploadTempVideo");

const router = express.Router();
const pipelineAsync = promisify(pipeline);

const OUTPUT_FPS = 25;
const OUTPUT_CRF = 24;
const OUTPUT_PRESET = "superfast";
const COMMAND_LOG_TAIL_CHARS = 20000;
const BACKGROUND_IMAGE_MARGIN_X = 14;
const BACKGROUND_IMAGE_MARGIN_Y = 25;

const TEMP_DIR = path.join(__dirname, "..", "temp");
const BG_VIDEO_FILE = path.join(__dirname, "..", "us.mp4");

const FIXED_BACKGROUND_LINKS = [
  "https://file.garden/aiDkIHaSGigyN2Yb/background/HJHJJH.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/Thuy_Si_-_Thien_duong_tren_mat_dat_switzerland_nat_no_watermark_online-video-cutter.com_.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/stock-footage-landscape-reveal-as-drone-pushes-forward-revealing-brecon-beacons-perfect-for-travel-documentaries.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/snaptik.vn_7597206803176295712.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/snaptik.vn_7649990817242680594.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/15730634_2160_3840_60fps.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/YouTube.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/15360412-uhd_2160_3840_30fps.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/789.mp4",
  "https://file.garden/aiDkIHaSGigyN2Yb/background/YR.mp4",
];

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function q(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, {
        recursive: true,
        force: true,
      });
    }
  } catch (error) {
    console.warn(`Cleanup failed: ${error.message}`);
  }
}

function shuffleItems(items) {
  const shuffled = items.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));

    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ];
  }

  return shuffled;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function getFixedMediaLinks(links) {
  return links.map((link) => String(link || "").trim()).filter(isHttpUrl);
}

function toEven(value) {
  return Math.max(2, Math.ceil(Number(value) / 2) * 2);
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
    let settled = false;

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
      if (settled) return;
      settled = true;

      reject(new Error(`[${label}] ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `[${label}] ${stderr.trim() || `Process exited with code ${code}`}`,
        ),
      );
    });
  });
}

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

async function probeMediaFile(filePath, streamType, label) {
  const expectedCodecType = streamType === "a" ? "audio" : "video";

  const command = [
    "ffprobe -v error",
    `-select_streams ${streamType}:0`,
    "-show_entries stream=codec_type",
    "-of csv=p=0",
    q(filePath),
  ].join(" ");

  const result = await runCommand(command, `probe-${label}`);

  const streamTypes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!streamTypes.includes(expectedCodecType)) {
    throw new Error(`No ${expectedCodecType} stream found`);
  }
}

async function getMediaDimensions(filePath, label) {
  const command = [
    "ffprobe -v error",
    "-select_streams v:0",
    "-show_entries stream=width,height",
    "-of csv=p=0:s=x",
    q(filePath),
  ].join(" ");

  const result = await runCommand(command, `probe-dimensions-${label}`);

  const match = result.stdout.trim().match(/^(\d+)x(\d+)$/);

  if (!match) {
    throw new Error(`Cannot determine ${label} dimensions`);
  }

  return {
    width: Number(match[1]),
    height: Number(match[2]),
  };
}

async function downloadRemoteMediaWithFallback({
  links,
  tempDir,
  fileName,
  label,
  streamType,
}) {
  const candidates = shuffleItems(getFixedMediaLinks(links));

  for (let index = 0; index < candidates.length; index += 1) {
    const url = candidates[index];

    const mediaPath = path.join(tempDir, `${fileName}-${index}`);

    try {
      await downloadFile(url, mediaPath);

      await probeMediaFile(mediaPath, streamType, label.toLowerCase());

      return {
        path: mediaPath,
        source: url,
      };
    } catch (error) {
      console.warn(`${label} link failed: ${url}`);
      console.warn(`   ${error.message}`);

      try {
        if (fs.existsSync(mediaPath)) {
          fs.unlinkSync(mediaPath);
        }
      } catch (unlinkError) {
        console.warn(`Failed to remove bad ${label}: ${unlinkError.message}`);
      }
    }
  }

  return {
    path: null,
    source: null,
  };
}

async function createStillImageVideo({
  imagePath,
  audioPath,
  outputPath,
  seconds,
}) {
  const command = [
    "ffmpeg -y",

    // Ảnh tĩnh được lặp liên tục.
    `-loop 1 -framerate ${OUTPUT_FPS} -i ${q(imagePath)}`,

    // Audio được lặp nếu ngắn hơn thời lượng yêu cầu.
    `-stream_loop -1 -i ${q(audioPath)}`,

    `-t ${Number(seconds).toFixed(3)}`,

    // Giữ nguyên tỷ lệ ảnh, không crop, không pad.
    // Chỉ giảm kích thước nếu cạnh lớn nhất vượt quá 1920 px.
    `-vf "scale='if(gt(max(iw,ih),1920),if(gte(iw,ih),1920,-2),trunc(iw/2)*2)':'if(gt(max(iw,ih),1920),if(gte(iw,ih),-2,1920),trunc(ih/2)*2)':flags=lanczos,setsar=1,format=yuv420p"`,

    `-c:v libx264`,
    `-preset ${OUTPUT_PRESET}`,
    `-crf ${OUTPUT_CRF}`,
    `-r ${OUTPUT_FPS}`,
    `-threads 2`,

    `-c:a aac`,
    `-b:a 128k`,

    // Dừng audio đúng theo thời lượng video.
    `-shortest`,

    `-movflags +faststart`,
    q(outputPath),
  ].join(" ");

  await runCommand(command, "create-still-image-video");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Không tạo được file video");
  }

  return outputPath;
}

async function createStillImageVideoWithBackground({
  imagePath,
  backgroundPath,
  audioPath,
  outputPath,
  tempDir,
  seconds,
}) {
  const duration = Number(seconds).toFixed(3);
  const imageDimensions = await getMediaDimensions(imagePath, "image");
  const canvasW = toEven(imageDimensions.width + BACKGROUND_IMAGE_MARGIN_X * 2);
  const canvasH = toEven(
    imageDimensions.height + BACKGROUND_IMAGE_MARGIN_Y * 2,
  );
  const imageX = Math.floor((canvasW - imageDimensions.width) / 2);
  const imageY = Math.floor((canvasH - imageDimensions.height) / 2);
  const filterPath = path.join(tempDir, "background_filter.txt");

  const filterParts = [
    `[0:v]` +
      `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase:flags=fast_bilinear,` +
      `crop=${canvasW}:${canvasH},` +
      `fps=${OUTPUT_FPS},` +
      `setpts=N/(${OUTPUT_FPS}*TB),` +
      `setsar=1,` +
      `format=yuv420p` +
      `[bg]`,

    `[1:v]` + `setsar=1,` + `format=rgba` + `[fg]`,

    `[2:a]` +
      `aresample=async=1:first_pts=0,` +
      `asetpts=N/SR/TB,` +
      `atrim=duration=${duration}` +
      `[a]`,

    `[bg][fg]` +
      `overlay=${imageX}:${imageY}:format=auto,` +
      `fps=${OUTPUT_FPS},` +
      `format=yuv420p,` +
      `setpts=N/(${OUTPUT_FPS}*TB)` +
      `[v]`,
  ];

  fs.writeFileSync(filterPath, filterParts.join(";"), "utf8");

  const command = [
    "ffmpeg -y",

    // Video nền được lặp và chỉ dùng track hình.
    `-stream_loop -1 -i ${q(backgroundPath)}`,

    // Ảnh chính vẫn là ảnh tĩnh, đặt nổi trên nền.
    `-loop 1 -framerate ${OUTPUT_FPS} -i ${q(imagePath)}`,

    // Audio ngoài được giữ như logic cũ, lặp nếu ngắn hơn duration.
    `-stream_loop -1 -i ${q(audioPath)}`,

    `-filter_complex_script ${q(filterPath)}`,

    `-map "[v]"`,
    `-map "[a]"`,

    `-t ${duration}`,

    `-c:v libx264`,
    `-preset ${OUTPUT_PRESET}`,
    `-crf ${OUTPUT_CRF}`,
    `-pix_fmt yuv420p`,
    `-r ${OUTPUT_FPS}`,
    `-threads 2`,

    `-c:a aac`,
    `-b:a 128k`,

    `-movflags +faststart`,
    q(outputPath),
  ].join(" ");

  await runCommand(command, "create-still-image-video-with-background");

  if (!fs.existsSync(outputPath)) {
    throw new Error("Không tạo được file video");
  }

  return {
    outputPath,
    metadata: {
      resolution: `${canvasW}x${canvasH}`,
      imageResolution: `${imageDimensions.width}x${imageDimensions.height}`,
      backgroundMarginX: imageX,
      backgroundMarginY: imageY,
    },
  };
}

/**
 * POST /api/image-to-video
 *
 * Body:
 * {
 *   "imageUrl": "https://example.com/image.jpg",
 *   "audioUrl": "https://example.com/audio.mp3",
 *   "seconds": 10,
 *   "background": true
 * }
 */
router.post("/", async (req, res) => {
  const { imageUrl, audioUrl, seconds, tempFile, background } = req.body || {};

  if (typeof imageUrl !== "string" || !imageUrl.trim()) {
    return res.status(400).json({
      success: false,
      error: "imageUrl is required",
    });
  }

  if (typeof audioUrl !== "string" || !audioUrl.trim()) {
    return res.status(400).json({
      success: false,
      error: "audioUrl is required",
    });
  }

  const duration = Number(seconds);

  if (!Number.isFinite(duration) || duration <= 0) {
    return res.status(400).json({
      success: false,
      error: "seconds must be a positive number",
    });
  }

  const useTempFile =
    tempFile === true ||
    tempFile === "true" ||
    tempFile === 1 ||
    tempFile === "1";

  const useBackground =
    background === true ||
    background === "true" ||
    background === 1 ||
    background === "1";

  const requestId = `still_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const tempDir = path.join(TEMP_DIR, requestId);
  const imagePath = path.join(tempDir, "image");
  const audioPath = path.join(tempDir, "audio");
  const outputPath = path.join(tempDir, "final.mp4");

  fs.mkdirSync(tempDir, {
    recursive: true,
  });

  try {
    // Tải ảnh, audio và background (nếu bật) song song.
    const downloads = [
      downloadFile(imageUrl.trim(), imagePath),
      downloadFile(audioUrl.trim(), audioPath),
    ];

    const backgroundDownload = useBackground
      ? downloadRemoteMediaWithFallback({
          links: FIXED_BACKGROUND_LINKS,
          tempDir,
          fileName: "background-source",
          label: "Background",
          streamType: "v",
        })
      : Promise.resolve({ path: null, source: null });

    downloads.push(backgroundDownload);

    const [, , backgroundResult] = await Promise.all(downloads);

    let backgroundPath = null;
    let backgroundSource = null;

    if (useBackground) {
      backgroundPath = backgroundResult.path;
      backgroundSource = backgroundResult.source;

      if (backgroundPath) {
        console.log(`Background URL: ${backgroundSource}`);
      } else if (fs.existsSync(BG_VIDEO_FILE)) {
        backgroundPath = BG_VIDEO_FILE;
        backgroundSource = path.basename(BG_VIDEO_FILE);
        console.log(`Fallback background: ${backgroundSource}`);
      } else {
        throw new Error(
          "No usable background found and missing fallback: us.mp4",
        );
      }
    }

    let renderMetadata = null;

    if (useBackground) {
      const renderResult = await createStillImageVideoWithBackground({
        imagePath,
        backgroundPath,
        audioPath,
        outputPath,
        tempDir,
        seconds: duration,
      });

      renderMetadata = renderResult.metadata;
    } else {
      await createStillImageVideo({
        imagePath,
        audioPath,
        outputPath,
        seconds: duration,
      });
    }

    const fileName = `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}.mp4`;

    const uploadResult = useTempFile
      ? await uploadVideoTemp(outputPath, fileName)
      : await uploadVideoVps(outputPath, fileName);

    if (!uploadResult?.url) {
      throw new Error("Upload video failed");
    }

    const metadata = {
      duration: Number(duration.toFixed(2)),
      fps: OUTPUT_FPS,
      crf: OUTPUT_CRF,
      preset: OUTPUT_PRESET,
      layout: "still image + audio",
    };

    if (useBackground) {
      metadata.background = true;
      metadata.backgroundSource = backgroundSource;
      metadata.resolution = renderMetadata?.resolution || null;
      metadata.imageResolution = renderMetadata?.imageResolution || null;
      metadata.backgroundMarginX = renderMetadata?.backgroundMarginX ?? null;
      metadata.backgroundMarginY = renderMetadata?.backgroundMarginY ?? null;
      metadata.layout = "background video + original image + audio";
    }

    return res.status(200).json({
      success: true,
      url: uploadResult.url,
      service: uploadResult.service || null,
      permanent: uploadResult.permanent || false,
      metadata,
    });
  } catch (error) {
    console.error(`Create still video failed (${requestId}):`, error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Create video failed",
    });
  } finally {
    cleanupTempDir(tempDir);
  }
});

module.exports = router;
