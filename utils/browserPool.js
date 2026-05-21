const puppeteer = require('puppeteer');

let _browser = null;
let _launching = null;

function checkBrowserAlive(browser) {
    if (!browser) return false;

    if (typeof browser.connected === 'boolean') {
        return browser.connected;
    }

    if (typeof browser.isConnected === 'function') {
        try {
            return browser.isConnected();
        } catch {
            return false;
        }
    }

    return false;
}

async function launchBrowser() {
    console.log('🚀 [BrowserPool] Launching new browser instance...');

    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpuvenue',
            '--single-process',
            '--no-zygote',
        ]
    });

    browser.on('disconnected', () => {
        console.warn('⚠️ [BrowserPool] Browser disconnected, will restart on next request');
        if (_browser === browser) {
            _browser = null;
        }
    });

    console.log('✅ [BrowserPool] Browser ready');
    return browser;
}

async function getBrowser() {
    if (checkBrowserAlive(_browser)) {
        return _browser;
    }

    if (_launching) {
        return _launching;
    }

    _launching = launchBrowser()
        .then((browser) => {
            _browser = browser;
            return browser;
        })
        .finally(() => {
            _launching = null;
        });

    return _launching;
}

async function closeBrowser() {
    if (_browser) {
        try {
            await _browser.close();
            console.log('🛑 [BrowserPool] Browser closed');
        } catch (e) {
            console.warn('⚠️ [BrowserPool] Error closing browser:', e.message);
        }
        _browser = null;
    }

    _launching = null;
}

function isBrowserAlive() {
    return checkBrowserAlive(_browser);
}

module.exports = {
    getBrowser,
    closeBrowser,
    isBrowserAlive,
};