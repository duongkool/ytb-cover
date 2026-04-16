const axios = require('axios');
const fs = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const config = require('../config');
const { smartDownload } = require('./fastDownloader');

const execAsync = promisify(exec);

// ─────────────────────────────────────────────
// STEP 1: Gọi RapidAPI → nhận progress_url + info
// ─────────────────────────────────────────────
async function requestVideoDownload(youtubeUrl, musicUrl = '', isShort = false, retries = 5, delayMs = 2000) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📡 Requesting video download... (attempt ${attempt}/${retries})`);

            const res = await axios.get(
                'https://youtube-info-download-api.p.rapidapi.com/ajax/download.php',
                {
                    params: {
                        format: isShort ? '720' : '480',
                        add_info: '0',
                        url: youtubeUrl,
                        audio_quality: '128',
                        allow_extended_duration: 'false',
                        no_merge: musicUrl ? 'true' : 'false',
                        audio_language: 'en'
                    },
                    headers: {
                        'x-rapidapi-key': config.RAPIDAPI_KEY,
                        'x-rapidapi-host': 'youtube-info-download-api.p.rapidapi.com'
                    },
                    timeout: 30000
                }
            );

            if (!res.data?.success) throw new Error('RapidAPI returned success=false');
            if (!res.data?.progress_url) throw new Error('No progress_url in response');

            console.log(`✅ Job created: ${res.data.id}`);
            console.log(`   Title: ${res.data.title}`);
            console.log(`   Format: ${isShort ? '720p (Shorts)' : '480p'}`);
            console.log(`   no_merge: ${musicUrl ? 'true' : 'false'}`);

            return {
                id: res.data.id,
                title: res.data.title,
                thumbnail: res.data.info?.image || null,
                progress_url: res.data.progress_url
            };

        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Attempt ${attempt}/${retries} failed: ${err.message}`);

            if (attempt < retries) {
                const wait = delayMs * attempt;
                console.log(`⏳ Retrying in ${wait / 1000}s...`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }

    throw new Error(`RapidAPI request failed after ${retries} attempts: ${lastError.message}`);
}

// ─────────────────────────────────────────────
// STEP 2: Poll progress_url mỗi 3s → lấy download_url
// ─────────────────────────────────────────────
async function pollDownloadUrl(progressUrl, videoId, maxWaitMs = 300000) {
    const startTime = Date.now();
    let attempt = 0;

    console.log(`[${videoId}] ⏳ Polling progress...`);

    while (Date.now() - startTime < maxWaitMs) {
        attempt++;
        try {
            const res = await axios.get(progressUrl, { timeout: 15000 });
            const data = res.data;

            const progress = data.progress ?? 0;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            console.log(`[${videoId}] 📊 Progress: ${progress}/1000 (${elapsed}s)`);

            if (data.success == 1 && progress >= 1000 && data.download_url) {
                console.log(`[${videoId}] ✅ Download URL ready: ${data.download_url}`);
                return data.download_url;
            }

            if (data.success == 0) {
                throw new Error(`Server error: ${data.text || 'Unknown error'}`);
            }

        } catch (err) {
            console.warn(`[${videoId}] ⚠️ Poll attempt ${attempt} failed: ${err.message}`);
        }

        await new Promise(r => setTimeout(r, 3000));
    }

    throw new Error(`Timeout: Video not ready after ${maxWaitMs / 1000}s`);
}

// ─────────────────────────────────────────────
// Lấy thumbnail chất lượng cao từ video-meta API
// ─────────────────────────────────────────────
async function getHighQualityThumbnail(youtubeUrl) {
    try {
        const match = youtubeUrl.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (!match) throw new Error('Cannot extract video ID');
        const videoId = match[1];

        try {
            const res = await axios.post(
                'https://n8n2.xopboo.com/webhook/video-meta',
                { video_id: videoId },
                { timeout: 15000 }
            );
            if (res.data?.og_image) {
                const check = await axios.head(res.data.og_image, { timeout: 5000 });
                if (check.status === 200) {
                    console.log(`✅ High-quality thumbnail: ${res.data.og_image}`);
                    return res.data.og_image;
                }
            }
        } catch (err) {
            console.warn(`⚠️ video-meta API or maxres check failed: ${err.message}`);
        }

        // Fallback tuần tự
        const fallbacks = [
            `https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        ];

        for (const url of fallbacks) {
            try {
                const check = await axios.head(url, { timeout: 5000 });
                if (check.status === 200) {
                    console.log(`✅ Fallback thumbnail: ${url}`);
                    return url;
                }
            } catch { }
        }

        return null;
    } catch (err) {
        console.warn(`⚠️ getHighQualityThumbnail failed: ${err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────
// Download direct video (dùng smartDownload)
// ─────────────────────────────────────────────
async function downloadDirectVideo(url, outputPath, videoId, startTime = 0, endTime = 50, totalDuration = null, retries = 5, delayMs = 2000) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await smartDownload(url, outputPath, videoId, startTime, endTime, totalDuration);
            if (!fs.existsSync(outputPath)) throw new Error('Download failed - file not created');
            return;
        } catch (err) {
            lastError = err;
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { }

            console.warn(`[${videoId}] ⚠️ Download attempt ${attempt}/${retries} failed: ${err.message}`);

            if (attempt < retries) {
                const wait = delayMs * attempt;
                console.log(`[${videoId}] ⏳ Retrying download in ${wait / 1000}s...`);
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }

    throw new Error(`Download failed after ${retries} attempts: ${lastError.message}`);
}

// ─────────────────────────────────────────────
// Main: Download YouTube video
// ─────────────────────────────────────────────
async function downloadYoutubeVideo(youtubeUrl, outputPath, videoId, startTime = 0, endTime = 50, musicUrl = '', isShort = false) {
    console.log(`[${videoId}] 📥 Downloading YouTube via RapidAPI... (${isShort ? 'Shorts 720p' : 'Normal 480p'})`);

    try {
        console.log(`[${videoId}] 🚀 Fetching video info + thumbnail in parallel...`);
        const [jobInfo, hqThumbnail] = await Promise.all([
            requestVideoDownload(youtubeUrl, musicUrl, isShort),
            getHighQualityThumbnail(youtubeUrl)
        ]);

        const thumbnail = hqThumbnail || jobInfo.thumbnail;
        console.log(`[${videoId}] 🖼️ Thumbnail: ${thumbnail}`);

        const downloadUrl = await pollDownloadUrl(jobInfo.progress_url, videoId);

        console.log(`[${videoId}] 📦 Downloading merged video...`);
        await downloadDirectVideo(downloadUrl, outputPath, videoId, startTime, endTime, null);

        console.log(`[${videoId}] ✅ Done: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);

        return {
            title: jobInfo.title,
            thumbnail,
            hasAudio: true,
            isShort
        };

    } catch (err) {
        throw new Error(`YouTube download failed: ${err.message}`);
    }
}

// ─────────────────────────────────────────────
function detectVideoUrlType(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
    if (url.includes('googlevideo.com') || url.includes('savenow.to')) return 'direct';
    return 'unknown';
}

module.exports = { downloadDirectVideo, downloadYoutubeVideo, detectVideoUrlType };