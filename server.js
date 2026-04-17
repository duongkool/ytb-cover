const express = require('express');
const cors = require('cors');
const config = require('./config');

const app = express();

// ─── CORS ─────────────────────────────────────────────
const allowedOrigins = [
    'http://localhost:3000',
    'https://n8n2.xopboo.com',
    'https://admin.xopboo.com',
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true); // cho phép curl, Postman
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
}));

// ─── Middleware ────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// ─── Routes ───────────────────────────────────────────
app.use('/api/trim', require('./routes/trim'));

// ─── Health check ─────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        elevenLabsConfigured: config.ELEVENLABS_API_KEY !== 'YOUR_API_KEY_HERE',
        voiceId: config.ELEVENLABS_VOICE_ID,
        uploadService: config.UPLOAD_SERVICE,
    });
});

// ─── Start ────────────────────────────────────────────
app.listen(config.PORT, () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   🎬 Video Trimmer                   ║');
    console.log(`║   🌐 http://localhost:${config.PORT}           ║`);
    console.log('║   ✂️  POST /api/trim                  ║');
    console.log('║   ❤️  GET  /api/health                ║');
    console.log(`║   🔑 ElevenLabs: ${config.ELEVENLABS_API_KEY !== 'YOUR_API_KEY_HERE' ? '✅ Configured' : '❌ Not set   '} ║`);
    console.log(`║   📤 Upload: ${config.UPLOAD_SERVICE}                    ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('\n🚀 Ready!\n');
});

// ─── Graceful Shutdown ────────────────────────────────
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught:', err.message);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled:', reason);
});