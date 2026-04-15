require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 3000,

    // Captick API
    CAPTICK_API_URL: 'https://api.captick.com/video_info',
    // ElevenLabs TTS
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || 'YOUR_API_KEY_HERE',
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    ELEVENLABS_MODEL: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',

    // Upload service: 'gofile' | 'catbox' | 'tmpfiles'
    UPLOAD_SERVICE: process.env.UPLOAD_SERVICE || 'gofile',
};