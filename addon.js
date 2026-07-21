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
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

/**
 * Build the per-input HTTP header block ffmpeg injects on every request it
 * makes for that input (the playlist AND its child segments). The CDN 404s any
 * segment fetched without the embed Referer, so this rides on both inputs.
 * @param {string} referer - Referer URL (may be empty)
 * @returns {string} CRLF-terminated header block for ffmpeg's -headers option
 */
function ffmpegHeaderBlock(referer) {
    if (!referer) return '';
    let block = `Referer: ${referer}\r\n`;
    try {
        block += `Origin: ${new URL(referer).origin}\r\n`;
    } catch { /* malformed referer — send Referer only */ }
    return block;
}

// ---------------------------------------------------------------------------
// Server-side MUX — seekable, incrementally-published local segmented HLS.
//
// The site serves dual-language titles as a VIDEO-ONLY HLS variant + separate
// AAC audio renditions (Turkish / Original). Real players mishandle that HLS
// alternate-audio structure (VLC plays the dublaj entry silent, mpv falls back,
// ExoPlayer errors). We remux (NO re-encode) the video variant + one chosen
// audio rendition into a fresh single-track HLS that any player just plays.
//
// Output is written as GROWING segmented HLS (EVENT playlist) to a per-session
// temp dir, then served with a Range-capable static handler — so playback
// starts within seconds AND the whole title is seekable (unlike a live pipe,
// which has no Content-Length/Range and reads as "still broken" on a 2h movie).
//
// A session is keyed by an opaque token (hash of the input URLs, minted by the
// scraper). First hit on <token>/index.m3u8 starts ffmpeg; the playlist and
// its seg*.ts are served from the temp dir. Sessions are reaped when idle or
// past a wall-clock cap; spawns are concurrency-limited to avoid a seek-storm
// hammering the Referer-gated CDN. LAN-only in practice (see hard rule #9 —
// this endpoint is only reachable over Tailscale / Cloudflare, never public).
// ---------------------------------------------------------------------------

const MUX_TMP_ROOT = path.join(os.tmpdir(), 'hdfc-mux');
const MUX_MAX_CONCURRENT = parseInt(process.env.MUX_MAX_CONCURRENT || '4', 10);
const MUX_WALLCLOCK_MS = (parseInt(process.env.MUX_WALLCLOCK_SEC || '10800', 10)) * 1000; // 3h
const MUX_IDLE_MS = (parseInt(process.env.MUX_IDLE_SEC || '600', 10)) * 1000;             // 10m
const MUX_PLAYLIST_WAIT_MS = 20000; // how long the first index.m3u8 hit waits for the plan
const MUX_SEGMENT_WAIT_MS = 60000;  // how long a seg request waits for ffmpeg to reach it
// Nudge each output cut-point this many seconds EARLIER than the cumulative
// EXTINF boundary. The source playlist rounds segment durations, so a cumulative
// boundary can land a few tenths of a millisecond PAST its keyframe — the
// segment muxer then snaps FORWARD to the next keyframe (~1s later), making that
// segment ~1s too long (the "segment-0 anomaly"). Landing slightly before the
// keyframe snaps to the intended one. 0.2s >> the rounding error and << a
// typical GOP (~1s), so it never snaps to the previous keyframe.
const MUX_CUT_EPSILON = 0.2;
const MUX_FILE_RE = /^(index\.m3u8|seg\d{1,6}\.ts)$/; // path-traversal guard
const MUX_TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** token -> { proc, dir, createdAt, lastAccess, ended, exitCode, stderrTail, wallTimer } */
const muxSessions = new Map();

/**
 * Probe ONCE at startup whether this ffmpeg accepts -extension_picky.
 *
 * The CDN disguises MPEG-TS segments with a fake ".jpg" extension. ffmpeg
 * >=7.1 is "picky" and rejects them ("not in allowed_segment_extensions")
 * unless -extension_picky 0 is passed. ffmpeg <7.1 (e.g. 6.1.2, which ships in
 * node:22-alpine3.21) does NOT know the option AND does not do the picky
 * rejection at all, so the segments demux fine with just -f hls. Passing the
 * option there is fatal: "Unrecognized option 'extension_picky'" -> exit 8.
 *
 * So: detect support and only add the flag when present. -f hls stays
 * unconditional. This keeps the mux working across 6.1.2, 7.1+, and future.
 *
 * Detection asks ffmpeg to print the HLS demuxer's options and checks whether
 * "extension_picky" is among them — deterministic, and independent of any
 * error-message wording (7.1 and 6.1.2 word the failure differently). If the
 * probe can't run at all, assume unsupported (the safe choice: 6.1.2 doesn't
 * need it, and adding an unknown option would be fatal).
 * @returns {boolean} true if the HLS demuxer exposes -extension_picky
 */
function detectExtensionPicky() {
    try {
        const r = spawnSync(
            'ffmpeg',
            ['-hide_banner', '-h', 'demuxer=hls'],
            { encoding: 'utf-8', timeout: 15000 }
        );
        if (r.error) {
            log.warn(`ffmpeg probe failed (${r.error.message}); assuming no -extension_picky`);
            return false;
        }
        return /extension_picky/.test(`${r.stdout || ''}${r.stderr || ''}`);
    } catch (err) {
        log.warn(`ffmpeg probe threw (${err.message}); assuming no -extension_picky`);
        return false;
    }
}

const MUX_EXTENSION_PICKY = detectExtensionPicky();
log.info(`ffmpeg -extension_picky supported: ${MUX_EXTENSION_PICKY}`);

// Clear any stale temp dirs left by a previous crash/restart.
try { fs.rmSync(MUX_TMP_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
fs.mkdirSync(MUX_TMP_ROOT, { recursive: true });

/** Number of sessions whose ffmpeg is still running. */
function activeMuxCount() {
    let n = 0;
    for (const s of muxSessions.values()) if (!s.ended) n++;
    return n;
}

/** Kill a session's ffmpeg and delete its temp dir. */
function killMuxSession(token) {
    const s = muxSessions.get(token);
    if (!s) return;
    muxSessions.delete(token);
    try { if (s.proc && s.proc.exitCode === null) s.proc.kill('SIGKILL'); } catch { /* ignore */ }
    if (s.wallTimer) clearTimeout(s.wallTimer);
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Fetch the VIDEO-ONLY variant playlist and parse its #EXTINF list into a mux
 * PLAN: the per-segment durations (authoritative), the exact total duration,
 * and the cut-points (cumulative boundaries, minus the final one) at which the
 * output must be split. HLS timing is video-PTS-driven, so the video variant is
 * the source of truth for both duration and segment boundaries.
 * @returns {Promise<{durations:number[], total:number, cuts:number[]}>}
 */
async function fetchMuxPlan(videoUrl, referer) {
    const resp = await fetch(videoUrl, {
        headers: upstreamHeaders(referer),
        signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) throw new Error(`variant fetch ${resp.status}`);
    const text = await resp.text();

    const durations = [];
    for (const line of text.split('\n')) {
        const m = line.match(/^#EXTINF:\s*([\d.]+)/);
        if (m) durations.push(parseFloat(m[1]));
    }
    if (durations.length === 0) throw new Error('no #EXTINF in variant playlist');

    // Cut-points = cumulative durations EXCLUDING the final boundary (the last
    // segment runs to EOF, needs no forced cut). N durations -> N-1 cut-points
    // -> N output segments, one per input segment. Each cut is nudged earlier by
    // MUX_CUT_EPSILON so it reliably snaps to its intended keyframe (see const).
    const cuts = [];
    let acc = 0;
    let prev = 0;
    for (let i = 0; i < durations.length - 1; i++) {
        acc += durations[i];
        let cut = acc - MUX_CUT_EPSILON;
        if (cut <= prev) cut = acc; // guard monotonicity for tiny segments
        cuts.push(cut.toFixed(6));
        prev = cut;
    }
    const total = durations.reduce((a, b) => a + b, 0);
    return { durations, total, cuts };
}

/**
 * Author a COMPLETE VOD index.m3u8 from the plan — full segment list, real
 * per-segment #EXTINF, and #EXT-X-ENDLIST present from the very first byte.
 * The player learns the true total runtime immediately (no "episode finished?"
 * false-EOF) and never chases a moving frontier.
 */
function buildVodPlaylist(durations) {
    const target = Math.max(1, Math.ceil(Math.max(...durations)));
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-PLAYLIST-TYPE:VOD',
        `#EXT-X-TARGETDURATION:${target}`,
        '#EXT-X-MEDIA-SEQUENCE:0'
    ];
    durations.forEach((d, i) => {
        lines.push(`#EXTINF:${d.toFixed(6)},`);
        lines.push(`seg${String(i).padStart(5, '0')}.ts`);
    });
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
}

/**
 * Start a mux session. Registers the session record synchronously (so
 * concurrent requests share one startup), then asynchronously: fetches the
 * plan, writes the complete VOD index.m3u8, and spawns ONE continuous ffmpeg
 * -c copy pass whose OUTPUT is cut on the plan's exact segment boundaries.
 * session.ready resolves once the playlist is written and ffmpeg is spawned.
 * @returns {Object} the session record
 */
function startMuxSession(token, videoUrl, audioUrl, referer) {
    const dir = path.join(MUX_TMP_ROOT, token);
    fs.mkdirSync(dir, { recursive: true });

    const session = {
        proc: null, dir, createdAt: Date.now(), lastAccess: Date.now(),
        ended: false, exitCode: null, stderrTail: '', wallTimer: null,
        segCount: 0, ready: null
    };
    muxSessions.set(token, session);

    // Hard wall-clock cap so a stuck/slow remux can't run forever.
    session.wallTimer = setTimeout(() => {
        log.warn(`Mux wall-clock cap hit [${token}], killing`);
        killMuxSession(token);
    }, MUX_WALLCLOCK_MS);

    session.ready = (async () => {
        // A. Compute the plan from the video variant (one cheap GET).
        const plan = await fetchMuxPlan(videoUrl, referer);
        session.segCount = plan.durations.length;
        log.info(`Mux plan [${token}]: ${plan.durations.length} segments, ${plan.total.toFixed(1)}s total`);

        // C. Author the complete VOD playlist upfront (ENDLIST from byte one).
        fs.writeFileSync(path.join(dir, 'index.m3u8'), buildVodPlaylist(plan.durations));

        // B. One continuous -c copy pass; OUTPUT cut on the exact plan
        // boundaries via the segment muxer. Inputs unchanged: -f hls forces the
        // HLS demuxer, -extension_picky 0 (when supported) accepts the CDN's
        // fake ".jpg" segment names. The two renditions are NOT segment-aligned,
        // so per-segment independent muxing would drift — a single copy pass
        // with -copyts keeps A/V in sync; we only re-chunk the output.
        // -reset_timestamps 0 keeps PTS continuous/monotonic across segments.
        const headerBlock = ffmpegHeaderBlock(referer);
        const pickyArgs = MUX_EXTENSION_PICKY ? ['-extension_picky', '0'] : [];
        const args = ['-loglevel', 'error'];
        if (headerBlock) args.push('-headers', headerBlock);
        args.push('-f', 'hls', ...pickyArgs, '-i', videoUrl);
        if (headerBlock) args.push('-headers', headerBlock);
        args.push('-f', 'hls', ...pickyArgs, '-i', audioUrl);
        args.push(
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c', 'copy',
            '-copyts', '-start_at_zero', '-avoid_negative_ts', 'make_zero',
            '-f', 'segment',
            '-segment_format', 'mpegts',
            '-reset_timestamps', '0'
        );
        if (plan.cuts.length > 0) args.push('-segment_times', plan.cuts.join(','));
        args.push(path.join(dir, 'seg%05d.ts'));

        let proc;
        try {
            proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (err) {
            session.ended = true;
            session.exitCode = -1;
            throw err;
        }
        session.proc = proc;

        proc.on('error', (err) => {             // ENOENT etc arrive async here
            log.error(`ffmpeg process error [${token}]: ${err.message}`);
            session.ended = true;
            session.exitCode = -1;
        });
        proc.stderr.on('data', (chunk) => {
            const s = chunk.toString();
            session.stderrTail = (session.stderrTail + s).slice(-2000);
            log.warn(`ffmpeg [${token}]: ${s.trim()}`);
        });
        proc.on('close', (code) => {
            session.ended = true;
            session.exitCode = code;
            if (code && code !== 0) log.error(`ffmpeg exited ${code} [${token}]: ${session.stderrTail.trim()}`);
            else log.info(`ffmpeg finished [${token}] (mux complete)`);
        });
    })();

    // A rejected startup must mark the session failed (and not crash the process
    // via an unhandled rejection); handlers await session.ready and surface 502.
    session.ready.catch((err) => {
        log.error(`Mux start failed [${token}]: ${err.message}`);
        session.ended = true;
        if (session.exitCode === null) session.exitCode = -1;
    });

    log.info(`Mux start [${token}]: v=${videoUrl.substring(0, 55)}... a=${audioUrl.substring(0, 55)}...`);
    return session;
}

/** Reaper: drop sessions that are idle or past the wall-clock cap. */
setInterval(() => {
    const now = Date.now();
    for (const [token, s] of muxSessions) {
        if (now - s.lastAccess > MUX_IDLE_MS || now - s.createdAt > MUX_WALLCLOCK_MS) {
            log.info(`Reaping mux session [${token}] (idle ${Math.round((now - s.lastAccess) / 1000)}s)`);
            killMuxSession(token);
        }
    }
}, 60000).unref();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * MUX HLS handler — serves the per-session index.m3u8 (starting the session on
 * the first hit) and its seg*.ts segments (Range-capable via res.sendFile).
 *
 * Route: /proxy/mux/:token/:file
 *   :file = index.m3u8  -> start session if needed, wait for the plan, serve the
 *                          COMPLETE VOD playlist (full duration + ENDLIST)
 *   :file = segNNNNN.ts -> bounded-wait for the sequential ffmpeg pass to write
 *                          the (complete) segment, then serve it (seekable)
 *
 * index.m3u8 requests carry the input URLs (base64 v/a/ref) so an idle-reaped
 * session can be transparently restarted; segment requests need only the token.
 */
async function muxHandler(req, res) {
    const { token, file } = req.params;

    if (!MUX_TOKEN_RE.test(token) || !MUX_FILE_RE.test(file)) {
        return res.status(400).send('Bad mux request');
    }

    let session = muxSessions.get(token);

    if (file === 'index.m3u8') {
        if (!session) {
            // Need the input URLs to (re)start. They ride on the index.m3u8 URL.
            const { v, a, ref } = req.query;
            if (!v || !a) return res.status(400).send('Missing v or a parameter');

            let videoUrl, audioUrl, referer;
            try {
                videoUrl = Buffer.from(v, 'base64').toString('utf-8');
                audioUrl = Buffer.from(a, 'base64').toString('utf-8');
                referer = ref ? Buffer.from(ref, 'base64').toString('utf-8') : '';
            } catch {
                return res.status(400).send('Bad parameter encoding');
            }

            if (activeMuxCount() >= MUX_MAX_CONCURRENT) {
                log.warn(`Mux concurrency limit (${MUX_MAX_CONCURRENT}) reached, refusing [${token}]`);
                return res.status(503).send('Mux busy, try again shortly');
            }

            session = startMuxSession(token, videoUrl, audioUrl, referer);
        }

        session.lastAccess = Date.now();

        // Wait for the plan+playlist to be authored (fast: one CDN GET).
        try {
            await Promise.race([
                session.ready,
                sleep(MUX_PLAYLIST_WAIT_MS).then(() => { throw new Error('plan timeout'); })
            ]);
        } catch (err) {
            log.warn(`Mux playlist not ready [${token}]: ${err.message}`);
            return res.status(502).send('Mux failed');
        }

        const indexPath = path.join(session.dir, 'index.m3u8');
        if (!fs.existsSync(indexPath)) return res.status(502).send('Mux failed');

        // Serve the complete VOD playlist (segment URIs are relative -> our
        // segment route). It already carries the true duration and ENDLIST.
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache');
        return res.send(fs.readFileSync(indexPath, 'utf-8'));
    }

    // Segment request. Bounded-wait for ffmpeg's sequential pass to reach it,
    // rather than 404-ing — this is what stops the player buffering-vs-EOF bug.
    if (!session) return res.status(410).send('Mux session gone');
    session.lastAccess = Date.now();

    // Wait for startup so we know the total segment count.
    try {
        await session.ready;
    } catch {
        return res.status(502).send('Mux failed');
    }

    const segIdx = parseInt(file.slice(3, -3), 10); // "seg00042.ts" -> 42
    const segPath = path.join(session.dir, file);
    // A segment is COMPLETE once the next one has been opened (segment muxer
    // closes seg N when it starts seg N+1) OR the whole mux has ended. Serving a
    // still-being-written current segment would hand the player a short read.
    const isLast = segIdx >= session.segCount - 1;
    const nextPath = path.join(session.dir, `seg${String(segIdx + 1).padStart(5, '0')}.ts`);
    const deadline = Date.now() + MUX_SEGMENT_WAIT_MS;

    while (true) {
        const exists = fs.existsSync(segPath);
        const complete = exists && (session.ended || (!isLast && fs.existsSync(nextPath)));
        if (complete) break;
        session.lastAccess = Date.now();               // keep the reaper off while a client waits
        if (session.ended) {
            // ffmpeg done: if the file is here it's complete; else it never came.
            if (exists) break;
            return res.status(session.exitCode === 0 ? 404 : 502).end();
        }
        if (Date.now() > deadline) {
            log.warn(`Segment wait timeout [${token}] ${file}`);
            return res.status(504).end();
        }
        await sleep(200);
    }

    // sendFile handles Range/Accept-Ranges/Content-Length.
    return res.sendFile(segPath, { headers: { 'Content-Type': 'video/mp2t' } }, (err) => {
        if (err && !res.headersSent) res.status(err.status || 404).end();
    });
}

app.get('/proxy/mux/:token/:file', muxHandler);

// Mount Stremio addon router
app.use(getRouter(builder.getInterface()));

// Start server
app.listen(PORT, () => {
    log.info(`HDFilmCehennemi Addon v${manifest.version} running at http://localhost:${PORT}/manifest.json`);
    log.info(`M3U8 Proxy endpoint: ${BASE_URL}/proxy/m3u8`);
    log.info(`Set BASE_URL env var for production (current: ${BASE_URL})`);
});
