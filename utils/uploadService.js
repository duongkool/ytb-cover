const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

// ── Verify URL có thực sự là video playable không ──────
async function verifyVideoUrl(url) {
    try {
        const response = await axios.head(url, { timeout: 10000 });
        const contentType = response.headers['content-type'] || '';
        const contentLength = parseInt(response.headers['content-length'] || '0');
        const isVideo = contentType.includes('video/') || contentType.includes('application/octet-stream');
        const hasSize = contentLength > 10000;
        console.log(`🔍 Verify → type: ${contentType}, size: ${contentLength}B, valid: ${isVideo && hasSize}`);
        return isVideo && hasSize;
    } catch (err) {
        console.warn(`⚠️ Verify failed: ${err.message}`);
        return false;
    }
}

// ── Upload to Catbox.moe ────────────────────────────────
async function uploadToCatbox(filePath, filename) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`📤 [Catbox ${attempt}/${MAX_RETRIES}] Uploading...`);

            const formData = new FormData();
            formData.append('reqtype', 'fileupload');
            formData.append('fileToUpload', fs.createReadStream(filePath), {
                filename, contentType: 'video/mp4'
            });

            const uploadResponse = await axios.post(
                'https://catbox.moe/user/api.php',
                formData,
                {
                    headers: formData.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 60000
                }
            );

            const videoUrl = uploadResponse.data.trim();
            if (!videoUrl.startsWith('https://')) {
                throw new Error(`Invalid response: ${videoUrl}`);
            }

            // ✅ Verify ngay — nếu không play được thì THROW NGAY, không retry
            const isValid = await verifyVideoUrl(videoUrl);
            if (!isValid) {
                const err = new Error(`URL_NOT_PLAYABLE: ${videoUrl}`);
                err.notPlayable = true; // ← flag để phân biệt với lỗi mạng
                throw err;
            }

            console.log(`✅ Catbox verified: ${videoUrl}`);
            return { success: true, url: videoUrl, service: 'catbox', permanent: true };

        } catch (error) {
            // ❌ Nếu URL trả về nhưng không play được → không retry, thoát luôn
            if (error.notPlayable) {
                console.warn(`⚠️ Catbox server lỗi (URL không playable) → skip sang Uguu`);
                throw error;
            }

            console.error(`❌ [Catbox ${attempt}/${MAX_RETRIES}] ${error.message}`);

            if (attempt < MAX_RETRIES) {
                console.log(`⏳ Waiting ${RETRY_DELAY / 1000}s before retry...`);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            } else {
                throw new Error(`Catbox failed after ${MAX_RETRIES} attempts: ${error.message}`);
            }
        }
    }
}

// ── Upload to Uguu.se ───────────────────────────────────
async function uploadToUguu(filePath, filename) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`📤 [Uguu ${attempt}/${MAX_RETRIES}] Uploading...`);

            const formData = new FormData();
            formData.append('files[]', fs.createReadStream(filePath), {
                filename, contentType: 'video/mp4'
            });

            const uploadResponse = await axios.post(
                'https://uguu.se/upload.php',
                formData,
                {
                    headers: formData.getHeaders(),
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                    timeout: 60000
                }
            );

            if (!uploadResponse.data.success || !uploadResponse.data.files?.length) {
                throw new Error(`Invalid response: ${JSON.stringify(uploadResponse.data)}`);
            }

            const videoUrl = uploadResponse.data.files[0].url.replace(/\\\//g, '/');
            if (!videoUrl.startsWith('https://')) {
                throw new Error(`Invalid URL: ${videoUrl}`);
            }

            const isValid = await verifyVideoUrl(videoUrl);
            if (!isValid) {
                const err = new Error(`URL_NOT_PLAYABLE: ${videoUrl}`);
                err.notPlayable = true;
                throw err;
            }

            console.log(`✅ Uguu verified: ${videoUrl}`);
            return {
                success: true,
                url: videoUrl,
                service: 'uguu',
                permanent: false,
                note: 'Expires after 48 hours'
            };

        } catch (error) {
            if (error.notPlayable) {
                console.warn(`⚠️ Uguu URL không playable`);
                throw error;
            }

            console.error(`❌ [Uguu ${attempt}/${MAX_RETRIES}] ${error.message}`);

            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            } else {
                throw new Error(`Uguu failed after ${MAX_RETRIES} attempts: ${error.message}`);
            }
        }
    }
}

// ── Main: Catbox → Uguu fallback ────────────────────────
async function uploadVideo(filePath, filename) {
    // PRIMARY: Uguu.se
    try {
        return await uploadToUguu(filePath, filename);
    } catch (uguuError) {
        console.error(`❌ Uguu failed: ${uguuError.message}`);
        console.log('🔄 Switching to Catbox.moe...');
    }

    // FALLBACK: Catbox
    try {
        return await uploadToCatbox(filePath, filename);
    } catch (catboxError) {
        throw new Error(`All upload services failed | Catbox: ${catboxError.message}`);
    }
}

module.exports = { uploadToCatbox, uploadToUguu, uploadVideo };