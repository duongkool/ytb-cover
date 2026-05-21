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

const W = 720;
const H = 1280;
const TEMP_DIR = path.join(__dirname, '..', 'temp');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateJobId() {
    return `podcast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
            id: payload?.id || '',
            content: payload?.content || '',
            title: payload?.title || '',
            images: payload?.images || [],
            language: payload?.language || 'pt',
            badgeTop: payload?.badgeTop || 'HISTÓRIAS REAIS',
            badgeBottom: payload?.badgeBottom || '',
            episode: payload?.episode || 'EP.1',
            footerBrand: payload?.footerBrand || 'DRAMACAST',
        },
        result: null,
        error: null,
    };

    jobs.set(jobId, job);
    return job;
}

function sanitizeError(error) {
    if (axios.isAxiosError(error)) {
        return error.response?.data?.error || error.message || 'Axios error';
    }
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

function logFileState(label, filePath) {
    try {
        const exists = fs.existsSync(filePath);
        if (!exists) {
            console.log(`[FILE] ${label}: not found -> ${filePath}`);
            return;
        }
        const stat = fs.statSync(filePath);
        console.log(`[FILE] ${label}: exists size=${stat.size} path=${filePath}`);
    } catch (err) {
        console.warn(`[FILE] ${label}: ${err.message}`);
    }
}

async function runCommand(cmd, label, opts = {}) {
    console.log(`\n================ ${label} ================`);
    console.log(cmd);
    console.log('==========================================\n');

    try {
        const { stdout, stderr } = await execAsync(cmd, {
            maxBuffer: 1024 * 1024 * 500,
            ...opts,
        });

        if (stdout?.trim()) console.log(`[${label}] stdout:\n${stdout}`);
        if (stderr?.trim()) console.log(`[${label}] stderr:\n${stderr}`);

        return { stdout, stderr };
    } catch (err) {
        console.error(`❌ [${label}] failed`);
        console.error(`[${label}] message:`, err.message);
        if (err.stdout) console.error(`[${label}] stdout:\n${err.stdout}`);
        if (err.stderr) console.error(`[${label}] stderr:\n${err.stderr}`);
        throw new Error(`[${label}] ${err.stderr || err.message}`);
    }
}

async function getMediaDuration(filePath) {
    const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
        { maxBuffer: 50 * 1024 * 1024 }
    );
    const duration = parseFloat(stdout.trim());
    if (!Number.isFinite(duration)) {
        throw new Error(`Cannot get media duration: ${filePath}`);
    }
    return duration;
}

// ─── Download ảnh ─────────────────────────────────────────────────────────────
async function downloadImage(url, destPath) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 20000,
    });
    fs.writeFileSync(destPath, res.data);
    return destPath;
}

// ─── Save base64 ──────────────────────────────────────────────────────────────
function saveBase64Image(base64, outputPath) {
    const data = base64.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(outputPath, Buffer.from(data, 'base64'));
}

const RESULT_WEBHOOK_URL = 'https://n8n2.xopboo.com/webhook/result-video';

async function sendResultWebhook(id, videoUrl) {
    if (!id || !videoUrl) return null;

    try {
        const payload = { id, videoUrl };
        const res = await axios.post(RESULT_WEBHOOK_URL, payload, {
            timeout: 30000,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        console.log(`[WEBHOOK] Sent result for id=${id} status=${res.status}`);
        return {
            ok: true,
            status: res.status,
            data: res.data || null,
        };
    } catch (err) {
        console.warn(`[WEBHOOK] Failed sending result for id=${id}: ${err.message}`);
        return {
            ok: false,
            error: err.message,
            status: err.response?.status || null,
            data: err.response?.data || null,
        };
    }
}

// ─── TTS retry ────────────────────────────────────────────────────────────────
async function generateAudioWithRetry(content, audioPath, sessionId, maxRetries = 5, language = 'pt') {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[${sessionId}] 🎤 TTS attempt ${attempt}/${maxRetries} | lang=${language}`);
            const result = await generateAudioFromText(content, audioPath, sessionId, { language });
            if (!fs.existsSync(audioPath)) throw new Error('Audio file not created after TTS');
            logFileState('audio-created', audioPath);
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

// ─── Poster generator API call ────────────────────────────────────────────────
async function generatePoster({
    image,
    title,
    badgeTop,
    badgeBottom,
    episode,
    footerBrand,
}) {
    const payload = {
        image,
        title,
        badgeTop,
        badgeBottom,
        episode,
        footerBrand,
    };

    const res = await axios.post(
        'http://localhost:3000/api/generatePodcastThumbnail',
        payload,
        { timeout: 60000 }
    );

    if (!res.data?.success || !res.data?.base64) {
        throw new Error(res.data?.error || 'Poster generation failed');
    }

    return res.data.base64;
}

// ─── SRT / ASS helpers ────────────────────────────────────────────────────────
function srtTimeToAss(srtTime) {
    const [hms, ms] = srtTime.split(',');
    const [h, m, s] = hms.split(':');
    const cs = Math.round(parseInt(ms, 10) / 10);
    return `${parseInt(h, 10)}:${m}:${s}.${String(cs).padStart(2, '0')}`;
}

function escapeAssText(text = '') {
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}')
        .replace(/\n/g, '\\N');
}

function parseSrtBlocks(srtContent = '') {
    const blocks = srtContent
        .replace(/\r/g, '')
        .trim()
        .split(/\n\s*\n/);

    const items = [];

    for (const block of blocks) {
        const lines = block.split('\n').filter(Boolean);
        if (lines.length < 2) continue;

        const timeLine = lines.find(line => line.includes('-->'));
        if (!timeLine) continue;

        const [start, end] = timeLine.split('-->').map(x => x.trim());
        const textLines = lines
            .filter(line => !/^\d+$/.test(line.trim()))
            .filter(line => !line.includes('-->'));

        const text = textLines.join(' ').replace(/\s+/g, ' ').trim();
        if (!text) continue;

        items.push({ start, end, text });
    }

    return items;
}

function styleWordsAlternating(text = '') {
    const WHITE = '{\\c&HFFFFFF&}';
    const YELLOW = '{\\c&H1FB3F3&}';
    const RESET = '{\\r}';

    const words = String(text).trim().split(/\s+/).filter(Boolean);

    return words.map((word, idx) => {
        const color = idx % 4 === 1 ? YELLOW : WHITE;
        return `${color}${escapeAssText(word)}${RESET}`;
    }).join(' ');
}

function wrapWords(words, maxCharsPerLine = 26, maxLines = 3) {
    const lines = [];
    let current = [];

    for (const word of words) {
        const candidate = [...current, word].join(' ');
        if (candidate.length <= maxCharsPerLine) {
            current.push(word);
        } else {
            if (current.length) lines.push(current);
            current = [word];
            if (lines.length >= maxLines - 1) break;
        }
    }

    if (current.length && lines.length < maxLines) {
        lines.push(current);
    }

    const used = lines.flat().length;
    if (used < words.length && lines.length) {
        let last = lines[lines.length - 1].join(' ');
        if (!last.endsWith('...')) {
            if ((last + '...').length <= maxCharsPerLine + 3) {
                lines[lines.length - 1] = [last + '...'];
            } else {
                const shortened = lines[lines.length - 1].slice(0, -1).join(' ');
                lines[lines.length - 1] = [shortened ? `${shortened}...` : '...'];
            }
        }
    }

    return lines.map(line => Array.isArray(line) ? line.join(' ') : line);
}

function formatSubtitleCue(text = '') {
    const words = String(text)
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase()
        .split(' ')
        .filter(Boolean);

    const lines = wrapWords(words, 26, 3);
    return lines.map(line => styleWordsAlternating(line)).join('\\N');
}

function srtToStyledAss(srtPath, assPath) {
    const raw = fs.readFileSync(srtPath, 'utf8');
    const items = parseSrtBlocks(raw);

    const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes
WrapStyle: 2
YCbCr Matrix: TV.601

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: TopCaption,BebasNeue-Regular,24,&H00FFFFFF,&H001FB3F3,&H00000000,&H32000000,1,0,0,0,100,100,0,0,1,3,1,8,88,88,92,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
`;

    const events = items.map(({ start, end, text }) => {
        const assStart = srtTimeToAss(start);
        const assEnd = srtTimeToAss(end);
        const styledBlock = formatSubtitleCue(text);
        return `Dialogue: 0,${assStart},${assEnd},TopCaption,,0,0,0,,${styledBlock}`;
    });

    fs.writeFileSync(assPath, `${header}\n${events.join('\n')}\n`, 'utf8');
    return assPath;
}

// ─── Burn subtitle top with ASS ───────────────────────────────────────────────
async function burnTopSubtitle(videoPath, assPath, outputPath) {
    const assEscaped = assPath
        .replace(/\\/g, '/')
        .replace(/^([A-Z]):/, (_, d) => `${d}\\:`)
        .replace(/'/g, "\\'");

    const cmd = `ffmpeg -y -i "${videoPath}" -vf "ass='${assEscaped}'" -c:v libx264 -preset medium -crf 22 -c:a copy "${outputPath}"`;

    await runCommand(cmd, 'burn-top-subtitle-ass');
    if (!fs.existsSync(outputPath)) throw new Error('Subtitle burn failed');

    return outputPath;
}

// ─── Create base video from poster + audio ───────────────────────────────────
async function createPosterVideo(posterPath, audioPath, tempDir) {
    const rawPath = path.join(tempDir, 'poster_raw.mp4');
    const duration = await getMediaDuration(audioPath);

    const cmd = `ffmpeg -y -loop 1 -i "${posterPath}" -i "${audioPath}" -vf "scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=yuv420p" -map 0:v -map 1:a -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest -t ${duration.toFixed(3)} "${rawPath}"`;

    await runCommand(cmd, 'create-poster-video');

    if (!fs.existsSync(rawPath)) throw new Error('Poster video creation failed');
    return rawPath;
}

// ─── CORE processVideo ────────────────────────────────────────────────────────
async function processVideo(payload, jobId, onProgress = () => { }) {
    const {
        id,
        content,
        title,
        images,
        language = 'pt',
        badgeTop,
        badgeBottom,
        episode,
        footerBrand,
    } = payload;

    const tempDir = path.join(TEMP_DIR, jobId);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    try {
        const audioPath = path.join(tempDir, 'audio.mp3');
        const srtPath = path.join(tempDir, 'subtitle.srt');
        const assPath = path.join(tempDir, 'subtitle.ass');
        const posterPath = path.join(tempDir, 'poster.jpg');
        const finalPath = path.join(tempDir, 'final_output.mp4');

        onProgress({ progress: 10, step: 'tts', message: 'Đang tạo giọng đọc TTS...' });
        const ttsResult = await generateAudioWithRetry(content, audioPath, jobId, 5, language);

        const audioDuration = await getMediaDuration(audioPath);
        console.log(`[${jobId}] 🎵 Duration: ${audioDuration.toFixed(2)}s`);

        let hasSub = false;
        if (ttsResult?.srtUrl) {
            try {
                const srtRes = await axios.get(ttsResult.srtUrl, {
                    timeout: 15000,
                    responseType: 'arraybuffer',
                });
                fs.writeFileSync(srtPath, srtRes.data);
                hasSub = true;
                console.log(`[${jobId}] 📝 SRT downloaded`);
                logFileState('subtitle-srt', srtPath);

                srtToStyledAss(srtPath, assPath);
                logFileState('subtitle-ass', assPath);
            } catch (e) {
                console.warn(`[${jobId}] ⚠️ Subtitle failed: ${e.message}`);
            }
        }

        onProgress({ progress: 30, step: 'images', message: `Đang tải ${images.length} ảnh...` });
        const localImgPaths = await Promise.all(
            images.map((url, i) => downloadImage(url, path.join(tempDir, `img_${i}.jpg`)))
        );

        const mainImage = localImgPaths[0];
        logFileState('main-image', mainImage);

        onProgress({ progress: 45, step: 'poster', message: 'Đang tạo poster...' });
        const posterBase64 = await generatePoster({
            image: `file://${mainImage.replace(/\\/g, '/')}`,
            title,
            badgeTop,
            badgeBottom,
            episode,
            footerBrand,
        });

        saveBase64Image(posterBase64, posterPath);
        logFileState('poster-jpg', posterPath);

        onProgress({ progress: 65, step: 'render', message: 'Đang render video từ poster + audio...' });
        const createdVideo = await createPosterVideo(posterPath, audioPath, tempDir);
        logFileState('poster-raw-video', createdVideo);

        let finalVideo = createdVideo;

        if (hasSub && fs.existsSync(assPath)) {
            onProgress({ progress: 80, step: 'subtitle', message: 'Đang chèn subtitle phía trên...' });
            finalVideo = await burnTopSubtitle(createdVideo, assPath, finalPath);
            logFileState('final-video-with-subtitle', finalVideo);
        } else {
            fs.copyFileSync(createdVideo, finalPath);
            finalVideo = finalPath;
        }

        onProgress({ progress: 92, step: 'upload', message: 'Đang upload video...' });
        const uploadResult = await uploadVideo(finalVideo, `podcast_${jobId}.mp4`);
        if (!uploadResult?.url) throw new Error('Upload failed');

        let webhookResult = null;
        if (id && String(id).trim()) {
            onProgress({ progress: 96, step: 'webhook', message: 'Đang gửi kết quả về webhook...' });
            webhookResult = await sendResultWebhook(String(id).trim(), uploadResult.url);
        }

        onProgress({ progress: 98, step: 'cleanup', message: 'Đang dọn file tạm...' });
        cleanupTempDir(tempDir);

        onProgress({ progress: 100, step: 'done', message: 'Hoàn thành!' });

        return {
            success: true,
            id,
            videoUrl: uploadResult.url,
            uploadService: uploadResult.service,
            permanent: uploadResult.permanent || false,
            webhookSent: !!(id && String(id).trim()),
            webhookResult,
            metadata: {
                imageCount: images.length,
                ttsDuration: audioDuration.toFixed(2),
                hasSubtitle: hasSub,
                resolution: `${W}x${H}`,
                layout: 'Poster static + top ASS subtitle + audio',
            },
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

    const payload = job.payload;

    try {
        setJob(jobId, {
            status: 'processing',
            progress: 3,
            step: 'starting',
            message: 'Bắt đầu xử lý video',
            startedAt: new Date().toISOString(),
            error: null,
        });

        const result = await processVideo(payload, jobId, ({ progress, step, message }) => {
            setJob(jobId, { status: 'processing', progress, step, message });
        });

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

// ─── POST / ───────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const {
        id,
        content,
        title,
        images,
        language,
        badgeTop,
        badgeBottom,
        episode,
        footerBrand,
    } = req.body || {};

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
        imageUrls = images.filter(u => typeof u === 'string' && (u.startsWith('http') || u.startsWith('https')));
    }

    if (imageUrls.length === 0) {
        return res.status(400).json({ success: false, error: 'images (string or array of URLs) required' });
    }

    const SUPPORTED_LANGUAGES = ['en', 'pt', 'es', 'de', 'jp'];
    const lang = SUPPORTED_LANGUAGES.includes(language) ? language : 'pt';

    const job = createJob({
        id: id || '',
        content,
        title,
        images: imageUrls,
        language: lang,
        badgeTop,
        badgeBottom,
        episode,
        footerBrand,
    });

    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║ 🎙️ PODCAST Job: ${job.id}`);
    console.log(`║ 📰 Title: "${title.substring(0, 50)}"`);
    console.log(`║ 🖼️ Images: ${imageUrls.length}`);
    console.log(`╚══════════════════════════════════════════════════════╝`);

    res.status(202).json({
        success: true,
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        step: job.step,
        message: job.message,
        pollUrl: `/api/podcastHook/${job.id}`,
        eventsUrl: `/api/podcastHook/${job.id}/events`,
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

// ─── GET /:jobId ──────────────────────────────────────────────────────────────
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

// ─── DELETE /:jobId ───────────────────────────────────────────────────────────
router.delete('/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);

    if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found' });
    }

    jobs.delete(req.params.jobId);
    return res.json({ success: true, message: 'Job deleted' });
});

// ─── GET /:jobId/events ───────────────────────────────────────────────────────
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