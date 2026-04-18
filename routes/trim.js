const express = require('express');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const axios = require('axios');
const { EventEmitter } = require('events');

const config = require('../config');
const { downloadYoutubeVideo, downloadDirectVideo, detectVideoUrlType } = require('../utils/videoDownloader');
const { generateAudioFromText } = require('../utils/audioGenerator');
const { uploadVideo } = require('../utils/uploadService');

const execAsync = promisify(exec);
const router = express.Router();

const jobs = new Map();
const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(1000);

const JOB_TTL_MS = 24 * 60 * 60 * 1000;

function generateJobId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function createTempDir(videoId) {
    const tempDir = path.join(__dirname, '..', 'temp', String(videoId));
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
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

function sanitizeError(error) {
    return error?.message || 'Unknown error';
}

function getJob(jobId) {
    return jobs.get(jobId) || null;
}

function setJob(jobId, patch) {
    const current = jobs.get(jobId) || {};
    const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
    };
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
        message: 'Job đã được tạo',
        createdAt: now,
        updatedAt: now,
        payload: {
            youtubeUrl: payload.youtubeUrl,
            startTime: payload.startTime,
            endTime: payload.endTime,
            audioMode: payload.audioMode,
            hookText: payload.audioMode === 'hook' ? payload.hookText : '',
            musicUrl: payload.musicUrl || '',
            isShort: !!payload.isShort,
        },
        result: null,
        error: null,
    };

    jobs.set(jobId, job);
    return job;
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

function validatePayload({ youtubeUrl, startTime, endTime, audioMode, hookText, isShort }) {
    if (!youtubeUrl || !String(youtubeUrl).trim()) {
        throw new Error('Missing required param: youtubeUrl');
    }

    const shortMode = !!isShort;
    const mode = audioMode || 'original';

    if (!['original', 'hook'].includes(mode)) {
        throw new Error('audioMode must be "original" or "hook"');
    }

    if (mode === 'hook' && (!hookText || !String(hookText).trim())) {
        throw new Error('hookText is required when audioMode is "hook"');
    }

    if (!shortMode) {
        if (startTime === undefined || endTime === undefined || endTime === null) {
            throw new Error('Missing required params: startTime, endTime');
        }
        if (Number(endTime) <= Number(startTime)) {
            throw new Error('endTime must be greater than startTime');
        }
        if (Number(startTime) < 0) {
            throw new Error('startTime không được âm');
        }
        if (Number(endTime) - Number(startTime) > 300) {
            throw new Error('Đoạn trim tối đa 300s');
        }
    }
}

async function processVideo(
    youtubeUrl,
    startTime,
    endTime,
    audioMode,
    hookText,
    videoId = Date.now(),
    musicUrl = '',
    isShort = false,
    onProgress = () => { }
) {
    validatePayload({ youtubeUrl, startTime, endTime, audioMode, hookText, isShort });

    const tempDir = createTempDir(videoId);
    const inputPath = path.join(tempDir, 'input.mp4');
    const trimmedPath = path.join(tempDir, 'trimmed.mp4');
    const thumbnailPath = path.join(tempDir, 'thumb.jpg');
    const hookAudioPath = path.join(tempDir, 'hook.mp3');
    const musicPath = path.join(tempDir, 'music.mp3');
    const withAudioPath = path.join(tempDir, 'withaudio.mp4');
    const stackedPath = path.join(tempDir, 'stacked.mp4');
    const outputPath = path.join(tempDir, 'output.mp4');
    const processStart = Date.now();

    try {
        onProgress({ progress: 5, step: 'download', message: 'Đang xác định loại URL...' });

        const urlType = detectVideoUrlType(youtubeUrl);
        let videoMetadata = {};

        console.log(`[${videoId}] 🔍 URL type: ${urlType} | isShort: ${isShort}`);

        onProgress({ progress: 10, step: 'download', message: 'Đang tải video nguồn...' });

        if (urlType === 'youtube') {
            videoMetadata = await downloadYoutubeVideo(
                youtubeUrl,
                inputPath,
                videoId,
                isShort ? 0 : startTime,
                isShort ? null : endTime,
                musicUrl,
                isShort
            );
        } else if (urlType === 'direct') {
            await downloadDirectVideo(youtubeUrl, inputPath, videoId, 0, null, null);
        } else {
            throw new Error('Unsupported URL. Use YouTube or direct video URL.');
        }

        if (!fs.existsSync(inputPath)) throw new Error('Video download failed');
        const inputSize = fs.statSync(inputPath).size;
        console.log(`[${videoId}] ✅ Downloaded: ${(inputSize / 1024 / 1024).toFixed(2)} MB`);

        onProgress({ progress: 20, step: 'thumbnail', message: 'Đang chuẩn bị thumbnail...' });

        if (urlType === 'youtube' && videoMetadata.thumbnail) {
            console.log(`[${videoId}] 📸 Downloading thumbnail...`);
            const res = await axios.get(videoMetadata.thumbnail, {
                responseType: 'arraybuffer',
                timeout: 15000
            });
            fs.writeFileSync(thumbnailPath, res.data);
        } else {
            console.log(`[${videoId}] 📸 Extracting thumbnail from video...`);
            await execAsync(
                `ffmpeg -i "${inputPath}" -vframes 1 -q:v 2 -y "${thumbnailPath}"`,
                { maxBuffer: 10 * 1024 * 1024 }
            );
            if (!fs.existsSync(thumbnailPath)) throw new Error('Thumbnail extraction failed');
        }
        console.log(`[${videoId}] ✅ Thumbnail ready`);

        onProgress({ progress: 35, step: 'trim', message: isShort ? 'Đang xử lý Shorts...' : 'Đang trim video...' });

        let duration;

        if (isShort) {
            const { stdout: durRaw } = await execAsync(
                `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${inputPath}"`
            );
            duration = parseFloat(durRaw.trim());

            console.log(`[${videoId}] 📱 Shorts: full duration ${duration.toFixed(2)}s — copying...`);

            await execAsync(
                `ffmpeg -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${trimmedPath}"`,
                { maxBuffer: 50 * 1024 * 1024 }
            );
        } else {
            duration = Number(endTime) - Number(startTime);

            console.log(`[${videoId}] ✂️ Trimming ${startTime}s → ${endTime}s (${duration}s)...`);

            await execAsync(
                `ffmpeg -ss ${startTime} -i "${inputPath}" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${trimmedPath}"`,
                { maxBuffer: 50 * 1024 * 1024 }
            );
        }

        if (!fs.existsSync(trimmedPath)) throw new Error('Trim failed');
        console.log(`[${videoId}] ✅ Trimmed (${duration.toFixed(2)}s)`);

        const { stdout: dim } = await execAsync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${trimmedPath}"`
        );
        const [videoWidth] = dim.trim().split('x').map(Number);
        console.log(`[${videoId}] 📐 Dimensions: ${dim.trim()}`);

        let mainVideo = trimmedPath;

        if (musicUrl) {
            onProgress({ progress: 50, step: 'audio', message: 'Đang ghép nhạc nền...' });

            console.log(`[${videoId}] 🎵 Applying music: ${musicUrl}`);
            const musicRes = await axios.get(musicUrl, {
                responseType: 'arraybuffer',
                timeout: 20000
            });
            fs.writeFileSync(musicPath, musicRes.data);

            await execAsync(
                `ffmpeg -i "${trimmedPath}" -stream_loop -1 -i "${musicPath}" ` +
                `-t ${duration} ` +
                `-map 0:v -map 1:a ` +
                `-c:v copy -c:a aac -b:a 128k ` +
                `-shortest -y "${withAudioPath}"`,
                { maxBuffer: 50 * 1024 * 1024 }
            );

            mainVideo = withAudioPath;
            console.log(`[${videoId}] ✅ Music applied`);
        } else if (audioMode === 'hook') {
            onProgress({ progress: 50, step: 'tts', message: 'Đang tạo giọng đọc TTS...' });

            console.log(`[${videoId}] 🎤 Hook mode: generating TTS...`);
            await generateAudioFromText(hookText, hookAudioPath, videoId);
            if (!fs.existsSync(hookAudioPath)) throw new Error('TTS generation failed');

            await execAsync(
                `ffmpeg -i "${trimmedPath}" -i "${hookAudioPath}" ` +
                `-filter_complex "[1:a]apad[a]" -map 0:v -map "[a]" ` +
                `-c:v copy -c:a aac -b:a 128k -shortest -y "${withAudioPath}"`,
                { maxBuffer: 50 * 1024 * 1024 }
            );

            mainVideo = withAudioPath;
            console.log(`[${videoId}] ✅ Audio replaced`);
        } else {
            onProgress({ progress: 50, step: 'audio', message: 'Giữ nguyên audio gốc...' });
        }

        let mainVideoForNormalize = mainVideo;

        if (!isShort) {
            onProgress({ progress: 65, step: 'stack', message: 'Đang ghép thumbnail vào video...' });

            console.log(`[${videoId}] 🎨 Stacking video + thumbnail...`);
            await execAsync(
                `ffmpeg -i "${mainVideo}" -i "${thumbnailPath}" ` +
                `-filter_complex "[0:v]pad=iw:ih+5:0:0:white[video_padded];` +
                `[1:v]scale=${videoWidth}:-2[thumb_padded];` +
                `[video_padded][thumb_padded]vstack=inputs=2[v]" ` +
                `-map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${stackedPath}"`,
                { maxBuffer: 50 * 1024 * 1024 }
            );

            if (!fs.existsSync(stackedPath)) throw new Error('Stack failed');
            mainVideoForNormalize = stackedPath;
            console.log(`[${videoId}] ✅ Stacked`);
        } else {
            console.log(`[${videoId}] 📱 Shorts mode — skipping thumbnail stack`);
        }

        onProgress({ progress: 80, step: 'normalize', message: 'Đang normalize video đầu ra...' });

        console.log(`[${videoId}] 🔄 Normalizing...`);
        await execAsync(
            `ffmpeg -i "${mainVideoForNormalize}" ` +
            `-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -r 30 -g 60 -keyint_min 60 ` +
            `-c:a aac -b:a 128k -ar 44100 -ac 2 -y "${outputPath}"`,
            { maxBuffer: 50 * 1024 * 1024 }
        );

        if (!fs.existsSync(outputPath)) throw new Error('Normalize failed');

        const { stdout: durOut } = await execAsync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
        );
        const finalDuration = parseFloat(durOut.trim());
        const outputSize = fs.statSync(outputPath).size;

        console.log(`[${videoId}] ✅ Output: ${(outputSize / 1024 / 1024).toFixed(2)} MB, ${finalDuration.toFixed(2)}s`);

        onProgress({ progress: 92, step: 'upload', message: 'Đang upload video...' });

        console.log(`[${videoId}] 📤 Uploading...`);
        const uploadStart = Date.now();

        const uploadResult = await uploadVideo(outputPath, `trimmed_${audioMode}_${videoId}.mp4`);
        if (!uploadResult.success) throw new Error('Upload failed');

        const uploadTime = ((Date.now() - uploadStart) / 1000).toFixed(1);
        console.log(`[${videoId}] ✅ Uploaded in ${uploadTime}s: ${uploadResult.url}`);

        onProgress({ progress: 98, step: 'cleanup', message: 'Đang dọn file tạm...' });

        cleanupTempDir(tempDir);

        const totalTime = ((Date.now() - processStart) / 1000).toFixed(1);
        console.log(`[${videoId}] 🎉 Done in ${totalTime}s`);

        onProgress({ progress: 100, step: 'done', message: 'Hoàn thành xử lý video' });

        return {
            success: true,
            videoUrl: uploadResult.url,
            uploadService: uploadResult.service,
            permanent: uploadResult.permanent || false,
            expiresIn: uploadResult.expiresIn || null,
            metadata: {
                duration,
                startTime: isShort ? 0 : Number(startTime),
                endTime: isShort ? duration : Number(endTime),
                finalDuration,
                audioMode,
                hookText: audioMode === 'hook' ? hookText : null,
                musicUrl: musicUrl || null,
                isShort,
                originalSize: inputSize,
                finalSize: outputSize,
                processingTime: parseFloat(totalTime),
                uploadTime: parseFloat(uploadTime),
                sourceType: urlType,
            },
            message: `✅ ${isShort ? 'Shorts' : 'Trimmed'} ${duration.toFixed(1)}s → final ${finalDuration.toFixed(1)}s`
        };
    } catch (error) {
        cleanupTempDir(tempDir);
        throw error;
    }
}

async function runJob(jobId) {
    const job = getJob(jobId);
    if (!job) return;

    const {
        youtubeUrl,
        startTime,
        endTime,
        audioMode,
        hookText,
        musicUrl,
        isShort
    } = job.payload;

    try {
        setJob(jobId, {
            status: 'processing',
            progress: 3,
            step: 'starting',
            message: 'Bắt đầu xử lý video',
            startedAt: new Date().toISOString(),
            error: null
        });

        const result = await processVideo(
            youtubeUrl,
            startTime,
            endTime,
            audioMode,
            hookText,
            Date.now(),
            musicUrl,
            isShort,
            ({ progress, step, message }) => {
                setJob(jobId, {
                    status: 'processing',
                    progress: typeof progress === 'number' ? progress : job.progress,
                    step: step || job.step,
                    message: message || job.message,
                });
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

router.post('/', async (req, res) => {
    try {
        const payload = {
            youtubeUrl: req.body.youtubeUrl,
            startTime: req.body.isShort ? 0 : Number(req.body.startTime),
            endTime: req.body.isShort ? null : Number(req.body.endTime),
            audioMode: req.body.audioMode || 'original',
            hookText: req.body.hookText || '',
            musicUrl: req.body.musicUrl || '',
            isShort: !!req.body.isShort,
        };

        validatePayload(payload);

        const job = createJob(payload);

        res.status(202).json({
            success: true,
            jobId: job.id,
            status: job.status,
            progress: job.progress,
            step: job.step,
            message: job.message,
            pollUrl: `/api/trim/${job.id}`
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
    } catch (error) {
        res.status(400).json({
            success: false,
            error: 'Invalid request',
            details: sanitizeError(error)
        });
    }
});

router.get('/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);

    if (!job) {
        return res.status(404).json({
            success: false,
            error: 'Job not found'
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
        error: job.error,
        result: job.status === 'done' ? job.result : null
    });
});

router.delete('/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);

    if (!job) {
        return res.status(404).json({
            success: false,
            error: 'Job not found'
        });
    }

    jobs.delete(req.params.jobId);

    return res.json({
        success: true,
        message: 'Job deleted'
    });
});

router.get('/:jobId/events', (req, res) => {
    const jobId = req.params.jobId;
    const job = getJob(jobId);

    if (!job) {
        return res.status(404).json({
            success: false,
            error: 'Job not found'
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    if (res.flushHeaders) res.flushHeaders();

    const send = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        step: job.step,
        message: job.message,
        error: job.error,
        result: job.status === 'done' ? job.result : null
    });

    const listener = (updatedJob) => {
        send({
            jobId: updatedJob.id,
            status: updatedJob.status,
            progress: updatedJob.progress,
            step: updatedJob.step,
            message: updatedJob.message,
            error: updatedJob.error,
            result: updatedJob.status === 'done' ? updatedJob.result : null
        });

        if (updatedJob.status === 'done' || updatedJob.status === 'failed') {
            res.end();
        }
    };

    jobEvents.on(`job:${jobId}`, listener);

    const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        jobEvents.off(`job:${jobId}`, listener);
    });
});

module.exports = router;
module.exports.processVideo = processVideo;
module.exports.jobs = jobs;