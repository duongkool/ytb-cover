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
async function requestVideoDownload(youtubeUrl, retries = 5, delayMs = 2000) {
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📡 Requesting video download... (attempt ${attempt}/${retries})`);

            const res = await axios.get(
                'https://youtube-info-download-api.p.rapidapi.com/ajax/download.php',
                {
                    params: {
                        format: '480',
                        add_info: '0',
                        url: youtubeUrl,
                        audio_quality: '128',
                        allow_extended_duration: 'false',
                        no_merge: 'false',
                        audio_language: 'en'
                    },
                    headers: {
                        'x-rapidapi-key': "f6fe2e6663msh497decc6d77837dp12c1a8jsn3417c2dd3abb",
                        'x-rapidapi-host': 'youtube-info-download-api.p.rapidapi.com'
                    },
                    timeout: 30000
                }
            );

            if (!res.data?.success) throw new Error('RapidAPI returned success=false');
            if (!res.data?.progress_url) throw new Error('No progress_url in response');

            console.log(`✅ Job created: ${res.data.id}`);
            console.log(`   Title: ${res.data.title}`);
            console.log(`   Progress URL: ${res.data.progress_url}`);

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

            // ✅ Hoàn thành khi progress = 1000
            if (data.success == 1 && progress >= 1000 && data.download_url) {
                console.log(`[${videoId}] ✅ Download URL ready: ${data.download_url}`);
                return data.download_url;
            }

            // Lỗi từ server
            if (data.success == 0) {
                throw new Error(`Server error: ${data.text || 'Unknown error'}`);
            }

        } catch (err) {
            console.warn(`[${videoId}] ⚠️ Poll attempt ${attempt} failed: ${err.message}`);
        }

        // Chờ 3s trước khi poll lại
        await new Promise(r => setTimeout(r, 3000));
    }

    throw new Error(`Timeout: Video not ready after ${maxWaitMs / 1000}s`);
}

// ─────────────────────────────────────────────
// Lấy thumbnail chất lượng cao từ video-meta API
// ─────────────────────────────────────────────
async function getHighQualityThumbnail(youtubeUrl) {
    try {
        const match = youtubeUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (!match) throw new Error('Cannot extract video ID');
        const videoId = match[1];

        const res = await axios.post(
            'https://n8n2.xopboo.com/webhook/video-meta',
            { video_id: videoId },
            { timeout: 15000 }
        );

        if (res.data?.og_image) {
            console.log(`✅ High-quality thumbnail: ${res.data.og_image}`);
            return res.data.og_image;
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
// Main: Download YouTube video (video+audio đã merge sẵn)
// ─────────────────────────────────────────────
async function downloadYoutubeVideo(youtubeUrl, outputPath, videoId, startTime = 0, endTime = 50) {
    console.log(`[${videoId}] 📥 Downloading YouTube via RapidAPI...`);

    try {
        // STEP 1: Gọi song song RapidAPI + thumbnail API
        console.log(`[${videoId}] 🚀 Fetching video info + thumbnail in parallel...`);
        const [jobInfo, hqThumbnail] = await Promise.all([
            requestVideoDownload(youtubeUrl),
            getHighQualityThumbnail(youtubeUrl)
        ]);

        // Ưu tiên thumbnail HQ, fallback về thumbnail từ RapidAPI
        const thumbnail = hqThumbnail || jobInfo.thumbnail;
        console.log(`[${videoId}] 🖼️ Thumbnail: ${thumbnail}`);

        // STEP 2: Poll cho đến khi có download_url
        const downloadUrl = await pollDownloadUrl(jobInfo.progress_url, videoId);

        // STEP 3: Download file (video+audio đã merge sẵn từ API)
        console.log(`[${videoId}] 📦 Downloading merged video...`);
        await downloadDirectVideo(downloadUrl, outputPath, videoId, startTime, endTime, null);

        console.log(`[${videoId}] ✅ Done: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);

        return {
            title: jobInfo.title,
            thumbnail,
            hasAudio: true
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