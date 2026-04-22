// routes/batchHookV4.js
// V4: Header subtitle (SRT scroll) + Image Slideshow/Single + Bottom Title
// Job-based: POST / → trả jobId, GET /:jobId → poll kết quả, GET /:jobId/events → SSE
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { promisify } = require('util');
const { exec } = require('child_process');
const { EventEmitter } = require('events');
const { generateAudioFromText } = require('../utils/audioGenerator');
const { uploadVideo } = require('../utils/uploadService');

const execAsync = promisify(exec);
const router = express.Router();

// ─── Job store ────────────────────────────────────────────────────────────────
const jobs = new Map();
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(1000);

const JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// ─── Constants ────────────────────────────────────────────────────────────────
const W = 720;
const HEADER_H = 160;
const IMAGE_H = 720;
const BOTTOM_H = 400;
const TOTAL_H = 1280;

// ─── Temp dir ─────────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(__dirname, '..', 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Font path ────────────────────────────────────────────────────────────────
const FONT_PATH = path.join(__dirname, '..', 'fonts', 'BebasNeue-Regular.ttf')
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_, d) => `${d}\\:`);

// ─── Job helpers ──────────────────────────────────────────────────────────────
function generateJobId() {
    return `hv4_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function getJob(jobId) {
    return jobs.get(jobId) || null;
}

function setJob(jobId, patch) {
    const current = jobs.get(jobId) || {};
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
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

function sanitizeError(error) {
    return error?.message || 'Unknown error';
}

function cleanupTempDir(tempDir) {
    try {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            console.log(`🗑️ Cleaned: ${tempDir}`);
        }
    } catch (err) {
        console.warn(`⚠️ Cleanup failed: ${err.message}`);
    }
}

// ─── Auto cleanup expired jobs ────────────────────────────────────────────────
function cleanupExpiredJobs() {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
        const ts = new Date(job.updatedAt || job.createdAt).getTime();
        if (now - ts > JOB_TTL_MS) {
            jobs.delete(jobId);
        }
    }
}
setInterval(cleanupExpiredJobs, 60 * 60 * 1000).unref();

// ─── Word wrap helper ─────────────────────────────────────────────────────────
function wrapText(text, maxChars = 30) {
    const words = text.split(' ');
    const lines = [];
    let current = '';
    for (const word of words) {
        if ((current + ' ' + word).trim().length <= maxChars) {
            current = (current + ' ' + word).trim();
        } else {
            if (current) lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines;
}

// ─── Helper: get duration ─────────────────────────────────────────────────────
async function getMediaDuration(filePath) {
    const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    return parseFloat(stdout.trim());
}

// ─── Download ảnh từ URL ──────────────────────────────────────────────────────
async function downloadImage(url, destPath) {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    fs.writeFileSync(destPath, res.data);
    return destPath;
}

// ─── Check + Download nhiều ảnh, bỏ qua ảnh lỗi ─────────────────────────────
async function downloadImages(imageUrls, tempDir, sessionId) {
    const results = await Promise.allSettled(
        imageUrls.map((url, i) =>
            downloadImage(url, path.join(tempDir, `img_${i}.jpg`))
        )
    );

    const successPaths = [];
    const failedUrls = [];

    results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            successPaths.push(result.value);
        } else {
            failedUrls.push({ index: i, url: imageUrls[i], reason: result.reason?.message });
            console.warn(`[${sessionId}] ⚠️ Image ${i} failed (${imageUrls[i]}): ${result.reason?.message}`);
        }
    });

    console.log(`[${sessionId}] 🖼️ ${successPaths.length}/${imageUrls.length} images OK`);

    if (successPaths.length === 0) {
        throw new Error(`All ${imageUrls.length} images failed to download`);
    }

    return { successPaths, failedUrls };
}

// ─── TTS với retry tối đa 5 lần ──────────────────────────────────────────────
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
                const delay = Math.min(2000 * attempt, 10000);
                console.log(`[${sessionId}] ⏳ Retrying in ${delay / 1000}s...`);
                await new Promise(r => setTimeout(r, delay));
                if (fs.existsSync(audioPath)) {
                    try { fs.unlinkSync(audioPath); } catch { }
                }
            }
        }
    }
    throw new Error(`TTS failed after ${maxRetries} attempts: ${lastError.message}`);
}

// ─── A: Header clip ───────────────────────────────────────────────────────────
async function createHeaderClip(audioDuration, tempDir, srtPath = null) {
    const headerPath = path.join(tempDir, 'header.mp4');

    if (srtPath && fs.existsSync(srtPath)) {
        const srtEscaped = srtPath
            .replace(/\\/g, '/')
            .replace(/'/g, "\\'")
            .replace(/:/g, '\\:');

        const fontsDir = path.join(__dirname, '..', 'fonts')
            .replace(/\\/g, '/')
            .replace(/:/g, '\\:');

        const cmd = `ffmpeg -f lavfi -i "color=black:size=${W}x${HEADER_H}:rate=30" \
-vf "subtitles='${srtEscaped}':fontsdir='${fontsDir}':force_style='FontName=BebasNeue-Regular,FontSize=64,Bold=0,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,Alignment=2,MarginV=45,MarginL=30,MarginR=30,MaxLineCount=1,PlayResX=720'" \
-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \
-t ${audioDuration.toFixed(2)} -an -y "${headerPath}"`;

        await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
    } else {
        const cmd = `ffmpeg -f lavfi -i "color=black:size=${W}x${HEADER_H}:rate=30" \
-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \
-t ${audioDuration.toFixed(2)} -an -y "${headerPath}"`;
        await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
    }

    if (!fs.existsSync(headerPath)) throw new Error('Header clip failed');
    return headerPath;
}

// ─── B: Bottom clip ───────────────────────────────────────────────────────────
async function createBottomClip(title, audioDuration, tempDir) {
    const bottomPath = path.join(tempDir, 'bottom.mp4');

    const lines = wrapText(title, 30);
    const lineHeight = 65;
    const totalTextH = lines.length * lineHeight;
    const startY = Math.max(20, Math.floor((BOTTOM_H - totalTextH) / 2));

    const drawtextFilters = lines.map((line, i) => {
        const safeLine = line
            .replace(/\\/g, '\\\\')
            .replace(/'/g, '\u2019')
            .replace(/:/g, '\\:')
            .replace(/,/g, '\\,')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]');
        const y = startY + i * lineHeight;
        return `drawtext=fontfile='${FONT_PATH}':text='${safeLine}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=${y}:bordercolor=black:borderw=3`;
    }).join(',');

    const cmd = `ffmpeg -f lavfi -i "color=black:size=${W}x${BOTTOM_H}:rate=30" \
-vf "${drawtextFilters}" \
-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p \
-t ${audioDuration.toFixed(2)} -an -y "${bottomPath}"`;

    await execAsync(cmd, { maxBuffer: 100 * 1024 * 1024 });
    if (!fs.existsSync(bottomPath)) throw new Error('Bottom clip failed');
    return bottomPath;
}

// ─── C1: Single image clip ────────────────────────────────────────────────────
async function createSingleImageClip(imgPath, audioDuration, tempDir) {
    const clipPath = path.join(tempDir, 'image_clip.mp4');
    const fps = 30;

    const cmd = `ffmpeg -loop 1 -i "${imgPath}" -loop 1 -i "${imgPath}" \
-filter_complex "\
[0:v]scale=${W}:${IMAGE_H}:force_original_aspect_ratio=increase,crop=${W}:${IMAGE_H},gblur=sigma=30,format=yuv420p,colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];\
[1:v]scale=${W}:${IMAGE_H}:force_original_aspect_ratio=decrease,format=yuv420p[fg];\
[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto[out]" \
-map "[out]" \
-t ${audioDuration.toFixed(2)} \
-c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -r ${fps} \
-an -y "${clipPath}"`;

    await execAsync(cmd, { maxBuffer: 300 * 1024 * 1024 });
    if (!fs.existsSync(clipPath)) throw new Error('Single image clip failed');
    return clipPath;
}

// ─── C2: Slideshow clip ───────────────────────────────────────────────────────
async function createSlideshowClip(imgPaths, audioDuration, tempDir) {
    const clipPath = path.join(tempDir, 'image_clip.mp4');
    const fps = 30;
    const SEC_PER_SLIDE = 5;
    const transitionSec = 0.5;

    const totalSlides = Math.ceil(audioDuration / SEC_PER_SLIDE) + 1;
    const slideList = Array.from({ length: totalSlides }, (_, i) => imgPaths[i % imgPaths.length]);

    console.log(`[slideshow] ${imgPaths.length} images → ${totalSlides} slides × ${SEC_PER_SLIDE}s = ~${(totalSlides * SEC_PER_SLIDE).toFixed(0)}s (audio: ${audioDuration.toFixed(2)}s)`);

    const segmentPaths = [];
    for (let i = 0; i < slideList.length; i++) {
        const segPath = path.join(tempDir, `seg_${i}.mp4`);

        const cmd = `ffmpeg -loop 1 -i "${slideList[i]}" -loop 1 -i "${slideList[i]}" \
-filter_complex "\
[0:v]scale=${W}:${IMAGE_H}:force_original_aspect_ratio=increase,crop=${W}:${IMAGE_H},gblur=sigma=30,format=yuv420p,colorchannelmixer=rr=0.6:gg=0.6:bb=0.6[bg];\
[1:v]scale=${W}:${IMAGE_H}:force_original_aspect_ratio=decrease,format=yuv420p[fg];\
[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto[out]" \
-map "[out]" \
-t ${SEC_PER_SLIDE.toFixed(3)} \
-c:v libx264 -preset fast -crf 22 -pix_fmt yuv420p -r ${fps} \
-an -y "${segPath}"`;

        await execAsync(cmd, { maxBuffer: 200 * 1024 * 1024 });
        segmentPaths.push(segPath);
    }

    if (segmentPaths.length === 1) {
        fs.copyFileSync(segmentPaths[0], clipPath);
        return clipPath;
    }

    const inputArgs = segmentPaths.map(p => `-i "${p}"`).join(' ');
    const filterParts = [];
    let prev = `[0:v]`;

    for (let i = 1; i < segmentPaths.length; i++) {
        const offset = (SEC_PER_SLIDE * i - transitionSec * i).toFixed(3);
        const isLast = (i === segmentPaths.length - 1);
        const label = isLast ? `[out]` : `[xf${i}]`;
        filterParts.push(`${prev}[${i}:v]xfade=transition=fade:duration=${transitionSec}:offset=${offset}${label}`);
        prev = `[xf${i}]`;
    }

    const cmd = `ffmpeg ${inputArgs} \
-filter_complex "${filterParts.join(';')}" \
-map "[out]" \
-c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -r ${fps} \
-t ${audioDuration.toFixed(2)} -an -y "${clipPath}"`;

    await execAsync(cmd, { maxBuffer: 400 * 1024 * 1024 });
    if (!fs.existsSync(clipPath)) throw new Error('Slideshow clip failed');
    return clipPath;
}

// ─── D: Stack layers ──────────────────────────────────────────────────────────
async function stackLayers(headerPath, imageClipPath, bottomPath, audioDuration, tempDir) {
    const stackedPath = path.join(tempDir, 'slideshow.mp4');

    const filterComplex = [
        `[0:v]fps=30,format=yuv420p[header]`,
        `[1:v]fps=30,format=yuv420p[mid]`,
        `[2:v]fps=30,format=yuv420p[bot]`,
        `[header][mid][bot]vstack=inputs=3[out]`
    ].join(';');

    const cmd = `ffmpeg \
-i "${headerPath}" \
-i "${imageClipPath}" \
-i "${bottomPath}" \
-filter_complex "${filterComplex}" \
-map "[out]" \
-c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p \
-r 30 -t ${audioDuration.toFixed(2)} -y "${stackedPath}"`;

    await execAsync(cmd, { maxBuffer: 400 * 1024 * 1024 });
    if (!fs.existsSync(stackedPath)) throw new Error('Stack layers failed');
    return stackedPath;
}

// ─── E: Merge audio ───────────────────────────────────────────────────────────
async function mergeAudio(videoPath, audioPath, tempDir) {
    const finalPath = path.join(tempDir, 'final_output.mp4');
    const cmd = `ffmpeg -i "${videoPath}" -i "${audioPath}" \
-c:v copy -c:a aac -b:a 128k \
-map 0:v -map 1:a -shortest -y "${finalPath}"`;
    await execAsync(cmd, { maxBuffer: 150 * 1024 * 1024 });
    if (!fs.existsSync(finalPath)) throw new Error('Audio merge failed');
    return finalPath;
}

// ─── CORE processVideo ────────────────────────────────────────────────────────
async function processVideo(content, title, imageUrls, jobId, language = 'en', onProgress = () => { }) {
    const tempDir = path.join(TEMP_DIR, jobId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    try {
        // STEP 1: Check + Download ảnh TRƯỚC (tránh lãng phí TTS credits)
        onProgress({ progress: 5, step: 'images', message: `Đang kiểm tra ${imageUrls.length} ảnh...` });
        const { successPaths: localImgPaths, failedUrls } = await downloadImages(imageUrls, tempDir, jobId);
        if (failedUrls.length > 0) {
            console.warn(`[${jobId}] ⚠️ ${failedUrls.length} ảnh bị skip, tiếp tục với ${localImgPaths.length} ảnh`);
        }

        // STEP 2: TTS (chỉ chạy khi đã có ít nhất 1 ảnh hợp lệ)
        onProgress({ progress: 15, step: 'tts', message: 'Đang tạo giọng đọc TTS...' });
        const audioPath = path.join(tempDir, 'audio.mp3');
        const srtPath = path.join(tempDir, 'subtitle.srt');

        const ttsResult = await generateAudioWithRetry(content, audioPath, jobId, 5, language);

        const audioDuration = await getMediaDuration(audioPath);
        console.log(`[${jobId}] 🎵 Duration: ${audioDuration.toFixed(2)}s`);

        // Download SRT
        let hasSrt = false;
        if (ttsResult?.srtUrl) {
            try {
                const srtRes = await axios.get(ttsResult.srtUrl, { timeout: 10000, responseType: 'arraybuffer' });
                fs.writeFileSync(srtPath, srtRes.data);
                hasSrt = true;
                console.log(`[${jobId}] 📝 SRT downloaded`);
            } catch (e) {
                console.warn(`[${jobId}] ⚠️ SRT failed: ${e.message}`);
            }
        }

        // STEP 3: Build 3 layers song song
        onProgress({ progress: 50, step: 'render', message: 'Đang render các layer...' });
        const [headerPath, imageClipPath, bottomPath] = await Promise.all([
            createHeaderClip(audioDuration, tempDir, hasSrt ? srtPath : null),
            localImgPaths.length === 1
                ? createSingleImageClip(localImgPaths[0], audioDuration, tempDir)
                : createSlideshowClip(localImgPaths, audioDuration, tempDir),
            createBottomClip(title, audioDuration, tempDir),
        ]);

        // STEP 4: Stack
        onProgress({ progress: 75, step: 'stack', message: 'Đang ghép các layer...' });
        const stackedPath = await stackLayers(headerPath, imageClipPath, bottomPath, audioDuration, tempDir);

        // STEP 5: Merge audio
        onProgress({ progress: 85, step: 'merge', message: 'Đang ghép audio...' });
        const finalPath = await mergeAudio(stackedPath, audioPath, tempDir);

        // STEP 6: Upload
        onProgress({ progress: 92, step: 'upload', message: 'Đang upload video...' });
        const uploadResult = await uploadVideo(finalPath, `hookv4_${jobId}.mp4`);
        if (!uploadResult.success) throw new Error('Upload failed');

        // Cleanup
        onProgress({ progress: 98, step: 'cleanup', message: 'Đang dọn file tạm...' });
        cleanupTempDir(tempDir);

        onProgress({ progress: 100, step: 'done', message: 'Hoàn thành!' });

        return {
            success: true,
            videoUrl: uploadResult.url,
            uploadService: uploadResult.service,
            permanent: uploadResult.permanent || false,
            metadata: {
                imageCount: imageUrls.length,
                imagesDownloaded: localImgPaths.length,
                imagesFailed: failedUrls.length,
                ttsDuration: audioDuration.toFixed(2),
                hasSrt,
                language,
                layout: `Header ${W}x${HEADER_H} (subtitle) | Image ${W}x${IMAGE_H} | Bottom ${W}x${BOTTOM_H} (title)`,
                resolution: `${W}x${TOTAL_H}`,
                mode: localImgPaths.length === 1 ? 'single-ken-burns' : `slideshow-${localImgPaths.length}imgs`
            }
        };

    } catch (error) {
        cleanupTempDir(tempDir);
        throw error;
    }
}

// ─── Background job runner ────────────────────────────────────────────────────
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
            ({ progress, step, message }) => {
                setJob(jobId, { status: 'processing', progress, step, message });
            }
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

// ─── POST / — tạo job mới ─────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { content, title, images, language } = req.body;

    if (!content || typeof content !== 'string' || content.trim().length < 10) {
        return res.status(400).json({ success: false, error: 'content (string, min 10 chars) required' });
    }
    if (!title || typeof title !== 'string' || title.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'title (string) required' });
    }

    let imageUrls = [];
    if (typeof images === 'string') {
        imageUrls = [images];
    } else if (Array.isArray(images)) {
        imageUrls = images.filter(u => typeof u === 'string' && u.startsWith('http'));
    }

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
    console.log(`║ 🎬 HOOK V4 Job: ${job.id}`);
    console.log(`║ 📰 Title: "${title.substring(0, 50)}"`);
    console.log(`║ 🌐 Language: ${lang}`);
    console.log(`║ 🖼️  Images: ${imageUrls.length} | Mode: ${imageUrls.length === 1 ? 'Ken Burns' : 'Slideshow'}`);
    console.log(`╚══════════════════════════════════════════════════════╝`);

    res.status(202).json({
        success: true,
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        step: job.step,
        message: job.message,
        pollUrl: `/api/cover/${job.id}`,
        eventsUrl: `/api/cover/${job.id}/events`,
    });

    setImmediate(() => {
        runJob(job.id).catch((err) => {
            console.error(`❌ Background runJob error (${job.id}):`, err.message);
            setJob(job.id, {
                status: 'failed',
                step: 'failed',
                message: 'Background job crashed',
                error: sanitizeError(err),
                finishedAt: new Date().toISOString(),
            });
        });
    });
});

// ─── GET /:jobId — poll trạng thái ───────────────────────────────────────────
router.get('/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);

    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
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
        result: job.status === 'done' ? job.result : null,
    });
});

// ─── DELETE /:jobId — xóa job ────────────────────────────────────────────────
router.delete('/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);

    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
    }

    jobs.delete(req.params.jobId);
    return res.json({ success: true, message: 'Job deleted' });
});

// ─── GET /:jobId/events — SSE realtime ───────────────────────────────────────
router.get('/:jobId/events', (req, res) => {
    const jobId = req.params.jobId;
    const job = getJob(jobId);

    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
    }

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

    const listener = (updatedJob) => {
        send({
            jobId: updatedJob.id,
            status: updatedJob.status,
            progress: updatedJob.progress,
            step: updatedJob.step,
            message: updatedJob.message,
            error: updatedJob.error,
            result: updatedJob.status === 'done' ? updatedJob.result : null,
        });

        if (updatedJob.status === 'done' || updatedJob.status === 'failed') {
            res.end();
        }
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