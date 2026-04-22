const express = require('express');
const cors = require('cors');
const http = require('http');
const config = require('./config');

const app = express();

const allowedOrigins = [
    'http://localhost:3000',
    'https://n8n2.xopboo.com',
    'https://admin.xopboo.com',
    "https://image-collage-bice.vercel.app"
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`CORS blocked: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

app.use('/api/trim', require('./routes/trim'));
app.use('/api/cover', require('./routes/cover'));

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        elevenLabsConfigured: config.ELEVENLABS_API_KEY !== 'YOUR_API_KEY_HERE',
        voiceId: config.ELEVENLABS_VOICE_ID,
        uploadService: config.UPLOAD_SERVICE,
    });
});

app.use((err, req, res, next) => {
    console.error('💥 Express error:', err.message);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        details: err.message
    });
});

const server = http.createServer(app);

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;

server.listen(config.PORT, () => {
    console.log('╔══════════════════════════════════════╗');
    console.log('║   🎬 Video Trimmer                   ║');
    console.log(`║   🌐 http://localhost:${config.PORT}                   ║`);
    console.log('║   ✂️  POST /api/trim                 ║');
    console.log('║   📡 GET  /api/trim/:jobId          ║');
    console.log('║   ❤️  GET  /api/health              ║');
    console.log(`║   🔑 ElevenLabs: ${config.ELEVENLABS_API_KEY !== 'YOUR_API_KEY_HERE' ? '✅ Configured' : '❌ Not set'} ║`);
    console.log(`║   📤 Upload: ${config.UPLOAD_SERVICE}                  ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('\n🚀 Ready!\n');
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught:', err.message);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled:', reason);
    process.exit(1);
});