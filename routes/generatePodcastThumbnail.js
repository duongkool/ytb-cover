const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getBrowser } = require('../utils/browserPool');

const router = express.Router();

function escapeHtml(str = '') {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function normalizeTitle(text = '') {
    return String(text)
        .replace(/\s+/g, ' ')
        .replace(/\.{3,}/g, '…')
        .trim();
}

function trimWordsToFit(words, maxChars) {
    let out = [];
    let len = 0;

    for (const word of words) {
        const nextLen = len === 0 ? word.length : len + 1 + word.length;
        if (nextLen <= maxChars) {
            out.push(word);
            len = nextLen;
        } else {
            break;
        }
    }

    return out;
}

function buildTwoLineHeadline(rawTitle = '') {
    const title = normalizeTitle(rawTitle);
    const words = title.split(' ').filter(Boolean);

    const MAX1 = 24;
    const MAX2 = 30;

    if (!words.length) {
        return {
            line1: '',
            line2: '',
            truncated: false,
        };
    }

    let line1Words = trimWordsToFit(words, MAX1);
    if (!line1Words.length) line1Words = [words[0]];

    let remaining = words.slice(line1Words.length);

    let line2Words = trimWordsToFit(remaining, MAX2);
    let usedAll = line1Words.length + line2Words.length >= words.length;

    if (!line2Words.length && remaining.length) {
        line2Words = [remaining[0]];
        usedAll = line1Words.length + line2Words.length >= words.length;
    }

    let line1 = line1Words.join(' ');
    let line2 = line2Words.join(' ');

    if (!usedAll) {
        while (line2Words.length) {
            const candidate = `${line2Words.join(' ')}...`;
            if (candidate.length <= MAX2 + 3) {
                line2 = candidate;
                break;
            }
            line2Words.pop();
        }

        if (!line2Words.length) {
            line2 = '...';
        }
    }

    if (line1Words.length === 1 && remaining.length > 2) {
        const rebalanceWords = words.slice(0);
        const first = [];
        const second = [];

        for (const word of rebalanceWords) {
            const tryFirst = [...first, word].join(' ');
            if (tryFirst.length <= 20) {
                first.push(word);
            } else {
                second.push(word);
            }
        }

        if (first.length && second.length) {
            line1 = first.join(' ');
            let secondWords = trimWordsToFit(second, MAX2);
            const usedAll2 = first.length + secondWords.length >= words.length;

            if (!usedAll2) {
                while (secondWords.length) {
                    const candidate = `${secondWords.join(' ')}...`;
                    if (candidate.length <= MAX2 + 3) {
                        line2 = candidate;
                        break;
                    }
                    secondWords.pop();
                }
                if (!secondWords.length) line2 = '...';
            } else {
                line2 = secondWords.join(' ');
            }
        }
    }

    return {
        line1,
        line2,
        truncated: !usedAll,
    };
}

async function toDataUrl(imageInput) {
    if (!imageInput) throw new Error('image is required');

    if (imageInput.startsWith('data:image/')) {
        return imageInput;
    }

    if (imageInput.startsWith('http://') || imageInput.startsWith('https://')) {
        const res = await axios.get(imageInput, {
            responseType: 'arraybuffer',
            timeout: 20000,
        });
        const contentType = res.headers['content-type'] || 'image/jpeg';
        return `data:${contentType};base64,${Buffer.from(res.data).toString('base64')}`;
    }

    if (imageInput.startsWith('file://')) {
        const localPath = imageInput.replace('file://', '');
        const normalizedPath =
            process.platform === 'win32' && localPath.startsWith('/')
                ? localPath.slice(1)
                : localPath;

        const buffer = fs.readFileSync(normalizedPath);
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }

    if (fs.existsSync(imageInput)) {
        const buffer = fs.readFileSync(imageInput);
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
    }

    throw new Error('Unsupported image source');
}

router.post('/', async (req, res) => {
    let page = null;

    try {
        const {
            image,
            title,
            badgeTop = 'STORY',
            badgeBottom = '',
            episode = 'EP.1',
            footerBrand = ''
        } = req.body || {};

        if (!image || typeof image !== 'string') {
            return res.status(400).json({ success: false, error: 'image required' });
        }

        if (!title || typeof title !== 'string') {
            return res.status(400).json({ success: false, error: 'title required' });
        }

        const imageDataUrl = await toDataUrl(image);
        const headline = buildTwoLineHeadline(title);

        const safeBadgeTop = escapeHtml(badgeTop);
        const safeBadgeBottom = escapeHtml(badgeBottom);
        const safeEpisode = escapeHtml(episode);
        const safeFooterBrand = escapeHtml(footerBrand);

        const titleHtml = `
      ${headline.line1 ? `<div class="title-line white-line">${escapeHtml(headline.line1)}</div>` : ''}
      ${headline.line2 ? `<div class="title-line yellow-line">${escapeHtml(headline.line2)}</div>` : ''}
    `;

        const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=720, initial-scale=1.0" />
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{
  width:720px;
  height:1280px;
  overflow:hidden;
  background:#040404;
  font-family: Arial, Helvetica, sans-serif;
}
.canvas{
  position:relative;
  width:720px;
  height:1280px;
  overflow:hidden;
  background:#040404;
}
.bg{
  position:absolute;
  inset:0;
  background-image:url('${imageDataUrl}');
  background-size:cover;
  background-position:center;
  filter:blur(20px) brightness(.42) saturate(1.05);
  transform:scale(1.12);
}
.overlay{
  position:absolute;
  inset:0;
  background:
    radial-gradient(circle at center, rgba(255,255,255,.025) 0%, rgba(0,0,0,0) 42%, rgba(0,0,0,.12) 76%, rgba(0,0,0,.24) 100%),
    linear-gradient(to bottom, rgba(0,0,0,.08) 0%, rgba(0,0,0,.03) 22%, rgba(0,0,0,.02) 48%, rgba(0,0,0,.18) 74%, rgba(0,0,0,.34) 100%);
}
.frame{
  position:absolute;
  inset:18px;
  border-radius:26px;
  border:2px solid rgba(255,255,255,.08);
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.025),
    0 0 0 1px rgba(255,255,255,.015);
  z-index:2;
}
.left-line{
  position:absolute;
  left:34px;
  top:116px;
  bottom:118px;
  width:3px;
  border-radius:999px;
  background:linear-gradient(to bottom, rgba(255,195,95,.0), rgba(255,195,95,.95), rgba(255,195,95,.06));
  box-shadow:0 0 12px rgba(255,195,95,.85);
  z-index:3;
}
.left-dot{
  position:absolute;
  left:26px;
  top:108px;
  width:18px;
  height:18px;
  border-radius:50%;
  background:#ffd27f;
  box-shadow:0 0 16px rgba(255,210,127,1);
  z-index:3;
}
.top-brand{
  position:absolute;
  top:38px;
  left:50%;
  transform:translateX(-50%);
  display:flex;
  align-items:center;
  gap:12px;
  color:#fff;
  z-index:4;
}
.mic{
  font-size:22px;
  line-height:1;
  opacity:.95;
}
.brand-stack{
  display:flex;
  flex-direction:column;
  align-items:flex-start;
}
.brand-top{
  font-size:16px;
  font-weight:900;
  letter-spacing:1.5px;
  line-height:1;
}
.brand-bottom{
  margin-top:5px;
  font-size:11px;
  font-weight:800;
  letter-spacing:4px;
  line-height:1;
  opacity:.98;
}
.safe-top-zone{
  position:absolute;
  left:86px;
  right:86px;
  top:86px;
  height:150px;
  z-index:4;
  pointer-events:none;
}
.poster{
  position:absolute;
  left:60px;
  right:60px;
  top:196px;
  bottom:146px;
  border-radius:18px;
  overflow:hidden;
  background:#111;
  box-shadow:0 22px 64px rgba(0,0,0,.40);
  z-index:3;
}
.poster-image{
  position:absolute;
  inset:0;
  background-image:url('${imageDataUrl}');
  background-size:cover;
  background-position:center;
  filter:brightness(1.04) saturate(1.04);
}
.poster-shade{
  position:absolute;
  inset:0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,.01) 0%, rgba(0,0,0,.01) 55%, rgba(0,0,0,.05) 78%, rgba(0,0,0,.18) 100%);
}
.bottom-copy{
  position:absolute;
  left:78px;
  right:78px;
  bottom:96px;
  z-index:5;
}
.title-panel{
  display:inline-flex;
  flex-direction:column;
  gap:0;
  max-width:92%;
}
.title-line{
  font-style:italic;
  font-weight:900;
  text-transform:uppercase;
  letter-spacing:-0.8px;
  text-shadow:0 4px 12px rgba(0,0,0,.34);
}
.white-line{
  font-size:30px;
  line-height:0.96;
  color:#ffffff;
}
.yellow-line{
  font-size:40px;
  line-height:0.94;
  color:#f3af1f;
}
.footer{
  position:absolute;
  left:56px;
  right:56px;
  bottom:50px;
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  z-index:5;
}
.footer-left{
  display:flex;
  flex-direction:column;
  gap:2px;
}
.footer-episode{
  font-size:18px;
  line-height:1;
  font-weight:900;
  color:#f3b443;
}
.footer-brand{
  font-size:12px;
  line-height:1;
  font-weight:800;
  letter-spacing:2px;
  color:#e7e7e7;
}
.wave{
  position:relative;
  width:360px;
  height:26px;
  display:flex;
  align-items:center;
  justify-content:center;
  gap:3px;
}
.wave span{
  display:block;
  width:3px;
  border-radius:999px;
  background:#f3b443;
}
.wave span:nth-child(odd){height:8px}
.wave span:nth-child(even){height:14px}
.wave span:nth-child(4n){height:20px}
.wave span:nth-child(7n){height:11px}
.wave-dot{
  position:absolute;
  right:-10px;
  top:50%;
  transform:translateY(-50%);
  width:10px;
  height:10px;
  border-radius:50%;
  background:#ffd27f;
  box-shadow:0 0 10px rgba(255,210,127,.95);
}
</style>
</head>
<body>
  <div class="canvas">
    <div class="bg"></div>
    <div class="overlay"></div>
    <div class="frame"></div>

    <div class="left-line"></div>
    <div class="left-dot"></div>

    <div class="top-brand">
      <div class="mic">🎙</div>
      <div class="brand-stack">
        <div class="brand-top">${safeBadgeTop}</div>
        <div class="brand-bottom">${safeBadgeBottom}</div>
      </div>
    </div>

    <div class="safe-top-zone"></div>

    <div class="poster">
      <div class="poster-image"></div>
      <div class="poster-shade"></div>
    </div>

    <div class="bottom-copy">
      <div class="title-panel">
        ${titleHtml}
      </div>
    </div>

    <div class="footer">
      <div class="footer-left">
        <div class="footer-episode">${safeEpisode}</div>
        <div class="footer-brand">${safeFooterBrand}</div>
      </div>

      <div class="wave">
        ${Array.from({ length: 54 }, () => '<span></span>').join('')}
        <div class="wave-dot"></div>
      </div>
    </div>
  </div>
</body>
</html>
`;

        const browser = await getBrowser();
        page = await browser.newPage();

        await page.setViewport({
            width: 720,
            height: 1280,
            deviceScaleFactor: 2,
        });

        await page.setContent(html, { waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 800));

        const base64Raw = await page.screenshot({
            type: 'jpeg',
            quality: 96,
            encoding: 'base64',
        });

        const base64 = `data:image/jpeg;base64,${base64Raw}`;

        await page.close();
        page = null;

        return res.json({
            success: true,
            base64,
            meta: {
                width: 720,
                height: 1280,
                titleLines: [headline.line1, headline.line2].filter(Boolean),
                truncated: headline.truncated,
                safeTopGap: 150,
                posterTop: 196,
                posterBottom: 146,
                bottomCopyBottom: 96
            }
        });
    } catch (error) {
        console.error('❌ generatePodcastThumbnail error:', error);

        if (page) {
            try { await page.close(); } catch { }
        }

        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

module.exports = router;