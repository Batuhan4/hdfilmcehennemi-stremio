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

        // Extract video and subtitle data
        const result = await getVideoAndSubtitles(content.url);

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
 * @param {string} content - Raw m3u8 content
 * @param {string} baseUrl - Base URL for resolving relative paths (with trailing slash)
 * @param {string} ref - Already-encoded ref query parameter to propagate
 * @returns {string} Rewritten playlist
 */
function rewritePlaylist(content, baseUrl, ref) {
    // base64url: safe in query strings ('+' in plain base64 decodes as a space)
    const proxyUrl = (originalUrl) => {
        const fullUrl = originalUrl.startsWith('http') ? originalUrl : baseUrl + originalUrl;
        const encodedUrl = Buffer.from(fullUrl).toString('base64url');
        return `${BASE_URL}/proxy/stream?url=${encodedUrl}&ref=${ref || ''}`;
    };

    return content.split('\n').map(line => {
        const trimmed = line.trim();

        // Handle URI= in comments (audio/subtitle tracks, encryption keys)
        if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
                return `URI="${proxyUrl(uri)}"`;
            });
        }

        // Skip other comments and empty lines
        if (trimmed.startsWith('#') || trimmed === '') {
            return line;
        }

        // Rewrite segment/playlist URLs
        return proxyUrl(trimmed);
    }).join('\n');
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
        const { url, ref } = req.query;

        if (!url) {
            return res.status(400).send('Missing url parameter');
        }

        // Decode base64 parameters (Node accepts both base64 and base64url alphabets)
        const videoUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : '';

        log.debug(`Proxy m3u8: ${videoUrl.substring(0, 80)}...`);

        // Get base URL for resolving relative paths
        const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf('/') + 1);

        // Fetch m3u8 with Referer header
        const response = await fetch(videoUrl, {
            headers: upstreamHeaders(referer),
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            log.error(`Proxy fetch failed: ${response.status}`);
            return res.status(response.status).send('Failed to fetch m3u8');
        }

        // Rewrite ALL URLs to go through our proxy
        const content = rewritePlaylist(await response.text(), baseUrl, ref);

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
 * Handles both m3u8 sub-playlists and .ts/.m4s segments
 */
app.get('/proxy/stream', async (req, res) => {
    try {
        const { url, ref } = req.query;

        if (!url) {
            return res.status(400).send('Missing url parameter');
        }

        // Decode base64 parameters (Node accepts both base64 and base64url alphabets)
        const streamUrl = Buffer.from(url, 'base64').toString('utf-8');
        const referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : '';

        // Get base URL for this stream (for nested m3u8 files)
        const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf('/') + 1);

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
            const content = rewritePlaylist(await response.text(), baseUrl, ref);

            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-cache');
            res.send(content);
        } else {
            // Binary content (video/audio segments) - pipe with backpressure handling
            res.set('Content-Type', contentType || 'video/mp2t');
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
});

// Mount Stremio addon router
app.use(getRouter(builder.getInterface()));

// Start server
app.listen(PORT, () => {
    log.info(`HDFilmCehennemi Addon v${manifest.version} running at http://localhost:${PORT}/manifest.json`);
    log.info(`M3U8 Proxy endpoint: ${BASE_URL}/proxy/m3u8`);
    log.info(`Set BASE_URL env var for production (current: ${BASE_URL})`);
});
