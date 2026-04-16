const express = require('express');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const axios = require('axios');
const config = require('../config');
const { downloadYoutubeVideo, downloadDirectVideo, detectVideoUrlType } = require('../utils/videoDownloader');
const { generateAudioFromText } = require('../utils/audioGenerator');
const { uploadVideo } = require('../utils/uploadService');

const execAsync = promisify(exec);
const router = express.Router();

// ✅ Tạo thư mục temp/{videoId}
function createTempDir(videoId) {
    const tempDir = path.join(__dirname, '..', 'temp', String(videoId));
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
}

// ✅ Xóa toàn bộ thư mục temp/{videoId}
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

async function processVideo(youtubeUrl, startTime, endTime, audioMode, hookText, videoId = Date.now()) {
    // Validation
    if (!youtubeUrl || startTime === undefined || endTime === undefined)
        throw new Error('Missing required params: youtubeUrl, startTime, endTime');
    if (endTime <= startTime)
        throw new Error('endTime must be greater than startTime');
    if (startTime < 0)
        throw new Error('startTime không được âm');
    if (endTime - startTime > 300)
        throw new Error('Đoạn trim tối đa 300s');
    if (!['original', 'hook'].includes(audioMode))
        throw new Error('audioMode must be "original" or "hook"');
    if (audioMode === 'hook' && (!hookText || !hookText.trim()))
        throw new Error('hookText is required when audioMode is "hook"');

    // ✅ Tất cả temp files nằm trong temp/{videoId}/
    const tempDir = createTempDir(videoId);
    const inputPath = path.join(tempDir, 'input.mp4');
    const trimmedPath = path.join(tempDir, 'trimmed.mp4');
    const thumbnailPath = path.join(tempDir, 'thumb.jpg');
    const hookAudioPath = path.join(tempDir, 'hook.mp3');
    const withAudioPath = path.join(tempDir, 'withaudio.mp4');
    const stackedPath = path.join(tempDir, 'stacked.mp4');
    const outputPath = path.join(tempDir, 'output.mp4');
    const processStart = Date.now();

    try {
        // STEP 1: Download
        const urlType = detectVideoUrlType(youtubeUrl);
        let videoMetadata = {};

        console.log(`[${videoId}] 🔍 URL type: ${urlType}`);
        if (urlType === 'youtube') {
            videoMetadata = await downloadYoutubeVideo(youtubeUrl, inputPath, videoId, startTime, endTime);
        } else if (urlType === 'direct') {
            await downloadDirectVideo(youtubeUrl, inputPath, videoId, 0, endTime, null);
        } else {
            throw new Error('Unsupported URL. Use YouTube or direct video URL.');
        }
        if (!fs.existsSync(inputPath)) throw new Error('Video download failed');
        const inputSize = fs.statSync(inputPath).size;
        console.log(`[${videoId}] ✅ Downloaded: ${(inputSize / 1024 / 1024).toFixed(2)} MB`);

        // STEP 2: Thumbnail
        if (urlType === 'youtube' && videoMetadata.thumbnail) {
            console.log(`[${videoId}] 📸 Downloading thumbnail...`);
            const res = await axios.get(videoMetadata.thumbnail, { responseType: 'arraybuffer', timeout: 15000 });
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

        // STEP 3: Trim
        const duration = endTime - startTime;
        console.log(`[${videoId}] ✂️ Trimming ${startTime}s → ${endTime}s (${duration}s)...`);
        await execAsync(
            `ffmpeg -ss ${startTime} -i "${inputPath}" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${trimmedPath}"`,
            { maxBuffer: 50 * 1024 * 1024 }
        );
        if (!fs.existsSync(trimmedPath)) throw new Error('Trim failed');
        console.log(`[${videoId}] ✅ Trimmed`);

        // STEP 4: Get dimensions
        const { stdout: dim } = await execAsync(
            `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${trimmedPath}"`
        );
        const [videoWidth] = dim.trim().split('x').map(Number);
        console.log(`[${videoId}] 📐 Dimensions: ${dim.trim()}`);

        // STEP 5: Handle audio
        let mainVideo = trimmedPath;
        if (audioMode === 'hook') {
            console.log(`[${videoId}] 🎤 Hook mode: generating TTS...`);
            await generateAudioFromText(hookText, hookAudioPath, videoId);
            if (!fs.existsSync(hookAudioPath)) throw new Error('TTS generation failed');
            await execAsync(
                `ffmpeg -i "${trimmedPath}" -i "${hookAudioPath}" -filter_complex "[1:a]apad[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 128k -shortest -y "${withAudioPath}"`,
                { maxBuffer: 50 * 1024 * 1024 }
            );
            mainVideo = withAudioPath;
            console.log(`[${videoId}] ✅ Audio replaced`);
        }

        // STEP 6: Stack video + thumbnail
        console.log(`[${videoId}] 🎨 Stacking video + thumbnail...`);
        await execAsync(
            `ffmpeg -i "${mainVideo}" -i "${thumbnailPath}" ` +
            `-filter_complex ` +
            `"[0:v]pad=iw:ih+5:0:0:white[video_padded];` +
            `[1:v]scale=${videoWidth}:-2[thumb_scaled];` +
            `[video_padded][thumb_scaled]vstack=inputs=2[v]" ` +
            `-map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -y "${stackedPath}"`,
            { maxBuffer: 50 * 1024 * 1024 }
        );
        if (!fs.existsSync(stackedPath)) throw new Error('Stack failed');
        console.log(`[${videoId}] ✅ Stacked`);

        // STEP 7: Normalize
        console.log(`[${videoId}] 🔄 Normalizing...`);
        await execAsync(
            `ffmpeg -i "${stackedPath}" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -r 30 -g 60 -keyint_min 60 -c:a aac -b:a 128k -ar 44100 -ac 2 -y "${outputPath}"`,
            { maxBuffer: 50 * 1024 * 1024 }
        );
        if (!fs.existsSync(outputPath)) throw new Error('Normalize failed');

        const { stdout: durOut } = await execAsync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${outputPath}"`
        );
        const finalDuration = parseFloat(durOut.trim());
        const outputSize = fs.statSync(outputPath).size;
        console.log(`[${videoId}] ✅ Output: ${(outputSize / 1024 / 1024).toFixed(2)} MB, ${finalDuration.toFixed(2)}s`);

        // STEP 8: Upload
        console.log(`[${videoId}] 📤 Uploading to ${config.UPLOAD_SERVICE}...`);
        const uploadStart = Date.now();
        const uploadResult = await uploadVideo(outputPath, `trimmed_${audioMode}_${videoId}.mp4`);
        if (!uploadResult.success) throw new Error('Upload failed');
        const uploadTime = ((Date.now() - uploadStart) / 1000).toFixed(1);
        console.log(`[${videoId}] ✅ Uploaded in ${uploadTime}s: ${uploadResult.url}`);

        // STEP 9: ✅ Cleanup toàn bộ folder
        cleanupTempDir(tempDir);

        const totalTime = ((Date.now() - processStart) / 1000).toFixed(1);
        console.log(`[${videoId}] 🎉 Done in ${totalTime}s`);

        return {
            success: true,
            videoUrl: uploadResult.url,
            uploadService: uploadResult.service,
            permanent: uploadResult.permanent || false,
            expiresIn: uploadResult.expiresIn || null,
            metadata: {
                duration,
                startTime,
                endTime,
                finalDuration,
                audioMode,
                hookText: audioMode === 'hook' ? hookText : null,
                originalSize: inputSize,
                finalSize: outputSize,
                processingTime: parseFloat(totalTime),
                uploadTime: parseFloat(uploadTime),
                sourceType: urlType,
            },
            message: `✅ Trimmed ${duration}s → final ${finalDuration.toFixed(1)}s`
        };

    } catch (error) {
        // ✅ Lỗi cũng xóa sạch folder
        cleanupTempDir(tempDir);
        throw error;
    }
}

// POST /api/trim
router.post('/', async (req, res) => {
    const { youtubeUrl, startTime, endTime, audioMode = 'original', hookText = '' } = req.body;
    try {
        const result = await processVideo(youtubeUrl, startTime, endTime, audioMode, hookText);
        res.json(result);
    } catch (error) {
        console.error(`❌ Trim error:`, error.message);
        res.status(500).json({
            success: false,
            error: 'Processing failed',
            details: error.message
        });
    }
});

module.exports = router;
module.exports.processVideo = processVideo;