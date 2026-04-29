const axios = require('axios');
const fs = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const config = require('../config');

const execAsync = promisify(exec);

const VIMIX_API_KEY = config.VIMIX_API_KEY;
const VIMIX_BASE_URL = 'https://vimix.io/api/v1';

const PRIMARY_VOICE_MAP = {
    en: 'pqHfZKP75CvOlQylNhV4', // giữ nguyên voice en hiện tại
    pt: 'OjcGK1RXdMD1PFj2eIuN',
    de: '3nMIMZ7RlGwsq1WLgxY3',
    jp: 'AxBatOypCFE61I1grPYo',
};

const FALLBACK_VOICE_MAP = {
    en: [
        'pqHfZKP75CvOlQylNhV4', // giữ nguyên làm voice chuẩn cho en
    ],
    pt: [
        'OjcGK1RXdMD1PFj2eIuN',
        'XrExE9yKIg1WjnnlVkGX', // informative_educational
        'pFZP5JQG7iQjIQuC4Bku',
        'JBFqnCBsd6RMkjVDRZzb', // narrative_story, thường hợp nội dung dài
        'CwhRBWXzGAHq8TQ4Fs17', // conversational
        'pqHfZKP75CvOlQylNhV4', // fallback cuối về voice en bạn đang thích
    ],
    de: [
        '3nMIMZ7RlGwsq1WLgxY3',
        'JBFqnCBsd6RMkjVDRZzb',
        'XrExE9yKIg1WjnnlVkGX',
        'CwhRBWXzGAHq8TQ4Fs17',
        'pqHfZKP75CvOlQylNhV4',
    ],
    jp: [
        'AxBatOypCFE61I1grPYo',
        'JBFqnCBsd6RMkjVDRZzb',
        'XrExE9yKIg1WjnnlVkGX',
        'cgSgspJ2msm6clMCkdW9',
        'pqHfZKP75CvOlQylNhV4',
    ],
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getApiError(error) {
    return error?.response?.data?.error || null;
}

function getErrorCode(error) {
    return getApiError(error)?.code || null;
}

function getErrorMessage(error) {
    return getApiError(error)?.message || error.message || 'Unknown error';
}

function isVoiceRetryableError(error) {
    const code = getErrorCode(error);
    const msg = getErrorMessage(error).toLowerCase();

    return (
        code === 'voice_disabled' ||
        code === 'invalid_shared_voice' ||
        msg.includes('voice not available') ||
        msg.includes('voice này đang tạm ngừng hoạt động') ||
        msg.includes('vui lòng chọn voice khác')
    );
}

function getVoiceCandidates(language) {
    const candidates = FALLBACK_VOICE_MAP[language] || FALLBACK_VOICE_MAP.en;
    return [...new Set(candidates)];
}

function buildTtsPayload({ text, voice, provider, model }) {
    return {
        text,
        voice,
        provider,
        model,
        speed: 0.9,
        withSrt: true,
        title: `Audio-${Date.now()}`
    };
}

async function createTtsJob(payload) {
    const response = await axios.post(
        `${VIMIX_BASE_URL}/tts`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${VIMIX_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        }
    );

    return response.data;
}

async function pollTtsResult(taskId, sessionId, maxAttempts = 20, intervalMs = 3000) {
    let attempts = 0;

    while (attempts < maxAttempts) {
        await sleep(intervalMs);

        const statusResponse = await axios.get(
            `${VIMIX_BASE_URL}/tts/${taskId}`,
            {
                headers: {
                    Authorization: `Bearer ${VIMIX_API_KEY}`
                },
                timeout: 10000
            }
        );

        const data = statusResponse.data;

        if (data.status === 'COMPLETED') {
            return data;
        }

        if (data.status === 'FAILED') {
            throw new Error(`Vimix job failed: ${data.error?.message || 'Unknown error'}`);
        }

        attempts++;
        console.log(`[${sessionId}] ⏳ Poll ${attempts}/${maxAttempts}, status: ${data.status}`);
    }

    throw new Error('Vimix timeout sau 60s');
}

async function downloadAudio(audioUrl, outputPath) {
    const audioResponse = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
    });

    fs.writeFileSync(outputPath, audioResponse.data);
}

async function tryGenerateWithVoice(text, outputPath, sessionId, { voice, provider, model }) {
    console.log(`[${sessionId}] 🎤 VIMIX: provider=${provider}, voice=${voice}`);

    const createData = await createTtsJob(
        buildTtsPayload({ text, voice, provider, model })
    );

    const { taskId } = createData;
    console.log(`[${sessionId}] 📋 Task created: ${taskId}`);

    const resultData = await pollTtsResult(taskId, sessionId);

    await downloadAudio(resultData.result.audioUrl, outputPath);

    const fileSize = fs.statSync(outputPath).size;
    console.log(
        `[${sessionId}] ✅ VIMIX Audio: ${(fileSize / 1024).toFixed(2)}KB, ${resultData.result.duration}s, credits: ${resultData.result.creditsUsed}, voice: ${voice}`
    );

    return {
        success: true,
        usedVoice: voice,
        srtUrl: resultData.result.srtUrl || null,
        duration: resultData.result.duration,
        creditsUsed: resultData.result.creditsUsed
    };
}

async function generateAudioFromText(text, outputPath, sessionId, options = {}) {
    const {
        language = 'en',
        provider = 'ELEVENLABS',
        model = 'eleven_multilingual_v2'
    } = options;

    if (!VIMIX_API_KEY) {
        throw new Error('Missing VIMIX_API_KEY');
    }

    if (language === 'en') {
        return tryGenerateWithVoice(text, outputPath, sessionId, {
            voice: PRIMARY_VOICE_MAP.en,
            provider,
            model
        });
    }

    const voiceCandidates = getVoiceCandidates(language);

    let lastError = null;

    for (let i = 0; i < voiceCandidates.length; i++) {
        const voice = voiceCandidates[i];

        try {
            console.log(
                `[${sessionId}] 🎤 TTS voice attempt ${i + 1}/${voiceCandidates.length} | lang=${language} | voice=${voice}`
            );

            return await tryGenerateWithVoice(text, outputPath, sessionId, {
                voice,
                provider,
                model
            });
        } catch (error) {
            lastError = error;
            console.error(
                `[${sessionId}] ❌ Voice failed (${voice}):`,
                error.response?.data || error.message
            );

            if (!isVoiceRetryableError(error)) {
                if (error.response?.status === 401) {
                    throw new Error('Invalid VIMIX API key');
                } else if (error.response?.status === 402) {
                    throw new Error('Insufficient credits');
                } else if (error.response?.status === 429) {
                    throw new Error('Rate limit exceeded');
                } else {
                    throw new Error(`VIMIX generation failed: ${getErrorMessage(error)}`);
                }
            }

            console.warn(
                `[${sessionId}] 🔁 Voice disabled/unavailable, switching to next fallback voice...`
            );
        }
    }

    throw new Error(`All fallback voices failed: ${getErrorMessage(lastError)}`);
}

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