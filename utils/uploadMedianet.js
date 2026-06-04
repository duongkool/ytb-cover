const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

// ── Config Filegarden ──────────────────────────────────
const FILEGARDEN_USER_ID = "6a20e42076921a283237661b";
const FILEGARDEN_AUTH_COOKIE =
  "auth=s%3ANmEyMGU0MjA3NjkyMWEyODMyMzc2NjFiOnFLTmVXbWZXNmJjYy9ONzE1Q2NpcmZabnMyRHRqZ0NLOWVJbzhzR0xOUHVZNm5rb2R3N1BNd2cwZkRHWm50RWFCaWV3aTFyOGJFSkhvQ3cxL0ZpdVdES3QwTGYxU1JJL2Z4cVc5N2c0NThkbFhieWxid01qRnVsVmU0SmVaU2g3MkhoZytBPT0%3D.R2sliyU%2Fy58G%2BqWZNdrIAX4fkY414P6eUkc9QT9iceM";
const FILEGARDEN_PARENT = "aiDkc3aSGigyN2Yv";

// ── Verify URL ─────────────────────────────────────────
async function verifyVideoUrl(url) {
  try {
    const response = await axios.head(url, { timeout: 10000 });
    const contentType = response.headers["content-type"] || "";
    const contentLength = parseInt(response.headers["content-length"] || "0");
    const isVideo =
      contentType.includes("video/") ||
      contentType.includes("application/octet-stream");
    const hasSize = contentLength > 10000;
    console.log(
      `🔍 Verify → type: ${contentType}, size: ${contentLength}B, valid: ${isVideo && hasSize}`,
    );
    return isVideo && hasSize;
  } catch (err) {
    console.warn(`⚠️ Verify failed: ${err.message}`);
    return false;
  }
}

// ── Upload to Filegarden ───────────────────────────────
async function uploadToFilegarden(filePath, filename) {
  const MAX_RETRIES = 5;
  const RETRY_DELAY = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`📤 [Filegarden ${attempt}/${MAX_RETRIES}] Uploading...`);

      const xData = JSON.stringify({
        parent: FILEGARDEN_PARENT,
        name: filename,
      });

      const fileStream = fs.createReadStream(filePath);
      const fileSize = fs.statSync(filePath).size;

      const response = await axios.post(
        `https://api.filegarden.com/users/${FILEGARDEN_USER_ID}/pipe`,
        fileStream,
        {
          headers: {
            Cookie: FILEGARDEN_AUTH_COOKIE,
            "Content-Type": "application/octet-stream",
            "X-Data": xData,
            "Content-Length": fileSize,
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 120000,
        },
      );

      const data = response.data;

      // ✅ Response là object trực tiếp (không phải { items: [] })
      // Có thể là single item hoặc { items: [...] } tùy API version
      const item = data?.items?.[0] ?? (data?.path ? data : null);

      if (!item?.path) {
        throw new Error(`Invalid response: ${JSON.stringify(data)}`);
      }

      const filegardenUrl = `https://file.garden/aiDkIHaSGigyN2Yb/${item.path}`;
      console.log(`✅ Filegarden: ${filegardenUrl}`);
      return {
        success: true,
        url: filegardenUrl,
        service: "filegarden",
        permanent: true,
      };
    } catch (error) {
      // ✅ 422 = file đã tồn tại → coi như thành công, build URL từ filename
      if (error.response?.status === 422) {
        const existingUrl = `https://file.garden/aiDkIHaSGigyN2Yb/medifile/${filename}`;
        console.warn(
          `⚠️ [Filegarden] File already exists → reuse: ${existingUrl}`,
        );
        return {
          success: true,
          url: existingUrl,
          service: "filegarden",
          permanent: true,
        };
      }

      if (error.response) {
        console.error(
          `❌ [Filegarden ${attempt}/${MAX_RETRIES}] HTTP ${error.response.status}`,
        );
        console.error(
          `❌ [Filegarden] Response body:`,
          JSON.stringify(error.response.data),
        );
      } else {
        console.error(
          `❌ [Filegarden ${attempt}/${MAX_RETRIES}] ${error.message}`,
        );
      }

      if (attempt < MAX_RETRIES) {
        console.log(`⏳ Waiting ${RETRY_DELAY / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      } else {
        const errMsg = error.response
          ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
          : error.message;
        throw new Error(
          `Filegarden failed after ${MAX_RETRIES} attempts: ${errMsg}`,
        );
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
      formData.append("files[]", fs.createReadStream(filePath), {
        filename,
        contentType: "video/mp4",
      });

      const uploadResponse = await axios.post(
        "https://uguu.se/upload.php",
        formData,
        {
          headers: formData.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 60000,
        },
      );

      if (!uploadResponse.data.success || !uploadResponse.data.files?.length) {
        throw new Error(
          `Invalid response: ${JSON.stringify(uploadResponse.data)}`,
        );
      }

      const videoUrl = uploadResponse.data.files[0].url.replace(/\\\//g, "/");
      if (!videoUrl.startsWith("https://")) {
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
        service: "uguu",
        permanent: false,
        note: "Expires after 48 hours",
      };
    } catch (error) {
      if (error.notPlayable) {
        console.warn(`⚠️ Uguu URL không playable`);
        throw error;
      }
      console.error(`❌ [Uguu ${attempt}/${MAX_RETRIES}] ${error.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      } else {
        throw new Error(
          `Uguu failed after ${MAX_RETRIES} attempts: ${error.message}`,
        );
      }
    }
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
      formData.append("reqtype", "fileupload");
      formData.append("fileToUpload", fs.createReadStream(filePath), {
        filename,
        contentType: "video/mp4",
      });

      const uploadResponse = await axios.post(
        "https://catbox.moe/user/api.php",
        formData,
        {
          headers: formData.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 60000,
        },
      );

      const videoUrl = uploadResponse.data.trim();
      if (!videoUrl.startsWith("https://")) {
        throw new Error(`Invalid response: ${videoUrl}`);
      }

      const isValid = await verifyVideoUrl(videoUrl);
      if (!isValid) {
        const err = new Error(`URL_NOT_PLAYABLE: ${videoUrl}`);
        err.notPlayable = true;
        throw err;
      }

      console.log(`✅ Catbox verified: ${videoUrl}`);
      return {
        success: true,
        url: videoUrl,
        service: "catbox",
        permanent: true,
      };
    } catch (error) {
      if (error.notPlayable) {
        console.warn(`⚠️ Catbox URL không playable → skip`);
        throw error;
      }
      console.error(`❌ [Catbox ${attempt}/${MAX_RETRIES}] ${error.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      } else {
        throw new Error(
          `Catbox failed after ${MAX_RETRIES} attempts: ${error.message}`,
        );
      }
    }
  }
}

// ── Main: Filegarden(5) → Uguu(3) → Catbox(3) ──────────
async function uploadVideo(filePath, filename) {
  // PRIMARY: Filegarden — 5 lần retry
  try {
    return await uploadToFilegarden(filePath, filename);
  } catch (fgError) {
    console.error(`❌ Filegarden failed: ${fgError.message}`);
    console.log("🔄 Switching to Uguu...");
  }

  // SECONDARY: Uguu — 3 lần retry
  try {
    return await uploadToUguu(filePath, filename);
  } catch (uguuError) {
    console.error(`❌ Uguu failed: ${uguuError.message}`);
    console.log("🔄 Switching to Catbox...");
  }

  // FALLBACK: Catbox — 3 lần retry
  try {
    return await uploadToCatbox(filePath, filename);
  } catch (catboxError) {
    throw new Error(`All upload services failed | ${catboxError.message}`);
  }
}

module.exports = {
  uploadToFilegarden,
  uploadToUguu,
  uploadToCatbox,
  uploadVideo,
};
