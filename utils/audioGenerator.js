const axios = require('axios');
const fs = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const config = require('../config');

const execAsync = promisify(exec);

const VIMIX_API_KEY = "vmx_live_tiY4uzJay05a5DuiKaBD";  // Thay API key Vimix của bạn
const VIMIX_BASE_URL = "https://vimix.io/api/v1";

/**
 * Generate audio từ text sử dụng VIMIX TTS API
 * @param {string} text - Text to convert
 * @param {string} outputPath - Output audio path
 * @param {string} sessionId - Session ID for logging
 * @param {Object} options - { voice, model, provider }
 * @returns {Promise<boolean>}
 */

const VOICE_MAP = {
    en: "pqHfZKP75CvOlQylNhV4",   // Bella - English
    pt: "OjcGK1RXdMD1PFj2eIuN",   // Larissa - Portuguese (thay bằng voice ID pt của bạn)
    de: "3nMIMZ7RlGwsq1WLgxY3",   // Arthur- German
    jp: "AxBatOypCFE61I1grPYo",   // Tonkitch - Japanese (thay bằng voice ID jp của bạn)
};

async function generateAudioFromText(text, outputPath, sessionId, options = {}) {

    const {
        language = "en",
        provider = "ELEVENLABS",
        model = "eleven_multilingual_v2"
    } = options;


    const voice = VOICE_MAP[language] || VOICE_MAP["en"];
    console.log(`[${sessionId}] 🎤 VIMIX: lang=${language}, voice=${voice}`);
    try {
        // 1. Tạo TTS job
        const createResponse = await axios.post(
            `${VIMIX_BASE_URL}/tts`,
            {
                text,
                speed: 0.9,
                voice,
                provider,
                model,
                withSrt: true,
                title: `Audio-${Date.now()}`
            },
            {
                headers: {
                    'Authorization': `Bearer ${VIMIX_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        const { taskId } = createResponse.data;
        console.log(`[${sessionId}] 📋 Task created: ${taskId}`);

        // 2. Poll status (max 60s)
        let attempts = 0;
        const maxAttempts = 20;

        while (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 3000));  // Wait 3s

            const statusResponse = await axios.get(
                `${VIMIX_BASE_URL}/tts/${taskId}`,
                {
                    headers: { 'Authorization': `Bearer ${VIMIX_API_KEY}` },
                    timeout: 10000
                }
            );

            const data = statusResponse.data;

            if (data.status === "COMPLETED") {
                // 3. Download audio
                const audioResponse = await axios.get(data.result.audioUrl, {
                    responseType: 'arraybuffer',
                    timeout: 30000
                });

                fs.writeFileSync(outputPath, audioResponse.data);

                const fileSize = fs.statSync(outputPath).size;
                console.log(`[${sessionId}] ✅ VIMIX Audio: ${fileSize / 1024}KB, ${data.result.duration}s, credits: ${data.result.creditsUsed}`);

                return {
                    success: true,
                    srtUrl: data.result.srtUrl || null,
                    duration: data.result.duration,
                    creditsUsed: data.result.creditsUsed
                };
            }

            if (data.status === "FAILED") {
                throw new Error(`Vimix job failed: ${data.error?.message || 'Unknown error'}`);
            }

            attempts++;
            console.log(`[${sessionId}] ⏳ Poll ${attempts}/${maxAttempts}, status: ${data.status}`);
        }

        throw new Error('Vimix timeout sau 60s');

    } catch (error) {
        console.error(`[${sessionId}] ❌ VIMIX Error:`, error.response?.data || error.message);

        if (error.response?.status === 401) {
            throw new Error('Invalid VIMIX API key');
        } else if (error.response?.status === 402) {
            throw new Error('Insufficient credits');
        } else if (error.response?.status === 429) {
            throw new Error('Rate limit exceeded');
        } else {
            throw new Error(`VIMIX generation failed: ${error.message}`);
        }
    }
}

/**
 * Get audio duration in seconds
 */
async function getAudioDuration(audioPath, sessionId) {
    console.log(`[${sessionId}] ⏱️ Getting duration...`);

    try {
        const { stdout: duration } = await execAsync(
            `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
        );
        return parseFloat(duration.trim());
    } catch (error) {
        throw new Error(`Duration failed: ${error.message}`);
    }
}

module.exports = {
    generateAudioFromText,
    getAudioDuration
};
