/**
 * HDFilmCehennemi Stremio Addon - Scraper Module
 * 
 * Handles video and subtitle extraction from HDFilmCehennemi.
 * 
 * @module scraper
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { ScrapingError, NetworkError, TimeoutError } = require('./errors');
const { getWorkingProxy, markProxyBad, createProxyAgent, isProxyEnabled, isProxyAlways } = require('./proxy');
const { SITE_BASE_URL, EMBED_BASE_URL, isHdfilmcehennemiUrl } = require('./config');

const log = createLogger('Scraper');

const BASE_URL = SITE_BASE_URL;
const EMBED_BASE = EMBED_BASE_URL;

// Configuration
const CONFIG = {
    timeout: 15000,        // 15 seconds
    maxRetries: 3,         // Number of retry attempts per proxy
    maxConcurrent: 5,      // Max concurrent requests
    retryDelay: 1000,      // Base delay for exponential backoff (ms)
    maxProxyAttempts: 5    // Max number of different proxies to try
};

const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

// Simple semaphore for rate limiting
let activeRequests = 0;
const requestQueue = [];

/**
 * Acquire a slot for making a request (rate limiting)
 * @returns {Promise<void>}
 */
function acquireSlot() {
    return new Promise((resolve) => {
        if (activeRequests < CONFIG.maxConcurrent) {
            activeRequests++;
            resolve();
        } else {
            requestQueue.push(resolve);
        }
    });
}

/**
 * Release a request slot
 */
function releaseSlot() {
    activeRequests--;
    if (requestQueue.length > 0) {
        activeRequests++;
        const next = requestQueue.shift();
        next();
    }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try to fetch URL using a specific proxy with retries
 * Returns response text on success, null on failure
 * @param {string} url - URL to fetch
 * @param {{address: string, type: string}} proxy - Proxy object with address and type
 * @param {Object} headers - Request headers
 * @returns {Promise<string|null>} Response text or null if all retries failed
 */
async function tryFetchWithProxy(url, proxy, headers) {
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
            await acquireSlot();
            log.debug(`Fetch via proxy ${proxy.type}://${proxy.address} attempt ${attempt}/${CONFIG.maxRetries}: ${url}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
            const dispatcher = createProxyAgent(proxy);

            try {
                const response = await fetch(url, {
                    headers,
                    signal: controller.signal,
                    dispatcher
                });
                clearTimeout(timeoutId);

                if (response.status === 403) {
                    log.warn(`Proxy ${proxy.type}://${proxy.address} blocked by Cloudflare (403)`);
                    return null; // Proxy is blocked, don't retry
                }

                if (!response.ok) {
                    throw new NetworkError(
                        `HTTP ${response.status}: ${response.statusText}`,
                        url,
                        response.status
                    );
                }

                const text = await response.text();

                // Verify not a Cloudflare challenge
                if (text.includes('cf-browser-verification') ||
                    text.includes('Just a moment')) {
                    log.warn(`Proxy ${proxy.type}://${proxy.address} got Cloudflare challenge`);
                    return null; // Proxy got blocked
                }

                log.info(`✅ Fetch via proxy success: ${url} (${text.length} bytes)`);
                return text;
            } catch (error) {
                clearTimeout(timeoutId);
                throw error;
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                log.warn(`Proxy ${proxy.type}://${proxy.address} timeout on attempt ${attempt}`);
            } else {
                log.warn(`Proxy ${proxy.type}://${proxy.address} failed on attempt ${attempt}: ${error.message}`);
            }

            if (attempt < CONFIG.maxRetries) {
                const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
                log.warn(`Proxy request failed, retrying in ${delay}ms...`);
                await sleep(delay);
            }

        } finally {
            releaseSlot();
        }
    }

    return null; // All retries failed
}

/**
 * HTTP GET request with timeout, retry, and smart proxy fallback
 * @param {string} url - URL to fetch
 * @param {string} [referer] - Optional referer header
 * @returns {Promise<string>} Response body as text
 * @throws {NetworkError|TimeoutError}
 */
async function httpGet(url, referer = null) {
    const headers = { ...defaultHeaders };
    if (referer) headers['Referer'] = referer;

    let lastError = null;
    let useProxy = isProxyAlways() && isHdfilmcehennemiUrl(url);

    // Phase 1: Try direct connection (unless proxy is 'always')
    if (!useProxy) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                await acquireSlot();
                log.debug(`HTTP GET direct (attempt ${attempt}/${CONFIG.maxRetries}): ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

                try {
                    const response = await fetch(url, {
                        headers,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    // Check for Cloudflare block (403)
                    if (response.status === 403 && isHdfilmcehennemiUrl(url)) {
                        log.warn(`Cloudflare block detected (403), will try proxy...`);
                        lastError = new NetworkError('Cloudflare block (403)', url, 403);
                        useProxy = true;
                        break;
                    }

                    if (!response.ok) {
                        throw new NetworkError(
                            `HTTP ${response.status}: ${response.statusText}`,
                            url,
                            response.status
                        );
                    }

                    const text = await response.text();

                    // Check for Cloudflare challenge page
                    // NOTE: do not match 'challenge-platform' — Cloudflare injects
                    // /cdn-cgi/challenge-platform/... scripts into normal 200 pages too
                    if (isHdfilmcehennemiUrl(url) &&
                        (text.includes('cf-browser-verification') ||
                            text.includes('Just a moment'))) {
                        log.warn(`Cloudflare challenge detected, will try proxy...`);
                        lastError = new NetworkError('Cloudflare challenge page', url, 403);
                        useProxy = true;
                        break;
                    }

                    log.debug(`HTTP GET success: ${url} (${text.length} bytes)`);
                    return text;

                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }

            } catch (error) {
                lastError = error;

                if (error.name === 'AbortError') {
                    lastError = new TimeoutError(url, CONFIG.timeout);
                } else if (!(error instanceof NetworkError)) {
                    lastError = new NetworkError(error.message, url);
                }

                if (attempt < CONFIG.maxRetries) {
                    const delay = CONFIG.retryDelay * Math.pow(2, attempt - 1);
                    log.warn(`Request failed, retrying in ${delay}ms... (${error.message})`);
                    await sleep(delay);
                }

            } finally {
                releaseSlot();
            }
        }
    }

    // Phase 2: Try with proxies (only for hdfilmcehennemi URLs)
    // Keep trying new proxies until success or max attempts reached
    if (useProxy && isProxyEnabled() && isHdfilmcehennemiUrl(url)) {
        log.info(`🔄 Proxy fallback activated for: ${url}`);

        const triedProxies = new Set();

        for (let proxyAttempt = 1; proxyAttempt <= CONFIG.maxProxyAttempts; proxyAttempt++) {
            const proxy = await getWorkingProxy();

            if (!proxy) {
                log.warn(`No working proxy available (attempt ${proxyAttempt}/${CONFIG.maxProxyAttempts})`);
                // Wait a bit before trying again to allow proxy refresh
                if (proxyAttempt < CONFIG.maxProxyAttempts) {
                    await sleep(2000);
                }
                continue;
            }

            // Skip if we already tried this proxy (compare by address)
            if (triedProxies.has(proxy.address)) {
                log.debug(`Skipping already-tried proxy: ${proxy.type}://${proxy.address}`);
                markProxyBad(proxy); // Force getting a different one next time
                continue;
            }

            triedProxies.add(proxy.address);
            log.info(`📡 Trying proxy ${proxyAttempt}/${CONFIG.maxProxyAttempts}: ${proxy.type}://${proxy.address}`);

            // Try this proxy with retries
            const result = await tryFetchWithProxy(url, proxy, headers);
            if (result) {
                return result;
            }

            // Proxy failed, mark as bad and try next
            log.warn(`Proxy ${proxy.type}://${proxy.address} failed after ${CONFIG.maxRetries} attempts, trying next proxy...`);
            markProxyBad(proxy);
        }

        lastError = new NetworkError(
            `All ${CONFIG.maxProxyAttempts} proxy attempts failed`,
            url
        );
    }

    log.error(`All attempts failed for: ${url}`);
    throw lastError || new NetworkError('All attempts failed', url);
}

/**
 * JavaScript packer unpacker
 * @param {string} p - Packed code
 * @param {number} a - Base for encoding
 * @param {number} c - Count of words
 * @param {string} k - Pipe-separated keywords
 * @returns {string} Unpacked JavaScript
 */
function unpackJS(p, a, c, k) {
    k = k.split('|');

    function decode(word) {
        let n = 0;
        for (const char of word) {
            if (/\d/.test(char)) {
                n = n * a + parseInt(char);
            } else if (/[a-z]/.test(char)) {
                n = n * a + char.charCodeAt(0) - 'a'.charCodeAt(0) + 10;
            } else if (/[A-Z]/.test(char)) {
                n = n * a + char.charCodeAt(0) - 'A'.charCodeAt(0) + 36;
            }
        }
        return n < k.length && k[n] ? k[n] : word;
    }

    return p.replace(/\b\w+\b/g, decode);
}

/**
 * ROT13 cipher - shifts letters by 13 positions
 * @param {string} str - String to decode
 * @returns {string} ROT13 decoded string
 */
function rot13(str) {
    return str.replace(/[a-zA-Z]/g, function (c) {
        return String.fromCharCode(
            (c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26
        );
    });
}

/**
 * Apply character unmix with magic number
 * @param {string} value - String to unmix
 * @returns {string} Unmixed string
 */
function characterUnmix(value) {
    let unmix = '';
    for (let i = 0; i < value.length; i++) {
        let charCode = value.charCodeAt(i);
        charCode = (charCode - (399756995 % (i + 5)) + 256) % 256;
        unmix += String.fromCharCode(charCode);
    }
    return unmix;
}

/**
 * Try to decode with ROT13 first, then base64
 * @param {string} reversed - Reversed string
 * @returns {string} Decoded string
 */
function decodeVariant1(reversed) {
    // ROT13 → base64 → unmix
    let value = rot13(reversed);
    value = Buffer.from(value, 'base64').toString('latin1');
    return characterUnmix(value);
}

/**
 * Try to decode with base64 first, then ROT13
 * @param {string} reversed - Reversed string
 * @returns {string} Decoded string
 */
function decodeVariant2(reversed) {
    // base64 → ROT13 → unmix
    let value = Buffer.from(reversed, 'base64').toString('latin1');
    value = rot13(value);
    return characterUnmix(value);
}

/**
 * Try to decode with base64 first, then reverse, then ROT13
 * NEW algorithm as of Dec 2025 - reverse happens AFTER base64
 * @param {string} value - Raw joined string (not reversed)
 * @returns {string} Decoded string
 */
function decodeVariant3(value) {
    // base64 → reverse → ROT13 → unmix
    let result = Buffer.from(value, 'base64').toString('latin1');
    result = result.split('').reverse().join('');
    result = rot13(result);
    return characterUnmix(result);
}

/**
 * Parse the site's inline `dc_xxx` decoder function into an ordered list of
 * decode steps, plus the encoded parts array it is called with.
 *
 * As of mid-2026 the embed page no longer hides the decoder inside the packed
 * eval block — it emits a plain inline script like:
 *
 *   function dc_XXXX(value_parts) {
 *     let value = value_parts.join('');
 *     result = atob(result);                  // base64 decode
 *     result = result.split('').reverse()...  // reverse
 *     result = result.replace(/[a-zA-Z]/g, (o - base + 16) % 26 + base) // ROT-N
 *     charCode = ((charCode - (1372195828 % (i + 12))) % 256 + 256) % 256 // unmix
 *   }
 *   var s_YYYY = dc_XXXX(["...", "...", ...]);
 *
 * The step order, ROT shift and unmix magic/offset rotate per page, so instead
 * of hardcoding variants we parse the emitted function and interpret its steps.
 * A page may carry more than one dc_ function (e.g. multiple players); every
 * decoder that has a matching call site is returned so the caller can try each.
 *
 * @param {string} html - Raw iframe HTML
 * @returns {Array<{steps: Array<Object>, parts: string[]}>} Parsed decoders (empty if none present)
 */
function parseInlineDecoder(html) {
    const decoders = [];
    const fnRe = /function\s+(dc_\w+)\s*\(\s*[\w$]+\s*\)\s*\{([\s\S]*?)\n\}/g;
    let fnMatch;

    while ((fnMatch = fnRe.exec(html)) !== null) {
        const [, fnName, body] = fnMatch;

        // The call site: var s_xxx = dc_XXXX(["part1", "part2", ...]);
        const callMatch = html.match(new RegExp(fnName + '\\(\\s*\\[([^\\]]+)\\]\\s*\\)'));
        if (!callMatch) continue;
        const quotedParts = callMatch[1].match(/"([^"]+)"/g);
        if (!quotedParts) continue;
        const parts = quotedParts.map(s => s.slice(1, -1));

        // Scan the function body in statement order for known decode primitives
        const steps = [];
        const stepRe = /=\s*atob\(\s*result\s*\)|result\.split\(''\)\.reverse\(\)\.join\(''\)|\(o\s*-\s*base\s*\+\s*(\d+)\)\s*%\s*26|charCode\s*-\s*\((\d+)\s*%\s*\(i\s*\+\s*(\d+)\)\)/g;
        let m;
        while ((m = stepRe.exec(body)) !== null) {
            if (m[0].includes('atob')) {
                steps.push({ op: 'base64' });
            } else if (m[0].includes('reverse')) {
                steps.push({ op: 'reverse' });
            } else if (m[1] !== undefined) {
                steps.push({ op: 'rot', shift: parseInt(m[1], 10) });
            } else {
                steps.push({ op: 'unmix', magic: parseInt(m[2], 10), offset: parseInt(m[3], 10) });
            }
        }

        if (steps.length > 0) {
            decoders.push({ steps, parts });
        }
    }

    return decoders;
}

/**
 * Apply a parsed decode-step chain to the joined parts string.
 * @param {string[]} parts - Encoded parts array
 * @param {Array<Object>} steps - Steps from parseInlineDecoder
 * @returns {string} Decoded string (candidate video URL)
 */
function applyDecodeSteps(parts, steps) {
    let result = parts.join('');
    for (const step of steps) {
        switch (step.op) {
            case 'base64':
                result = Buffer.from(result, 'base64').toString('latin1');
                break;
            case 'reverse':
                result = result.split('').reverse().join('');
                break;
            case 'rot':
                result = result.replace(/[a-zA-Z]/g, (c) => {
                    const o = c.charCodeAt(0);
                    const base = o <= 90 ? 65 : 97;
                    return String.fromCharCode((o - base + step.shift) % 26 + base);
                });
                break;
            case 'unmix': {
                let unmix = '';
                for (let i = 0; i < result.length; i++) {
                    let charCode = result.charCodeAt(i);
                    charCode = ((charCode - (step.magic % (i + step.offset))) % 256 + 256) % 256;
                    unmix += String.fromCharCode(charCode);
                }
                result = unmix;
                break;
            }
        }
    }
    return result;
}

/**
 * Validate if a decoded string is a valid video URL
 * @param {string} url - Decoded URL candidate
 * @returns {boolean} True if it looks like a valid video URL
 */
function isValidVideoUrl(url) {
    return url &&
        typeof url === 'string' &&
        url.startsWith('https://') &&
        (url.includes('.m3u8') || url.includes('/hls/') || url.includes('.mp4'));
}

/**
 * Decode obfuscated video URL with auto-detection
 * The site rotates between multiple algorithm orders:
 *   - Variant 1: join → reverse → ROT13 → base64 → unmix
 *   - Variant 2: join → reverse → base64 → ROT13 → unmix
 *   - Variant 3: join → base64 → reverse → ROT13 → unmix (NEW Dec 2025)
 * 
 * This function tries all variants and returns the one that produces a valid URL.
 *
 * @param {string[]} parts - Array of encoded parts
 * @returns {string|null} Decoded video URL, or null if no variant produced a valid URL
 */
function decodeVideoUrl(parts) {
    const value = parts.join('');

    // For Variants 1 & 2: Reverse the string first
    const reversed = value.split('').reverse().join('');

    // Try Variant 3 FIRST: base64 → reverse → ROT13 → unmix (NEW - most current)
    try {
        const result3 = decodeVariant3(value);
        if (isValidVideoUrl(result3)) {
            log.debug('Video URL decoded using Variant 3 (base64 → reverse → ROT13)');
            return result3;
        }
    } catch (e) {
        log.debug(`Variant 3 failed: ${e.message}`);
    }

    // Try Variant 1: ROT13 → base64 → unmix
    try {
        const result1 = decodeVariant1(reversed);
        if (isValidVideoUrl(result1)) {
            log.debug('Video URL decoded using Variant 1 (ROT13 → base64)');
            return result1;
        }
    } catch (e) {
        log.debug(`Variant 1 failed: ${e.message}`);
    }

    // Try Variant 2: base64 → ROT13 → unmix
    try {
        const result2 = decodeVariant2(reversed);
        if (isValidVideoUrl(result2)) {
            log.debug('Video URL decoded using Variant 2 (base64 → ROT13)');
            return result2;
        }
    } catch (e) {
        log.debug(`Variant 2 failed: ${e.message}`);
    }

    // No variant produced a valid URL. Return null so callers can fall back
    // to alternative sources instead of handing the player a garbage URL.
    log.warn('No algorithm variant produced a valid video URL (site encryption may have rotated)');
    return null;
}

/**
 * Scrape video and subtitle data from iframe URL
 * @param {string} iframeSrc - Iframe source URL
 * @param {boolean} [fetchAudioTracks=false] - Fetch the m3u8 to enumerate audio tracks
 *   (extra round trip; only useful for diagnostics — the player reads tracks from the m3u8 itself)
 * @returns {Promise<{videoUrl: string|null, subtitles: Array, audioTracks: Array}>}
 * @throws {ScrapingError|NetworkError}
 */
async function scrapeIframe(iframeSrc, fetchAudioTracks = false) {
    log.debug(`Scraping iframe: ${iframeSrc}`);

    const html = await httpGet(iframeSrc, BASE_URL);
    const $ = cheerio.load(html);

    const result = {
        videoUrl: null,
        subtitles: [],
        audioTracks: []
    };

    // Extract subtitles from <track> elements
    $('video track').each((i, el) => {
        const src = $(el).attr('src');
        if (src) {
            // Resolve relative to the iframe URL so path-relative srcs work too;
            // fall back to the embed host if the src is unparseable
            let fullUrl;
            try {
                fullUrl = new URL(src, iframeSrc).href;
            } catch {
                fullUrl = src.startsWith('http') ? src : EMBED_BASE + src;
            }
            result.subtitles.push({
                id: `hdfc-${$(el).attr('srclang') || i}`,
                lang: $(el).attr('srclang') || 'unknown',
                label: $(el).attr('label') || '',
                url: fullUrl,
                default: $(el).attr('default') !== undefined
            });
        }
    });

    log.debug(`Found ${result.subtitles.length} subtitles`);

    // Method 1: Inline dc_xxx decoder (current format as of mid-2026).
    // The embed page emits the decoder function and its encoded parts array in
    // plain sight; we parse the step chain and interpret it rather than relying
    // on a fixed variant order (steps/ROT shift/unmix magic rotate per page).
    const inlineDecoders = parseInlineDecoder(html);
    for (const decoder of inlineDecoders) {
        try {
            const decoded = applyDecodeSteps(decoder.parts, decoder.steps);
            if (isValidVideoUrl(decoded)) {
                result.videoUrl = decoded;
                log.debug(`Video URL extracted from inline decoder: ${decoded.substring(0, 80)}...`);
                break;
            }
            log.debug('Inline decoder produced a non-URL result, trying next candidate');
        } catch (e) {
            log.debug(`Inline decoder failed: ${e.message}`);
        }
    }
    if (inlineDecoders.length === 0) {
        log.debug('No inline dc_ decoder found in iframe');
    }

    // Method 2: Try packed JavaScript decoder (legacy format, retained as fallback)
    const packedMatch = !result.videoUrl &&
        html.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.+)',(\d+),(\d+),'([^']+)'/s);

    if (packedMatch) {
        const decoded = unpackJS(
            packedMatch[1],
            parseInt(packedMatch[2]),
            parseInt(packedMatch[3]),
            packedMatch[4]
        );

        // Decode video URL from parts array
        const partsMatch = decoded.match(/dc_\w+\(\[([^\]]+)\]\)/);
        const quotedParts = partsMatch && partsMatch[1].match(/"([^"]+)"/g);
        if (quotedParts) {
            const parts = quotedParts.map(s => s.replace(/"/g, ''));
            result.videoUrl = decodeVideoUrl(parts);
            if (result.videoUrl) {
                log.debug(`Video URL extracted from packed JS: ${result.videoUrl.substring(0, 80)}...`);
            }
        }
    } else if (!result.videoUrl) {
        log.debug('No packed JavaScript found in iframe');
    }

    // Method 3: Fallback to JSON-LD schema (if inline + packed JS both failed).
    // NOTE: the JSON-LD contentUrl on this site is frequently a stale/expired
    // CDN link (e.g. playmix.uno/master.txt that 404s); it is a last resort only.
    if (!result.videoUrl) {
        const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        if (jsonLdMatch) {
            try {
                const jsonLd = JSON.parse(jsonLdMatch[1]);
                if (jsonLd.contentUrl) {
                    result.videoUrl = jsonLd.contentUrl;
                    log.debug(`Video URL extracted from JSON-LD: ${result.videoUrl.substring(0, 80)}...`);
                }
            } catch (e) {
                log.debug(`Failed to parse JSON-LD: ${e.message}`);
            }
        }
    }

    // Extract audio tracks from m3u8 (opt-in — costs an extra request on the hot path)
    if (result.videoUrl && fetchAudioTracks) {
        try {
            const m3u8Content = await httpGet(result.videoUrl, iframeSrc);
            const audioRegex = /#EXT-X-MEDIA:TYPE=AUDIO.*?NAME="([^"]+)".*?URI="([^"]+)"/g;
            let match;

            while ((match = audioRegex.exec(m3u8Content)) !== null) {
                // new URL() handles absolute, root-relative and path-relative URIs
                result.audioTracks.push({
                    name: match[1],
                    url: new URL(match[2], result.videoUrl).href
                });
            }

            log.debug(`Found ${result.audioTracks.length} audio tracks`);
        } catch (error) {
            log.warn(`Failed to fetch m3u8: ${error.message}`);
        }
    }

    if (!result.videoUrl) {
        log.warn('No video URL found in iframe');
    }

    return result;
}

/**
 * Get video and subtitle data from a page URL
 * Implements fallback logic for alternative sources
 * 
 * @param {string} pageUrl - HDFilmCehennemi page URL
 * @param {Object} [options] - Options
 * @param {boolean} [options.fetchAudioTracks=false] - Fetch the m3u8 to enumerate audio tracks (diagnostic only)
 * @returns {Promise<{videoUrl: string, subtitles: Array, audioTracks: Array, source?: string, alternativeSources: Array}|null>}
 * @throws {ScrapingError|NetworkError}
 */
async function getVideoAndSubtitles(pageUrl, options = {}) {
    const { fetchAudioTracks = false } = options;
    log.info(`Fetching video from: ${pageUrl}`);

    const html = await httpGet(pageUrl);
    const $ = cheerio.load(html);

    // Find iframe
    const iframe = $('iframe');
    const iframeSrc = iframe.attr('src') || iframe.attr('data-src');

    if (!iframeSrc) {
        log.warn('No iframe found on page');
        throw new ScrapingError('Sayfa üzerinde video oynatıcı bulunamadı', pageUrl);
    }

    log.debug(`Found iframe: ${iframeSrc}`);

    // Collect alternative sources
    const altSources = [];
    $('.alternative-link').each((i, el) => {
        altSources.push({
            name: $(el).text().trim(),
            videoId: $(el).attr('data-video'),
            active: $(el).attr('data-active') === '1'
        });
    });

    log.debug(`Found ${altSources.length} alternative sources`);

    // Extract embed origin from iframe URL for Referer header
    const getEmbedOrigin = (url) => {
        try {
            const parsed = new URL(url);
            return parsed.origin;
        } catch {
            return BASE_URL; // Fallback to main site
        }
    };

    // Track which iframe source was actually used
    let usedIframeSrc = iframeSrc;

    // Try active source
    let result = null;
    try {
        result = await scrapeIframe(iframeSrc, fetchAudioTracks);
    } catch (error) {
        log.warn(`Primary source failed: ${error.message}`);
    }

    // Fallback to alternative sources if video URL not found
    if (!result || !result.videoUrl) {
        log.info('Primary source failed, trying alternatives...');

        const videoIdMatch = iframeSrc.match(/embed\/([^\/\?]+)/);
        if (videoIdMatch) {
            const videoId = videoIdMatch[1];

            for (const alt of altSources) {
                if (alt.active) continue;

                log.debug(`Trying alternative: ${alt.name}`);

                let altIframeSrc = iframeSrc;
                if (alt.name.toLowerCase() === 'rapidrame') {
                    altIframeSrc = `${EMBED_BASE}/video/embed/${videoId}/?rapidrame_id=${alt.videoId}`;
                } else {
                    altIframeSrc = `${EMBED_BASE}/video/embed/${videoId}/`;
                }

                try {
                    const altResult = await scrapeIframe(altIframeSrc, fetchAudioTracks);
                    if (altResult && altResult.videoUrl) {
                        result = altResult;
                        result.source = alt.name;
                        usedIframeSrc = altIframeSrc; // Track which iframe worked
                        log.info(`Alternative source succeeded: ${alt.name}`);
                        break;
                    }
                } catch (error) {
                    log.debug(`Alternative ${alt.name} failed: ${error.message}`);
                }
            }
        }
    } else {
        const activeSource = altSources.find(s => s.active);
        if (activeSource) {
            result.source = activeSource.name;
        }
    }

    if (!result || !result.videoUrl) {
        throw new ScrapingError('Video URL çıkarılamadı', pageUrl);
    }

    result.alternativeSources = altSources;
    // Store the embed origin for Referer header - critical for Rapidrame playback
    result.embedOrigin = getEmbedOrigin(usedIframeSrc);
    log.info(`Video extraction successful (source: ${result.source || 'default'}, embedOrigin: ${result.embedOrigin})`);

    return result;
}


/**
 * Convert scraping result to Stremio stream format
 * Audio track selection is handled by Stremio player via m3u8
 * 
 * @param {Object} result - Scraping result from getVideoAndSubtitles
 * @param {string} [title='HDFilmCehennemi'] - Stream title
 * @param {string} [baseUrl] - Base URL for m3u8 proxy (e.g., https://your-server.com)
 * @returns {{streams: Array}} Stremio-compatible stream response
 */
function toStremioStreams(result, title = 'HDFilmCehennemi', baseUrl = null) {
    if (!result || !result.videoUrl) return { streams: [] };

    // Use the embed origin from scraping result, fallback to EMBED_BASE
    // Critical: Rapidrame videos need the main site domain as Referer
    //           Close videos need the embed host as Referer
    const embedOrigin = result.embedOrigin || EMBED_BASE;
    const referer = embedOrigin + '/';

    // Generate proxied URL for TV compatibility (libVLC doesn't support proxyHeaders)
    // PC clients can still use behaviorHints.proxyHeaders
    let streamUrl = result.videoUrl;
    if (baseUrl) {
        // base64url: '+' in plain base64 becomes a space in query strings and corrupts the URL
        const encodedUrl = Buffer.from(result.videoUrl).toString('base64url');
        const encodedRef = Buffer.from(referer).toString('base64url');
        streamUrl = `${baseUrl}/proxy/m3u8?url=${encodedUrl}&ref=${encodedRef}`;
    }

    // Video server requires Referer header - returns 404 without it
    // This is for PC clients that support proxyHeaders
    const behaviorHints = {
        notWebReady: true,
        proxyHeaders: {
            request: {
                'Referer': referer,
                'Origin': embedOrigin
            }
        }
    };

    // Return single stream - audio tracks selectable via player from m3u8
    return {
        streams: [{
            url: streamUrl,
            title: title,
            name: 'HDFilmCehennemi',
            behaviorHints: behaviorHints,
            subtitles: result.subtitles.map(s => ({
                id: s.id,
                url: s.url,
                lang: s.lang,
                label: s.label
            }))
        }]
    };
}

module.exports = {
    getVideoAndSubtitles,
    toStremioStreams
};
