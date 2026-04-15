const axios = require('axios');
const fs = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const config = require('../config');
const { smartDownload } = require('./fastDownloader');

const execAsync = promisify(exec);

async function getVideoInfo(youtubeUrl, retries = 5, delayMs = 2000) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📡 Fetching video info... (attempt ${attempt}/${retries})`);
            const res = await axios.get(config.CAPTICK_API_URL, {
                params: { url: youtubeUrl },
                timeout: 30000
            });
            if (!res.data?.data) throw new Error('Invalid Captick API response');
            console.log(`✅ Video: ${res.data.data.title}`);
            return res.data.data;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Attempt ${attempt}/${retries} failed: ${err.message}`);

            if (attempt < retries) {
                const wait = delayMs * attempt; // 2s, 4s, 6s, 8s...
                console.log(`⏳ Retrying in ${wait / 1000}s...`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }

    throw new Error(`Captick API failed after ${retries} attempts: ${lastError.message}`);
}

function find720pFormat(formats) {
    let video = formats.find(f => f.format_note === '720p' && f.format_id === '136')
        || formats.find(f => f.format_note === '720p' && f.resolution && !f.resolution.includes('audio only'));

    if (!video) {
        const f360 = formats.find(f => f.format_id === '18');
        if (f360) {
            console.log(`⚠️ 720p not found, using 360p`);
            return { video: f360, audio: null, combined: true };
        }
        throw new Error('No suitable video format found');
    }

    const audio = formats.find(f => f.format_id === '140' && f.is_audio === true)
        || formats.find(f => f.is_audio === true || f.resolution?.includes('audio only'));

    return { video, audio: audio || null, combined: false };
}

// ✅ Fix moov atom cho partial download
async function fixMoovAtom(inputPath, outputPath, videoId) {
    try {
        console.log(`[${videoId}] 🔧 Fixing moov atom: ${inputPath}`);
        await execAsync(
            `ffmpeg -fflags +genpts+igndts -i "${inputPath}" -c copy -y "${outputPath}"`,
            { maxBuffer: 50 * 1024 * 1024 }
        );
        return fs.existsSync(outputPath);
    } catch (err) {
        console.warn(`[${videoId}] ⚠️ fixMoovAtom failed: ${err.message}`);
        return false;
    }
}

async function downloadDirectVideo(url, outputPath, videoId, startTime = 0, endTime = 50, totalDuration = null, retries = 5, delayMs = 2000) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await smartDownload(url, outputPath, videoId, startTime, endTime, totalDuration);
            if (!fs.existsSync(outputPath)) throw new Error('Download failed - file not created');
            return; // ✅ thành công
        } catch (err) {
            lastError = err;

            // Xóa file lỗi nếu có
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { }

            console.warn(`[${videoId}] ⚠️ Download attempt ${attempt}/${retries} failed: ${err.message}`);

            if (attempt < retries) {
                const wait = delayMs * attempt; // 2s, 4s, 6s, 8s...
                console.log(`[${videoId}] ⏳ Retrying download in ${wait / 1000}s...`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }

    throw new Error(`Download failed after ${retries} attempts: ${lastError.message}`);
}
async function downloadYoutubeVideo(youtubeUrl, outputPath, videoId, startTime = 0, endTime = 50) {
    console.log(`[${videoId}] 📥 Downloading YouTube via Captick API...`);
    const tempVideo = outputPath.replace('.mp4', '_video.mp4');
    const tempAudio = outputPath.replace('.mp4', '_audio.m4a');
    const tempVideoFixed = outputPath.replace('.mp4', '_video_fixed.mp4');
    const tempAudioFixed = outputPath.replace('.mp4', '_audio_fixed.m4a');

    const cleanupAll = () => {
        [tempVideo, tempAudio, tempVideoFixed, tempAudioFixed].forEach(f => {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { }
        });
    };

    try {
        const info = await getVideoInfo(youtubeUrl);
        const fmt = find720pFormat(info.formats);

        // Combined format (360p)
        if (fmt.combined) {
            await downloadDirectVideo(fmt.video.url, outputPath, videoId, startTime, endTime, info.duration);
            return { title: info.title, duration: info.duration, thumbnail: info.thumbnail, hasAudio: true };
        }

        // Không có audio
        if (!fmt.audio) {
            await downloadDirectVideo(fmt.video.url, outputPath, videoId, startTime, endTime, info.duration);
            return { title: info.title, duration: info.duration, thumbnail: info.thumbnail, hasAudio: false };
        }

        // Download song song video + audio
        console.log(`[${videoId}] 📦 Downloading video + audio in parallel...`);
        await Promise.all([
            downloadDirectVideo(fmt.video.url, tempVideo, videoId, startTime, endTime, info.duration),
            downloadDirectVideo(fmt.audio.url, tempAudio, videoId, startTime, endTime, info.duration)
        ]);

        // ✅ Fix moov atom cho cả 2 file
        console.log(`[${videoId}] 🔧 Fixing moov atoms...`);
        const [videoFixed, audioFixed] = await Promise.all([
            fixMoovAtom(tempVideo, tempVideoFixed, videoId),
            fixMoovAtom(tempAudio, tempAudioFixed, videoId)
        ]);

        // Chọn file để merge: dùng fixed nếu thành công, fallback về original
        const videoInput = videoFixed ? tempVideoFixed : tempVideo;
        const audioInput = audioFixed ? tempAudioFixed : tempAudio;

        if (!fs.existsSync(audioInput)) {
            fs.renameSync(videoInput, outputPath);
            cleanupAll();
            return { title: info.title, duration: info.duration, thumbnail: info.thumbnail, hasAudio: false };
        }

        // Merge
        console.log(`[${videoId}] 🔗 Merging video + audio...`);
        await execAsync(
            `ffmpeg -fflags +genpts -i "${videoInput}" -i "${audioInput}" -c:v copy -c:a aac -b:a 128k -shortest -y "${outputPath}"`,
            { maxBuffer: 50 * 1024 * 1024 }
        );

        cleanupAll();

        console.log(`[${videoId}] ✅ Merged: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
        return { title: info.title, duration: info.duration, thumbnail: info.thumbnail, hasAudio: true };

    } catch (err) {
        cleanupAll();
        throw new Error(`YouTube download failed: ${err.message}`);
    }
}

function detectVideoUrlType(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('googlevideo.com')) return 'direct';
    return 'unknown';
}

module.exports = { downloadDirectVideo, downloadYoutubeVideo, detectVideoUrlType };