require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 3000,

    // Captick API
    CAPTICK_API_URL: 'https://api.captick.com/video_info',
    // ElevenLabs TTS
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || 'YOUR_API_KEY_HERE',
    ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
    ELEVENLABS_MODEL: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
    RAPIDAPI_KEY: 'f6fe2e6663msh497decc6d77837dp12c1a8jsn3417c2dd3abb',
    // Upload service: 'gofile' | 'catbox' | 'tmpfiles'
    UPLOAD_SERVICE: process.env.UPLOAD_SERVICE || 'gofile',
};