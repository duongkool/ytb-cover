const express = require("express");
const cors = require("cors");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const config = require("./config");
const { initWorkerSocket } = require("./sockets/workerSocket");
const { startVideoCleanupJob } = require("./utils/videoCleanup");

const app = express();

const VIDEO_DIR = path.join(__dirname, "public", "videos");
if (!fs.existsSync(VIDEO_DIR)) {
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

const allowedOrigins = [
  "http://localhost:3000",
  "https://n8n2.xopboo.com",
  "https://admin.xopboo.com",
  "https://image-collage-bice.vercel.app",
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true,
  }),
);

app.use(
  "/videos",
  express.static(VIDEO_DIR, {
    etag: true,
    lastModified: true,
    maxAge: "1d",
    setHeaders: (res, filePath) => {
      if (filePath.toLowerCase().endsWith(".mp4")) {
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
    },
  }),
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(express.static("public"));

app.use("/api/trim", require("./routes/trim"));
app.use("/api/cover", require("./routes/cover"));
app.use("/api/podcastHook", require("./routes/podcastHook"));
app.use("/api/simple-media-overlay", require("./routes/mediaOverlay"));

app.use("/api/overlay-image", require("./routes/overlayImage"));
app.use("/api/simpleTextImageVideo", require("./routes/simpleTextImageVideo"));
app.use("/api/upload-local", require("./routes/uploadLocal"));
const hookV2 = require("./routes/batchHookV5");
app.use("/api/cover-v2", hookV2);

app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    elevenLabsConfigured: config.ELEVENLABS_API_KEY !== "YOUR_API_KEY_HERE",
    voiceId: config.ELEVENLABS_VOICE_ID,
    uploadService: "local-vps",
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: true,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const { workers, jobs } = initWorkerSocket(io);
app.use("/api", require("./routes/bulk")({ workers, jobs }));

app.use((err, req, res, next) => {
  console.error("💥 Express error:", err.message);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      error: "Upload error",
      details: err.message,
    });
  }

  if (
    err.message === "Only video files are allowed" ||
    err.message === "Missing file"
  ) {
    return res.status(400).json({
      success: false,
      error: "Bad Request",
      details: err.message,
    });
  }

  return res.status(500).json({
    success: false,
    error: "Internal Server Error",
    details: err.message,
  });
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;

startVideoCleanupJob();

server.listen(config.PORT, () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   🎬 Video Trimmer                  ║");
  console.log(`║   🌐 http://localhost:${config.PORT}                  ║`);
  console.log("╚══════════════════════════════════════╝");
  console.log("\n🚀 Ready!\n");
});
