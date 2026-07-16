/**
 * HDFilmCehennemi Stremio Addon Server
 * 
 * Main entry point for the Stremio addon.
 * Includes m3u8 proxy endpoint for TV compatibility.
 * 
 * @module addon
 */

// config loads .env before reading any environment variables
const { SITE_BASE_URL } = require('./config');

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const { fetch } = require('undici');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { getVideoAndSubtitles, toStremioStreams } = require('./scraper');
const { findContent, isValidImdbId } = require('./search');
const { createLogger } = require('./logger');
const { ContentNotFoundError, ScrapingError, ValidationError, NetworkError, TimeoutError } = require('./errors');

const log = createLogger('Addon');

// Server configuration
const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const manifest = {
    id: 'community.hdfilmcehennemi',
    version: '1.2.0',
    name: 'HDFilmCehennemi',
    description: 'HDFilmCehennemi üzerinden film ve dizi izleyin. Türkçe dublaj ve altyazı desteği.',
    logo: `${SITE_BASE_URL}/favicon.ico`,
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

const builder = new addonBuilder(manifest);

// In-memory caches (success-only, bounded)
const STREAM_CACHE_TTL = 10 * 60 * 1000;      // resolved streams — short, video URLs can expire
const CONTENT_URL_CACHE_TTL = 6 * 60 * 60 * 1000; // imdbId -> page URL mapping — stable
const CACHE_MAX_ENTRIES = 500;
const streamCache = new Map();     // key: `${type}:${id}` -> { value, expires }
const contentUrlCache = new Map(); // key: `${type}:${id}` -> { value, expires }

/**
 * Get a non-expired cache entry, or null
 * @param {Map} cache - Cache map
 * @param {string} key - Cache key
 * @returns {*} Cached value or null
 */
function cacheGet(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}

/**
 * Store a cache entry with TTL, evicting the oldest entry when full
 * @param {Map} cache - Cache map
 * @param {string} key - Cache key
 * @param {*} value - Value to store
 * @param {number} ttl - Time to live in ms
 */
function cacheSet(cache, key, value, ttl) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        cache.delete(cache.keys().next().value);
    }
    cache.set(key, { value, expires: Date.now() + ttl });
}

/**
 * Stream handler - Find content on HDFilmCehennemi and return streams
 */
builder.defineStreamHandler(async ({ type, id }) => {
    const startTime = Date.now();
    log.info(`Stream request: ${type} - ${id}`);

    const cacheKey = `${type}:${id}`;

    // Serve from cache — Stremio clients often fire the same request repeatedly
    const cachedStreams = cacheGet(streamCache, cacheKey);
    if (cachedStreams) {
        log.info(`Cache hit for ${cacheKey} (${Date.now() - startTime}ms)`);
        return cachedStreams;
    }

    try {
        // Parse IMDb ID
        const [imdbId, season, episode] = id.split(':');

        // Validate input
        if (!imdbId) {
            log.warn('Missing IMDb ID');
            return { streams: [] };
        }

        if (!isValidImdbId(imdbId)) {
            log.warn(`Invalid IMDb ID format: ${imdbId}`);
            return { streams: [] };
        }

        // Find content on HDFilmCehennemi (skip the search round trip when cached)
        let content = cacheGet(contentUrlCache, cacheKey);
        if (!content) {
            content = await findContent(type, imdbId, season, episode);
        }

        log.info(`Content found: ${content.url}`);

        // Extract video and subtitle data. fetchAudioTracks enumerates the
        // master m3u8's audio groups so we can split dublaj vs altyazı entries.
        const result = await getVideoAndSubtitles(content.url, { fetchAudioTracks: true });

        // Convert to Stremio format with proxy URL for TV compatibility
        const streams = toStremioStreams(result, content.title, BASE_URL);

        // Cache only on full success so retries stay fresh after failures
        if (streams.streams.length > 0) {
            cacheSet(contentUrlCache, cacheKey, content, CONTENT_URL_CACHE_TTL);
            cacheSet(streamCache, cacheKey, streams, STREAM_CACHE_TTL);
        }

        const elapsed = Date.now() - startTime;
        log.info(`Returning ${streams.streams.length} stream(s) for ${imdbId} (${elapsed}ms)`);

        return streams;

    } catch (error) {
        const elapsed = Date.now() - startTime;

        // Helper to create user-friendly error message stream
        const errorStream = (title, description) => ({
            streams: [{
                name: 'HDFilmCehennemi',
                title: `⚠️ ${title}`,
                description: description,
                externalUrl: SITE_BASE_URL
            }]
        });

        // Handle specific error types with user-visible messages
        if (error instanceof ValidationError) {
            log.warn(`Validation error: ${error.message} (${elapsed}ms)`);
            return { streams: [] };
        }

        if (error instanceof ContentNotFoundError) {
            log.info(`Content not found: ${error.query} (${elapsed}ms)`);
            return errorStream(
                'İçerik Bulunamadı',
                'Bu içerik HDFilmCehennemi\'de mevcut değil.'
            );
        }

        if (error instanceof ScrapingError) {
            log.warn(`Scraping error: ${error.message} (${elapsed}ms)`);
            return errorStream(
                'İçerik Kaldırılmış',
                'Bu içerik DMCA veya telif hakkı nedeniyle kaldırılmış olabilir.'
            );
        }

        if (error instanceof TimeoutError) {
            log.error(`Timeout: ${error.url} (${elapsed}ms)`);
            return errorStream(
                'Bağlantı Zaman Aşımı',
                'Sunucu yanıt vermedi. Lütfen tekrar deneyin.'
            );
        }

        if (error instanceof NetworkError) {
            log.error(`Network error: ${error.message} [${error.statusCode}] (${elapsed}ms)`);
            return errorStream(
                'Bağlantı Hatası',
                'HDFilmCehennemi\'ye bağlanılamadı.'
            );
        }

        // Unknown error
        log.error(`Unexpected error: ${error.message} (${elapsed}ms)`, error);
        return errorStream(
            'Bilinmeyen Hata',
            'Bir hata oluştu. Lütfen daha sonra tekrar deneyin.'
        );
    }
});

// Create Express app with Stremio addon router
const app = express();

// Add CORS headers for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

/**
 * Build upstream request headers with optional Referer/Origin
 * @param {string} referer - Referer URL (empty string for none)
 * @returns {Object} Headers object
 */
function upstreamHeaders(referer) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (referer) {
        headers['Referer'] = referer;
        try {
            headers['Origin'] = new URL(referer).origin;
        } catch { /* malformed referer — send without Origin */ }
    }
    return headers;
}

/**
 * Rewrite all URLs in an m3u8 playlist to go through our /proxy/stream endpoint
 * Handles segment lines, nested playlists, and URI="..." attributes (audio/subtitle tracks)
 *
 * Optionally serves a single-language audio master, so the dublaj vs altyazı
 * stream entries carry exactly ONE EXT-X-MEDIA:TYPE=AUDIO rendition:
 *   - opts.audio = 'tr'   → keep the Turkish audio group (DEFAULT/AUTOSELECT=YES),
 *                            drop every non-Turkish audio rendition
 *   - opts.audio = 'orig' → keep the non-Turkish audio group, drop the Turkish one
 * This removes the alternate-audio ambiguity that VLC ignores. It is a no-op on
 * media (variant) playlists, which carry no audio lines, so the same function is
 * safe for both /proxy/m3u8 and /proxy/stream.
 *
 * Every rewritten URL is given a real media extension on its PATH before the
 * query string ('/proxy/stream/pl.m3u8?...' for nested playlists, '.../seg.ts?...'
 * for segments) so ffmpeg >=7.1 (extension_picky=1) accepts it at parse time.
 *
 * @param {string} content - Raw m3u8 content
 * @param {string} playlistUrl - Full URL of the playlist being rewritten (for resolving relative paths)
 * @param {string} ref - Already-encoded ref query parameter to propagate
 * @param {{audio?: string}} [opts] - Audio forcing option
 * @returns {string} Rewritten playlist
 */
function rewritePlaylist(content, playlistUrl, ref, opts = {}) {
    const { audio } = opts;

    // base64url: safe in query strings ('+' in plain base64 decodes as a space)
    const proxyUrl = (originalUrl) => {
        // new URL() correctly resolves absolute, root-relative (/hls/...) and
        // path-relative references, and is immune to query strings in the base
        let fullUrl;
        try {
            fullUrl = new URL(originalUrl, playlistUrl).href;
        } catch {
            return originalUrl; // unresolvable — leave the line untouched
        }
        const encodedUrl = Buffer.from(fullUrl).toString('base64url');
        // Give the proxied path a real media extension BEFORE the query so
        // ffmpeg >=7.1 (extension_picky=1) accepts it at parse time. Nested
        // playlists (upstream .m3u8/.txt) get pl.m3u8; segments get seg.ts.
        const upstreamPath = fullUrl.split('?')[0];
        const fname = (upstreamPath.endsWith('.m3u8') || upstreamPath.endsWith('.txt'))
            ? 'pl.m3u8' : 'seg.ts';
        return `${BASE_URL}/proxy/stream/${fname}?url=${encodedUrl}&ref=${ref || ''}`;
    };

    const out = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();

        // Per-audio master: keep exactly ONE audio rendition, drop the other
        // language's entirely, and force the survivor DEFAULT=YES,AUTOSELECT=YES.
        if (audio && trimmed.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(trimmed)) {
            const nameMatch = trimmed.match(/NAME="([^"]*)"/);
            const isTurkish = nameMatch && /t[üu]rk/i.test(nameMatch[1]);
            const keep = (audio === 'tr' && isTurkish) || (audio === 'orig' && !isTurkish);
            if (!keep) continue; // drop the other language's audio rendition

            let rewritten = trimmed;
            if (/DEFAULT=(YES|NO)/i.test(rewritten)) {
                rewritten = rewritten.replace(/DEFAULT=(YES|NO)/i, 'DEFAULT=YES');
            } else {
                rewritten = rewritten.replace(/(#EXT-X-MEDIA:)/, '$1DEFAULT=YES,');
            }
            if (/AUTOSELECT=(YES|NO)/i.test(rewritten)) {
                rewritten = rewritten.replace(/AUTOSELECT=(YES|NO)/i, 'AUTOSELECT=YES');
            } else {
                rewritten = rewritten.replace(/DEFAULT=YES/, 'DEFAULT=YES,AUTOSELECT=YES');
            }
            rewritten = rewritten.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxyUrl(uri)}"`);
            out.push(rewritten);
            continue;
        }

        // Handle URI= in comments (audio/subtitle tracks, encryption keys)
        if (trimmed.includes('URI="')) {
            out.push(trimmed.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${proxyUrl(uri)}"`));
            continue;
        }

        // Skip other comments and empty lines
        if (trimmed.startsWith('#') || trimmed === '') {
            out.push(line);
            continue;
        }

        // Rewrite segment/playlist URLs
        out.push(proxyUrl(trimmed));
    }

    return out.join('\n');
}

/**
 * M3U8 Proxy Endpoint - Fetches m3u8 with proper Referer header
 * Rewrites all URLs to go through our proxy for full TV compatibility
 *
 * Query params:
 * - url: Base64url-encoded m3u8 URL
 * - ref: Base64url-encoded Referer URL
 */
app.get('/proxy/m3u8', async (req, res) => {
    try {
        const { url, ref, audio } = req.query;

        if (!url) {
            return res.status(400).send('Missing url parameter');
        }

        // Decode base64 parameters (Node accepts both base64 and base64url alphabets)
        const videoUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : '';

        log.debug(`Proxy m3u8: ${videoUrl.substring(0, 80)}... (audio=${audio || 'none'})`);

        // Fetch m3u8 with Referer header
        const response = await fetch(videoUrl, {
            headers: upstreamHeaders(referer),
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            log.error(`Proxy fetch failed: ${response.status}`);
            return res.status(response.status).send('Failed to fetch m3u8');
        }

        // Rewrite ALL URLs to go through our proxy, serving a single-language
        // audio master when an audio preference is requested (audio=tr|orig).
        const content = rewritePlaylist(await response.text(), videoUrl, ref, { audio });

        // Return m3u8 content with proper headers
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache');
        res.send(content);

        log.info(`Proxied m3u8: ${content.length} bytes`);

    } catch (error) {
        log.error(`Proxy m3u8 error: ${error.message}`);
        if (!res.headersSent) {
            res.status(500).send('Proxy error');
        }
    }
});

/**
 * Stream Proxy Endpoint - Proxies video segments with Referer header
 * Handles both m3u8 sub-playlists and .ts/.m4s segments.
 *
 * Registered on two paths: the bare /proxy/stream (backward compat) and
 * /proxy/stream/:fname where :fname is a cosmetic real-extension filename
 * (pl.m3u8 / seg.ts) that lets ffmpeg >=7.1 accept the URL at parse time.
 * The :fname is ignored; the actual target comes from the ?url= param.
 */
async function proxyStreamHandler(req, res) {
    try {
        const { url, ref } = req.query;

        if (!url) {
            return res.status(400).send('Missing url parameter');
        }

        // Decode base64 parameters (Node accepts both base64 and base64url alphabets)
        const streamUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : '';

        // Fetch stream with Referer header
        const response = await fetch(streamUrl, {
            headers: upstreamHeaders(referer)
        });

        if (!response.ok) {
            log.error(`Proxy stream failed: ${response.status} for ${streamUrl.substring(0, 60)}...`);
            return res.status(response.status).send('Failed to fetch stream');
        }

        // Check if this is an m3u8 playlist (needs URL rewriting)
        const contentType = response.headers.get('content-type') || '';
        const urlPath = streamUrl.split('?')[0];
        const isM3u8 = urlPath.endsWith('.m3u8') || urlPath.endsWith('.txt') ||
            contentType.includes('mpegurl') || contentType.includes('m3u8');

        if (isM3u8) {
            const content = rewritePlaylist(await response.text(), streamUrl, ref);

            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-cache');
            res.send(content);
        } else {
            // Binary content (video/audio segments). The CDN mislabels every
            // segment as image/jpeg (real payload is MPEG-TS), which steers
            // ExoPlayer's extractor wrongly — force the correct type. VTT (if a
            // subtitle URL is ever routed here) keeps text/vtt.
            if (urlPath.toLowerCase().endsWith('.vtt')) {
                res.set('Content-Type', 'text/vtt');
            } else {
                res.set('Content-Type', 'video/mp2t');
            }
            const contentLength = response.headers.get('content-length');
            if (contentLength) res.set('Content-Length', contentLength);
            res.set('Cache-Control', 'max-age=3600');

            // pipeline handles backpressure and tears down the upstream
            // fetch if the client disconnects mid-segment
            await pipeline(Readable.fromWeb(response.body), res);
        }

    } catch (error) {
        // Client disconnects mid-segment are routine for video players — log quietly
        if (error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
            log.debug('Proxy stream closed by client');
        } else {
            log.error(`Proxy stream error: ${error.message}`);
        }
        if (!res.headersSent) {
            res.status(500).send('Proxy error');
        } else {
            res.destroy();
        }
    }
}

// Bare path kept for backward compat; /:fname carries the cosmetic real
// extension (pl.m3u8 / seg.ts) that ffmpeg >=7.1 needs to accept the URL.
app.get('/proxy/stream', proxyStreamHandler);
app.get('/proxy/stream/:fname', proxyStreamHandler);

// Mount Stremio addon router
app.use(getRouter(builder.getInterface()));

// Start server
app.listen(PORT, () => {
    log.info(`HDFilmCehennemi Addon v${manifest.version} running at http://localhost:${PORT}/manifest.json`);
    log.info(`M3U8 Proxy endpoint: ${BASE_URL}/proxy/m3u8`);
    log.info(`Set BASE_URL env var for production (current: ${BASE_URL})`);
});
