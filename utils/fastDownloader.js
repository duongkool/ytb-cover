const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stream = require('stream');
const pipeline = promisify(stream.pipeline);

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB per chunk
const MAX_PARALLEL = 6;

async function getFileSize(url) {
    const res = await axios.head(url, { timeout: 10000, maxRedirects: 5 });
    return {
        size: parseInt(res.headers['content-length']),
        supportsRanges: res.headers['accept-ranges'] === 'bytes'
    };
}

async function downloadChunk(url, start, end, outputPath, idx, total) {
    const tempPath = `${outputPath}.part${idx}`;
    try {
        const res = await axios({
            method: 'get', url,
            responseType: 'stream',
            headers: { 'Range': `bytes=${start}-${end}` },
            timeout: 60000,
            maxRedirects: 5
        });
        await pipeline(res.data, fs.createWriteStream(tempPath));
        console.log(`   [Chunk ${idx + 1}/${total}] ✅`);
        return tempPath;
    } catch (err) {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { }
        throw new Error(`Chunk ${idx} failed: ${err.message}`);
    }
}

async function mergeChunks(chunkPaths, outputPath) {
    console.log(`   🔗 Merging ${chunkPaths.length} chunks...`);
    const ws = fs.createWriteStream(outputPath);
    for (const p of chunkPaths) {
        ws.write(fs.readFileSync(p));
        fs.unlinkSync(p);
    }
    ws.end();
    return new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
    });
}

async function downloadNormal(url, outputPath, videoId) {
    console.log(`[${videoId}] ⬇️ Normal download...`);
    const res = await axios({
        method: 'get', url,
        responseType: 'stream',
        timeout: 300000,
        maxRedirects: 5
    });
    await pipeline(res.data, fs.createWriteStream(outputPath));
    console.log(`[${videoId}] ✅ ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
    return true;
}

/**
 * Smart download: chỉ tải đúng đoạn cần (startTime → endTime)
 * @param {string} url
 * @param {string} outputPath
 * @param {string} videoId
 * @param {number} startTime     - giây bắt đầu cần dùng
 * @param {number|null} endTime  - giây kết thúc, null = tải toàn bộ
 * @param {number|null} totalDuration - tổng duration video (giây)
 */
async function smartDownload(url, outputPath, videoId, startTime = 0, endTime = null, totalDuration = null) {
    // Guard: null hoặc >= 99999 → tải toàn bộ file (dành cho Shorts)
    const effectiveEndTime = (!endTime || endTime >= 99999) ? null : endTime;

    try {
        const { size, supportsRanges } = await getFileSize(url);

        if (!supportsRanges) {
            console.log(`[${videoId}] ⚠️ No range support, fallback normal...`);
            return await downloadNormal(url, outputPath, videoId);
        }

        // Luôn tải từ byte 0 — YouTube moov atom ở cuối file
        const startByte = 0;
        let endByte;

        if (effectiveEndTime === null) {
            // Shorts hoặc không giới hạn → tải toàn bộ file
            endByte = size;
            console.log(`[${videoId}] 📦 Full download: ${(size / 1024 / 1024).toFixed(1)}MB`);

        } else if (totalDuration && totalDuration > 0) {
            // Có totalDuration → tính % theo thời gian
            const safeEnd = effectiveEndTime + 30; // 30s buffer
            const ratio = Math.min(safeEnd / totalDuration, 1);
            endByte = Math.floor(ratio * size);

            // Đảm bảo tải ít nhất 20MB để có moov atom + đủ data
            endByte = Math.max(endByte, Math.min(20 * 1024 * 1024, size));

        } else {
            // Không có totalDuration → ước tính 2MB/s
            endByte = Math.min(
                Math.floor(2 * 1024 * 1024 * (effectiveEndTime + 30) * 1.8),
                size
            );
        }

        const bytesToDownload = endByte - startByte;
        console.log(`[${videoId}] 🎯 Range: 0 → ${(endByte / 1024 / 1024).toFixed(1)}MB (${(bytesToDownload / 1024 / 1024).toFixed(1)}MB / ${(size / 1024 / 1024).toFixed(1)}MB = ${((bytesToDownload / size) * 100).toFixed(0)}%)`);

        const numChunks = Math.ceil(bytesToDownload / CHUNK_SIZE);
        const chunks = Array.from({ length: numChunks }, (_, i) => ({
            start: i * CHUNK_SIZE,
            end: Math.min((i + 1) * CHUNK_SIZE - 1, bytesToDownload - 1),
            index: i
        }));

        console.log(`[${videoId}] 🚀 ${numChunks} chunks × ${MAX_PARALLEL} parallel...`);
        const chunkPaths = [];
        for (let i = 0; i < chunks.length; i += MAX_PARALLEL) {
            const batch = chunks.slice(i, i + MAX_PARALLEL);
            const results = await Promise.all(
                batch.map(c => downloadChunk(url, c.start, c.end, outputPath, c.index, numChunks))
            );
            chunkPaths.push(...results);
        }

        await mergeChunks(chunkPaths, outputPath);
        console.log(`[${videoId}] ✅ Downloaded ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
        return true;

    } catch (err) {
        console.error(`[${videoId}] ⚠️ Smart download failed: ${err.message}, fallback...`);
        try {
            const dir = path.dirname(outputPath);
            const base = path.basename(outputPath);
            fs.readdirSync(dir)
                .filter(f => f.startsWith(base) && f.includes('.part'))
                .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch { } });
        } catch { }
        return await downloadNormal(url, outputPath, videoId);
    }
}

module.exports = { smartDownload };