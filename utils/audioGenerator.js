const axios = require('axios');
const fs = require('fs');
const config = require('../config');

async function generateAudioFromText(text, outputPath, videoId) {
    console.log(`[${videoId}] 🎤 Generating TTS via ElevenLabs...`);

    if (!config.ELEVENLABS_API_KEY || config.ELEVENLABS_API_KEY === 'YOUR_API_KEY_HERE') {
        throw new Error('ElevenLabs API key not configured');
    }

    const res = await axios({
        method: 'post',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}`,
        headers: {
            'xi-api-key': config.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg'
        },
        data: {
            text,
            model_id: config.ELEVENLABS_MODEL,
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75
            }
        },
        responseType: 'arraybuffer',
        timeout: 30000
    });

    fs.writeFileSync(outputPath, res.data);
    console.log(`[${videoId}] ✅ TTS done: ${(res.data.byteLength / 1024).toFixed(0)} KB`);
}

module.exports = { generateAudioFromText };