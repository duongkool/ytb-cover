// routes/batchHookV7.js
// V7: Title top (đen, centered) + Slideshow 720x575 + Subtitle band đen 720x100 + BG Video 720x405
// Layout: Title 720x200 | Image 720x575 | SubtitleBand 720x100 | BG Video 720x405
// Total: 720x1280
// Job-based: POST / → jobId, GET /:jobId → poll, GET /:jobId/events → SSE

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { promisify } = require('util');
const { exec } = require('child_process');
const { EventEmitter } = require('events');
const { generateAudioFromText } = require('../utils/audioGenerator');
const { uploadVideo } = require('../utils/uploadMe');

const execAsync = promisify(exec);
const router = express.Router();

// ─── Job store ────────────────────────────────────────────────────────────────
const jobs = new Map();
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(1000);
const JOB_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Constants ────────────────────────────────────────────────────────────────
const W = 720;
const TITLE_H = 200;
const IMAGE_H = 575;
const SUB_BAND_H = 100;
const BG_H = 405;
const TOTAL_H = 1280;

// Title
const TITLE_FONT_SIZE = 56;
const TITLE_MAX_CHARS = 26;
const TITLE_LINE_H = 66;
const TITLE_MARGIN_T = 18;

// Subtitle band
const SUBTITLE_FONT_SIZE = 38;
const SUBTITLE_MARGIN_V = 18;
const SUBTITLE_MARGIN_H = 25;

// Slideshow
const SEC_PER_SLIDE = 5;
const TRANSITION = 0.5;

// BG Video
const BG_VIDEO_PATH = path.join(__dirname, '..', 'background_video.mp4');

// ─── Temp dir ─────────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Font paths ───────────────────────────────────────────────────────────────
const FONT_PATH = path.join(__dirname, '..', 'fonts', 'BebasNeue-Regular.ttf')
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_, d) => `${d}\\:`);

const FONTS_DIR = path.join(__dirname, '..', 'fonts')
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_, d) => `${d}\\:`);

// ─── Job helpers ──────────────────────────────────────────────────────────────
function generateJobId() {
    return `hv7_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJob(jobId) {
    return jobs.get(jobId) || null;
}

function setJob(jobId, patch) {
    const next = { ...(jobs.get(jobId) || {}), ...patch, updatedAt: new Date().toISOString() };
    jobs.set(jobId, next);
    jobEvents.emit(`job:${jobId}`, next);
    return next;
}

function createJob(payload) {
    const jobId = generateJobId();
    const now = new Date().toISOString();
    const job = {
        id: jobId,
        status: 'queued',
        progress: 0,
        step: 'queued',
        message: 'Job đã được tạo, đang chờ xử lý',
        createdAt: now,
        updatedAt: now,
        payload: {
            content: payload.content,
            title: payload.title,
            images: payload.images,
            language: payload.language || 'en',
        },
        result: null,
        error: null,
    };
    jobs.set(jobId, job);
    return job;
}

function sanitizeError(e) {
    return e?.message || 'Unknown error';
}

function cleanupTempDir(dir) {
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        console.log(`🗑️ Cleaned: ${dir}`);
    } catch (e) {
        console.warn(`⚠️ Cleanup failed: ${e.message}`);
    }
}

function cleanupExpiredJobs() {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
        if (now - new Date(job.updatedAt || job.createdAt).getTime() > JOB_TTL_MS) {
            jobs.delete(id);
        }
    }
}
setInterval(cleanupExpiredJobs, 60 * 60 * 1000).unref();

// ─── Text helpers ─────────────────────────────────────────────────────────────
function wrapText(text, maxChars = TITLE_MAX_CHARS) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
        if ((cur + ' ' + w).trim().length <= maxChars) cur = (cur + ' ' + w).trim();
        else {
            if (cur) lines.push(cur);
            cur = w;
        }
    }
    if (cur) lines.push(cur);
    return lines;
}

function escapeDrawtext(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, '\u2019')
        .replace(/"/g, '')
        .replace(/&/g, 'and')
        .replace(/</g, '')
        .replace(/>/g, '')
        .replace(/:/g, '\\:')
        .replace(/,/g, '\\,')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/[\u201C\u201D]/g, '')
        .replace(/[\u2018]/g, '\u2019')
        .trim();
}

// ─── Media helpers ────────────────────────────────────────────────────────────
async function getMediaDuration(filePath) {
    const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout.trim());
}

async function downloadImage(url, dest, retries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 20000,
                family: 4,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
            });
            fs.writeFileSync(dest, res.data);
            return dest;
        } catch (err) {
            lastError = err;
            console.warn(`[downloadImage] Attempt ${attempt}/${retries} failed: ${err.message}`);
            if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
    }
    throw new Error(`Download failed after ${retries} attempts (${url}): ${lastError.message}`);
}

async function generateAudioWithRetry(content, audioPath, sessionId, maxRetries = 5, language = 'en') {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[${sessionId}] 🎤 TTS attempt ${attempt}/${maxRetries}...`);
            const result = await generateAudioFromText(content, audioPath, sessionId, { language });
            if (!fs.existsSync(audioPath)) throw new Error('Audio file not created after TTS');
            return result;
        } catch (err) {
            lastError = err;
            console.warn(`[${sessionId}] ⚠️ TTS attempt ${attempt} failed: ${err.message}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, Math.min(2000 * attempt, 10000)));
                if (fs.existsSync(audioPath)) {
                    try { fs.unlinkSync(audioPath); } catch { }
                }
            }
        }
    }
    throw new Error(`TTS failed after ${maxRetries} attempts: ${lastError.message}`);
}

// ─── execFFmpeg wrapper ───────────────────────────────────────────────────────
async function execFFmpeg(cmd, sessionId, label = '') {
    console.log(`[${sessionId}] 🎞️ FFmpeg [${label}] start...`);
    try {
        return await execAsync(cmd, { maxBuffer: 600 * 1024 * 1024 });
    } catch (err) {
        const lines = (err.stderr || '').split('\n');
        console.error(`[${sessionId}] ❌ FFmpeg [${label}] FAILED\n${lines.slice(-40).join('\n')}`);
        throw new Error(`FFmpeg [${label}] failed: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS A: Title clip — nền đen, centered
// Output: title.mp4 (720x200)
// ═══════════════════════════════════════════════════════════════════════════════
async function renderTitleClip(title, duration, outPath, sessionId) {
    const titleUpper = title.toUpperCase();
    const lines = wrapText(titleUpper, TITLE_MAX_CHARS).slice(0, 3);

    const totalTextH = lines.length * TITLE_LINE_H;
    const startY = Math.max(TITLE_MARGIN_T, Math.floor((TITLE_H - totalTextH) / 2));

    const drawtextFilters = lines.map((line, i) => {
        const safe = escapeDrawtext(line);
        const y = startY + i * TITLE_LINE_H;
        return [
            `drawtext=fontfile='${FONT_PATH}'`,
            `text='${safe}'`,
            `fontcolor=white`,
            `fontsize=${TITLE_FONT_SIZE}`,
            `x=(w-text_w)/2`,
            `y=${y}`,
            `bordercolor=black@0.9`,
            `borderw=3`,
            `shadowcolor=black@0.6`,
            `shadowx=2`,
            `shadowy=2`,
        ].join(':');
    }).join(',');

    console.log(`[${sessionId}] 🏷️ Title (centered): ${lines.length} line(s) → "${lines.join(' / ')}"`);

    const cmd = [
        `ffmpeg -f lavfi -i "color=black:size=${W}x${TITLE_H}:rate=30"`,
        `-vf "${drawtextFilters}"`,
        `-t ${duration.toFixed(2)}`,
        `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -r 30`,
        `-an -y "${outPath}"`,
    ].join(' ');

    await execFFmpeg(cmd, sessionId, 'title-clip');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS B: Image Slideshow — blur-bg + fit overlay
// Output: image_slide.mp4 (720x575)
// ═══════════════════════════════════════════════════════════════════════════════
async function renderSlideshowClip(imgPaths, duration, outPath, sessionId) {
    const fps = 30;
    const tempBase = path.dirname(outPath);

    function buildBlurFitFilter(W, H) {
        return [
            `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
            `crop=${W}:${H},gblur=sigma=30,format=yuv420p,` +
            `colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg]`,
            `[1:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,format=yuv420p[fg]`,
            `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto[out]`,
        ].join(';');
    }

    if (imgPaths.length === 1) {
        const filter = buildBlurFitFilter(W, IMAGE_H);
        const cmd = [
            `ffmpeg -loop 1 -i "${imgPaths[0]}" -loop 1 -i "${imgPaths[0]}"`,
            `-filter_complex "${filter}"`,
            `-map "[out]"`,
            `-t ${duration.toFixed(2)}`,
            `-c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -r ${fps}`,
            `-an -y "${outPath}"`,
        ].join(' ');
        await execFFmpeg(cmd, sessionId, 'slide-single-blurbg');
        return;
    }

    const totalSlides = Math.ceil(duration / SEC_PER_SLIDE) + 1;
    const slideList = Array.from({ length: totalSlides }, (_, i) => imgPaths[i % imgPaths.length]);

    console.log(`[${sessionId}] 🖼️ Slideshow blur-bg: ${imgPaths.length} imgs → ${totalSlides} slides × ${SEC_PER_SLIDE}s`);

    const segPaths = [];
    for (let i = 0; i < slideList.length; i++) {
        const segPath = path.join(tempBase, `slide_seg_${i}.mp4`);
        const imgFile = slideList[i];
        const filter = buildBlurFitFilter(W, IMAGE_H);

        const cmd = [
            `ffmpeg -loop 1 -i "${imgFile}" -loop 1 -i "${imgFile}"`,
            `-filter_complex "${filter}"`,
            `-map "[out]"`,
            `-t ${SEC_PER_SLIDE.toFixed(3)}`,
            `-c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -r ${fps}`,
            `-an -y "${segPath}"`,
        ].join(' ');

        await execFFmpeg(cmd, sessionId, `slide-seg-${i}`);
        segPaths.push(segPath);
    }

    if (segPaths.length === 1) {
        fs.copyFileSync(segPaths[0], outPath);
        return;
    }

    const inputArgs = segPaths.map(p => `-i "${p}"`).join(' ');
    const filterParts = [];
    let prev = '[0:v]';

    for (let i = 1; i < segPaths.length; i++) {
        const offset = (SEC_PER_SLIDE * i - TRANSITION * i).toFixed(3);
        const isLast = i === segPaths.length - 1;
        const label = isLast ? '[xout]' : `[xf${i}]`;
        filterParts.push(`${prev}[${i}:v]xfade=transition=fade:duration=${TRANSITION}:offset=${offset}${label}`);
        prev = `[xf${i}]`;
    }

    const cmd = [
        `ffmpeg ${inputArgs}`,
        `-filter_complex "${filterParts.join(';')}"`,
        `-map "[xout]"`,
        `-c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -r ${fps}`,
        `-t ${duration.toFixed(2)} -an -y "${outPath}"`,
    ].join(' ');

    await execFFmpeg(cmd, sessionId, 'slide-xfade');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS C: Subtitle band — nền đen riêng 720x100
// Output: subtitle_band.mp4 (720x100)
// ═══════════════════════════════════════════════════════════════════════════════
async function renderSubtitleBand(duration, srtPath, outPath, sessionId) {
    const srtEscaped = srtPath
        .replace(/\\/g, '/')
        .replace(/^([A-Z]):/, (_, d) => `${d}\\:`)
        .replace(/'/g, "\\'");

    const forceStyle = [
        'FontName=BebasNeue-Regular',
        `FontSize=${SUBTITLE_FONT_SIZE}`,
        'Bold=0',
        'PrimaryColour=&H0000D7FF',
        'OutlineColour=&H00000000',
        'Outline=3',
        'Shadow=1',
        'Alignment=2',
        `MarginV=${SUBTITLE_MARGIN_V}`,
        `MarginL=${SUBTITLE_MARGIN_H}`,
        `MarginR=${SUBTITLE_MARGIN_H}`,
        'MaxLineCount=2',
        `PlayResX=${W}`,
        `PlayResY=${SUB_BAND_H}`,
        'BorderStyle=1'
    ].join(',');

    const subtitleVf = `subtitles='${srtEscaped}':fontsdir='${FONTS_DIR}':force_style='${forceStyle}'`;

    console.log(`[${sessionId}] 💬 Subtitle band on black bg (${W}x${SUB_BAND_H})`);

    const cmd = [
        `ffmpeg -f lavfi -i "color=black:size=${W}x${SUB_BAND_H}:rate=30"`,
        `-vf "${subtitleVf}"`,
        `-t ${duration.toFixed(2)}`,
        `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -r 30`,
        `-an -y "${outPath}"`,
    ].join(' ');

    await execFFmpeg(cmd, sessionId, 'subtitle-band');
}

async function renderEmptySubtitleBand(duration, outPath, sessionId) {
    const cmd = [
        `ffmpeg -f lavfi -i "color=black:size=${W}x${SUB_BAND_H}:rate=30"`,
        `-t ${duration.toFixed(2)}`,
        `-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -r 30`,
        `-an -y "${outPath}"`,
    ].join(' ');

    await execFFmpeg(cmd, sessionId, 'subtitle-band-empty');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS D: BG Video loop — 720x405
// Output: bg_raw.mp4 (720x405)
// ═══════════════════════════════════════════════════════════════════════════════
async function renderBgVideoLoop(duration, outPath, sessionId) {
    if (!fs.existsSync(BG_VIDEO_PATH)) {
        throw new Error(`background_video.mp4 not found: ${BG_VIDEO_PATH}`);
    }

    const bgDuration = await getMediaDuration(BG_VIDEO_PATH);
    const loopCount = Math.ceil(duration / bgDuration) + 1;

    console.log(`[${sessionId}] 🎥 BG 16:9: ${bgDuration.toFixed(2)}s × ${loopCount} loops → ${W}x${BG_H}`);

    const cmd = [
        `ffmpeg -stream_loop ${loopCount} -i "${BG_VIDEO_PATH}"`,
        `-vf "scale=${W}:${BG_H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${BG_H}:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p"`,
        `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p`,
        `-t ${duration.toFixed(2)} -an -y "${outPath}"`,
    ].join(' ');

    await execFFmpeg(cmd, sessionId, 'bg-loop-16:9');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS E: Stack 4 layer dọc
// [title][image][subband][bg] -> 720x1280
// ═══════════════════════════════════════════════════════════════════════════════
async function stackFourLayers(titlePath, imagePath, subBandPath, bgPath, duration, outPath, sessionId) {
    const filterComplex = [
        `[0:v]fps=30,format=yuv420p[title]`,
        `[1:v]fps=30,format=yuv420p[img]`,
        `[2:v]fps=30,format=yuv420p[sub]`,
        `[3:v]fps=30,format=yuv420p[bg]`,
        `[title][img][sub][bg]vstack=inputs=4[out]`,
    ].join(';');

    const cmd = [
        `ffmpeg -i "${titlePath}" -i "${imagePath}" -i "${subBandPath}" -i "${bgPath}"`,
        `-filter_complex "${filterComplex}"`,
        `-map "[out]"`,
        `-c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -r 30`,
        `-t ${duration.toFixed(2)} -y "${outPath}"`,
    ].join(' ');

    await execFFmpeg(cmd, sessionId, 'vstack-4layers');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS F: Merge audio
// ═══════════════════════════════════════════════════════════════════════════════
async function mergeAudio(videoPath, audioPath, outPath, sessionId) {
    const cmd = [
        `ffmpeg -i "${videoPath}" -i "${audioPath}"`,
        `-c:v copy -c:a aac -b:a 128k`,
        `-map 0:v -map 1:a -shortest -y "${outPath}"`,
    ].join(' ');

    await execFFmpeg(cmd, sessionId, 'merge-audio');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE processVideo
// ═══════════════════════════════════════════════════════════════════════════════
async function processVideo(content, title, imageUrls, jobId, language = 'en', onProgress = () => { }) {
    const tempDir = path.join(TEMP_DIR, jobId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    try {
        onProgress({ progress: 8, step: 'tts', message: 'Đang tạo giọng đọc TTS...' });
        const audioPath = path.join(tempDir, 'audio.mp3');
        const srtPath = path.join(tempDir, 'subtitle.srt');

        const ttsResult = await generateAudioWithRetry(content, audioPath, jobId, 5, language);
        const audioDuration = await getMediaDuration(audioPath);
        console.log(`[${jobId}] 🎵 Duration: ${audioDuration.toFixed(2)}s`);

        let hasSrt = false;
        if (ttsResult?.srtUrl) {
            try {
                const srtRes = await axios.get(ttsResult.srtUrl, {
                    timeout: 10000,
                    responseType: 'arraybuffer'
                });
                fs.writeFileSync(srtPath, srtRes.data);
                hasSrt = true;
                console.log(`[${jobId}] 📝 SRT downloaded`);

                const srtContent = fs.readFileSync(srtPath, 'utf8');
                const srtUpper = srtContent.replace(
                    /^(?!\d+\s*$)(?![\d:,\s]+-->)(.+)$/gm,
                    (line) => line.toUpperCase()
                );
                fs.writeFileSync(srtPath, srtUpper, 'utf8');
                console.log(`[${jobId}] 🔤 SRT uppercased`);
            } catch (e) {
                console.warn(`[${jobId}] ⚠️ SRT download failed: ${e.message}`);
            }
        }

        onProgress({ progress: 15, step: 'images', message: `Đang tải ${imageUrls.length} ảnh...` });
        const localImgPaths = await Promise.all(
            imageUrls.map((url, i) => downloadImage(url, path.join(tempDir, `img_${i}.jpg`)))
        );
        console.log(`[${jobId}] 🖼️ Downloaded ${localImgPaths.length} image(s)`);

        onProgress({ progress: 28, step: 'render', message: 'Đang render title, slideshow, subtitle band, bg...' });

        const titlePath = path.join(tempDir, 'title.mp4');
        const imagePath = path.join(tempDir, 'image_slide.mp4');
        const subBandPath = path.join(tempDir, 'subtitle_band.mp4');
        const bgRawPath = path.join(tempDir, 'bg_raw.mp4');

        await Promise.all([
            renderTitleClip(title, audioDuration, titlePath, jobId),
            renderSlideshowClip(localImgPaths, audioDuration, imagePath, jobId),
            hasSrt && fs.existsSync(srtPath)
                ? renderSubtitleBand(audioDuration, srtPath, subBandPath, jobId)
                : renderEmptySubtitleBand(audioDuration, subBandPath, jobId),
            renderBgVideoLoop(audioDuration, bgRawPath, jobId),
        ]);
        console.log(`[${jobId}] ✅ All 4 layers rendered`);

        onProgress({ progress: 72, step: 'stack', message: 'Đang ghép 4 layer...' });
        const stackedPath = path.join(tempDir, 'stacked.mp4');
        await stackFourLayers(titlePath, imagePath, subBandPath, bgRawPath, audioDuration, stackedPath, jobId);

        onProgress({ progress: 82, step: 'merge', message: 'Đang ghép audio...' });
        const finalPath = path.join(tempDir, 'final_output.mp4');
        await mergeAudio(stackedPath, audioPath, finalPath, jobId);

        onProgress({ progress: 91, step: 'upload', message: 'Đang upload video...' });
        const uploadResult = await uploadVideo(finalPath, `hookv7_${jobId}.mp4`);
        if (!uploadResult.success) {
            throw new Error('Upload failed: ' + (uploadResult.error || 'unknown'));
        }

        onProgress({ progress: 98, step: 'cleanup', message: 'Dọn file tạm...' });
        cleanupTempDir(tempDir);
        onProgress({ progress: 100, step: 'done', message: 'Hoàn thành!' });

        return {
            success: true,
            videoUrl: uploadResult.url,
            uploadService: uploadResult.service,
            permanent: uploadResult.permanent || false,
            metadata: {
                imageCount: imageUrls.length,
                ttsDuration: audioDuration.toFixed(2),
                hasSrt,
                layout: [
                    `Title ${W}x${TITLE_H} (BebasNeue centered, black bg)`,
                    `Image ${W}x${IMAGE_H} (blur-bg + fit overlay)`,
                    `Subtitle Band ${W}x${SUB_BAND_H} (black bg, yellow BebasNeue)`,
                    `BG Video ${W}x${BG_H} 16:9`,
                ].join(' | '),
                resolution: `${W}x${TOTAL_H}`,
                mode: localImgPaths.length === 1
                    ? 'single-blurbg-subband'
                    : `slideshow-blurbg-subband-${localImgPaths.length}imgs`,
            },
        };
    } catch (error) {
        cleanupTempDir(tempDir);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Background job runner
// ═══════════════════════════════════════════════════════════════════════════════
async function runJob(jobId) {
    const job = getJob(jobId);
    if (!job) return;

    const { content, title, images, language } = job.payload;

    try {
        setJob(jobId, {
            status: 'processing',
            progress: 3,
            step: 'starting',
            message: 'Bắt đầu xử lý video',
            startedAt: new Date().toISOString(),
            error: null,
        });

        const result = await processVideo(
            content,
            title,
            images,
            jobId,
            language,
            ({ progress, step, message }) => setJob(jobId, { status: 'processing', progress, step, message })
        );

        setJob(jobId, {
            status: 'done',
            progress: 100,
            step: 'done',
            message: 'Xử lý thành công',
            result,
            finishedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error(`❌ Job ${jobId} failed:`, error.message);
        setJob(jobId, {
            status: 'failed',
            step: 'failed',
            message: 'Xử lý thất bại',
            error: sanitizeError(error),
            finishedAt: new Date().toISOString(),
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST / ───────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { content, title, images, language } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length < 10) {
        return res.status(400).json({ success: false, error: 'content (string, min 10 chars) required' });
    }

    if (!title || typeof title !== 'string' || title.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'title (string) required' });
    }

    let imageUrls = [];
    if (typeof images === 'string') imageUrls = [images];
    else if (Array.isArray(images)) imageUrls = images.filter(u => typeof u === 'string' && u.startsWith('http'));

    if (imageUrls.length === 0) {
        return res.status(400).json({ success: false, error: 'images (string or array of URLs) required' });
    }

    if (imageUrls.length > 20) {
        return res.status(400).json({ success: false, error: 'Max 20 images per request' });
    }

    const SUPPORTED_LANGUAGES = ['en', 'pt', 'de', 'jp'];
    const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'en';
    const job = createJob({ content, title, images: imageUrls, language: lang });

    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║ 🎬 HOOK V7 [Title+Image575+SubBand100+BG405] Job: ${job.id}`);
    console.log(`║ 📰 Title: "${title.substring(0, 50)}"`);
    console.log(`║ 🖼️ Images: ${imageUrls.length} | Layout: ${W}x${TITLE_H}+${IMAGE_H}+${SUB_BAND_H}+${BG_H}`);
    console.log(`╚══════════════════════════════════════════════════════╝`);

    res.status(202).json({
        success: true,
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        step: job.step,
        message: job.message,
        pollUrl: `/api/cover-v7/${job.id}`,
        eventsUrl: `/api/cover-v7/${job.id}/events`,
    });

    setImmediate(() => runJob(job.id).catch(err => {
        console.error(`❌ Background runJob error (${job.id}):`, err.message);
        setJob(job.id, {
            status: 'failed',
            step: 'failed',
            message: 'Background job crashed',
            error: sanitizeError(err),
            finishedAt: new Date().toISOString(),
        });
    }));
});

// ─── GET /:jobId ──────────────────────────────────────────────────────────────
router.get('/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

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
        result: job.status === 'done' ? job.result : null,
    });
});

// ─── DELETE /:jobId ───────────────────────────────────────────────────────────
router.delete('/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    jobs.delete(req.params.jobId);
    return res.json({ success: true, message: 'Job deleted' });
});

// ─── GET /:jobId/events (SSE) ─────────────────────────────────────────────────
router.get('/:jobId/events', (req, res) => {
    const jobId = req.params.jobId;
    const job = getJob(jobId);
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    send({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        step: job.step,
        message: job.message,
        error: job.error,
        result: job.status === 'done' ? job.result : null,
    });

    const listener = (updated) => {
        send({
            jobId: updated.id,
            status: updated.status,
            progress: updated.progress,
            step: updated.step,
            message: updated.message,
            error: updated.error,
            result: updated.status === 'done' ? updated.result : null,
        });

        if (updated.status === 'done' || updated.status === 'failed') res.end();
    };

    jobEvents.on(`job:${jobId}`, listener);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
        clearInterval(heartbeat);
        jobEvents.off(`job:${jobId}`, listener);
    });
});

module.exports = router;
module.exports.jobs = jobs;