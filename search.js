/**
 * HDFilmCehennemi Search & Matching Module
 * 
 * Handles content discovery: IMDb ID → HDFilmCehennemi URL mapping
 * 
 * @module search
 */

const { fetch } = require('undici');
const cheerio = require('cheerio');
const { createLogger } = require('./logger');
const { ContentNotFoundError, NetworkError, ValidationError, TimeoutError } = require('./errors');
const { getWorkingProxy, markProxyBad, createProxyAgent, isProxyEnabled, isProxyAlways } = require('./proxy');
const { SITE_BASE_URL, isHdfilmcehennemiUrl } = require('./config');
const { curlGet } = require('./curlClient');

const log = createLogger('Search');

const BASE_URL = SITE_BASE_URL;

// Configuration
const CONFIG = {
    timeout: 15000,        // 15 seconds
    maxRetries: 3,         // Number of retry attempts per proxy
    retryDelay: 1000,      // Base delay for exponential backoff (ms)
    maxProxyAttempts: 5    // Max number of different proxies to try
};



const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
};

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate IMDb ID format
 * @param {string} imdbId - IMDb ID to validate
 * @returns {boolean} True if valid
 */
function isValidImdbId(imdbId) {
    return /^tt\d{7,8}$/.test(imdbId);
}

/**
 * Validate season/episode numbers
 * @param {*} value - Value to validate
 * @returns {boolean} True if valid positive integer
 */
function isValidEpisodeNumber(value) {
    const num = parseInt(value);
    return !isNaN(num) && num > 0 && num < 1000;
}



/**
 * Wrap a curl fallback body in a minimal, fetch-Response-compatible object so
 * callers of fetchWithRetry (which expect `.status`/`.ok`/`.text()`/`.json()`)
 * work unchanged whether the response came from undici or curl.
 * @param {number} status - HTTP status code
 * @param {string} body - Response body text
 * @returns {{status: number, ok: boolean, text: function(): Promise<string>, json: function(): Promise<Object>}}
 */
function makeCurlResponse(status, body) {
    return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => body,
        json: async () => JSON.parse(body)
    };
}

/**
 * Try to fetch URL using a specific proxy with retries
 * @param {string} url - URL to fetch
 * @param {{address: string, type: string}} proxy - Proxy object with address and type
 * @param {Object} options - Fetch options
 * @returns {Promise<Response|null>} Response or null if all retries failed
 */
async function tryFetchWithProxy(url, proxy, options) {
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
            log.debug(`Fetch via proxy ${proxy.type}://${proxy.address} attempt ${attempt}/${CONFIG.maxRetries}: ${url}`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);
            const dispatcher = createProxyAgent(proxy);

            try {
                const response = await fetch(url, {
                    ...options,
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

                log.info(`✅ Fetch via proxy success: ${url}`);
                return response;
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
        }
    }

    return null; // All retries failed
}

/**
 * HTTP GET with timeout, retry, and smart proxy fallback
 * Keeps trying new proxies until success or max attempts reached
 * @param {string} url - URL to fetch
 * @param {Object} [options] - Fetch options
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}) {
    let lastError = null;
    let useProxy = isProxyAlways() && isHdfilmcehennemiUrl(url);

    // Phase 1: Try direct connection (unless proxy is 'always')
    if (!useProxy) {
        for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
            try {
                log.debug(`Fetch direct attempt ${attempt}/${CONFIG.maxRetries}: ${url}`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

                try {
                    const response = await fetch(url, {
                        ...options,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    // Check for Cloudflare block (403)
                    // The site's /dizi/ (series) pages sit behind a JA3 TLS gate
                    // that 403s undici but passes the system curl. Retry via curl
                    // before falling back to the (usually disabled) proxy path.
                    if (response.status === 403 && isHdfilmcehennemiUrl(url)) {
                        log.warn(`Cloudflare block (403) via undici, retrying via curl: ${url}`);
                        try {
                            const { status, body } = await curlGet(url, options.headers || defaultHeaders, CONFIG.timeout);
                            if (status === 200 && body) {
                                log.info(`✅ curl fallback success: ${url} (${body.length} bytes)`);
                                return makeCurlResponse(status, body);
                            }
                            log.warn(`curl fallback unusable (status ${status}), will try proxy...`);
                        } catch (curlErr) {
                            log.warn(`curl fallback errored: ${curlErr.message}, will try proxy...`);
                        }
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

                    return response;
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
                    log.warn(`Request failed, retrying in ${delay}ms...`);
                    await sleep(delay);
                }
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

            const response = await tryFetchWithProxy(url, proxy, options);

            if (response) {
                return response; // Success!
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

    throw lastError || new NetworkError('All attempts failed', url);
}


/**
 * Search for content on HDFilmCehennemi
 * NOTE: Search results are NOT cached because even when results are returned,
 * the actual video extraction may fail. Fresh searches ensure retries work.
 * @param {string} query - Search query (IMDb ID or title)
 * @returns {Promise<Array<{url: string, title: string, year: number|null, type: string, slug: string}>>}
 */
async function searchOnSite(query) {
    try {
        // AJAX search endpoint - uses ?q= parameter
        const searchUrl = `${BASE_URL}/search/?q=${encodeURIComponent(query)}`;
        log.info(`Searching: "${query}"`);

        const response = await fetchWithRetry(searchUrl, {
            headers: {
                ...defaultHeaders,
                'X-Requested-With': 'fetch',
                'Accept': 'application/json'
            }
        });

        const data = await response.json();
        const results = [];

        // Parse HTML snippets from JSON response
        if (data.results && Array.isArray(data.results)) {
            for (const htmlStr of data.results) {
                const $ = cheerio.load(htmlStr);
                const link = $('a').attr('href');
                const title = $('h4.title').text().trim() || $('img').attr('alt') || '';
                const yearText = $('.year').text().trim();
                const year = yearText ? parseInt(yearText) : null;
                const type = $('.type').text().trim().toLowerCase();

                if (link && link.includes('hdfilmcehennemi')) {
                    results.push({
                        url: link,
                        title: title,
                        year: year,
                        type: type === 'dizi' ? 'series' : 'movie',
                        slug: link.replace(BASE_URL, '').replace(/\//g, '')
                    });
                }
            }
        }

        log.info(`Search "${query}": ${results.length} results`);
        return results;
    } catch (error) {
        log.error(`Search failed: ${error.message}`);
        return [];
    }
}


/**
 * Find episode URL from series page
 * NOTE: No caching here - caching happens at addon.js level on full success only
 * @param {string} seriesUrl - Series page URL
 * @param {number} season - Season number
 * @param {number} episode - Episode number
 * @returns {Promise<string|null>} Episode URL or null
 */
async function findEpisodeUrl(seriesUrl, season, episode) {
    let episodes = [];

    try {
        log.debug(`Fetching episodes from: ${seriesUrl}`);
        const response = await fetchWithRetry(seriesUrl, { headers: defaultHeaders });
        const html = await response.text();
        const $ = cheerio.load(html);

        // Find episode links
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('-sezon-') && href.includes('-bolum')) {
                // Extract season and episode from URL
                const match = href.match(/(\d+)-sezon-(\d+)-bolum/);
                if (match) {
                    episodes.push({
                        url: href,
                        season: parseInt(match[1]),
                        episode: parseInt(match[2])
                    });
                }
            }
        });

        // Alternative format: sezon-X/bolum-Y
        if (episodes.length === 0) {
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && (href.includes('sezon') || href.includes('bolum'))) {
                    const seasonMatch = href.match(/sezon[/-]?(\d+)/i);
                    const episodeMatch = href.match(/bolum[/-]?(\d+)/i);
                    if (seasonMatch && episodeMatch) {
                        episodes.push({
                            url: href,
                            season: parseInt(seasonMatch[1]),
                            episode: parseInt(episodeMatch[1])
                        });
                    }
                }
            });
        }

        log.debug(`Found ${episodes.length} episodes`);
    } catch (error) {
        log.error(`Failed to get episodes: ${error.message}`);
        return null;
    }

    // Find requested episode
    const targetEpisode = episodes.find(ep =>
        ep.season === parseInt(season) && ep.episode === parseInt(episode)
    );

    if (!targetEpisode) {
        log.warn(`Episode not found: S${season}E${episode}`);
        return null;
    }

    // Episode hrefs may be relative — resolve against the series page URL
    let episodeUrl = targetEpisode.url;
    try {
        episodeUrl = new URL(targetEpisode.url, seriesUrl).href;
    } catch { /* keep as-is if unresolvable */ }

    log.debug(`Found episode: S${season}E${episode} -> ${episodeUrl}`);
    return episodeUrl;
}

/**
 * Find HDFilmCehennemi URL for content by IMDb ID
 * 
 * @param {'movie'|'series'} type - Content type
 * @param {string} imdbId - IMDb ID (e.g., tt0499549)
 * @param {number} [season] - Season number (series only)
 * @param {number} [episode] - Episode number (series only)
 * @returns {Promise<{url: string, title: string, seriesTitle?: string}|null>}
 * @throws {ValidationError|ContentNotFoundError}
 */
async function findContent(type, imdbId, season = null, episode = null) {
    // Input validation
    if (!imdbId || typeof imdbId !== 'string') {
        throw new ValidationError('IMDb ID gerekli', 'imdbId', imdbId);
    }

    if (!isValidImdbId(imdbId)) {
        throw new ValidationError('Geçersiz IMDb ID formatı (örnek: tt1234567)', 'imdbId', imdbId);
    }

    if (type !== 'movie' && type !== 'series') {
        throw new ValidationError('Tür movie veya series olmalı', 'type', type);
    }

    if (type === 'series') {
        if (season && !isValidEpisodeNumber(season)) {
            throw new ValidationError('Geçersiz sezon numarası', 'season', season);
        }
        if (episode && !isValidEpisodeNumber(episode)) {
            throw new ValidationError('Geçersiz bölüm numarası', 'episode', episode);
        }
    }

    log.info(`Finding content: ${type} - ${imdbId}${season ? ` S${season}E${episode}` : ''}`);

    let match = null;

    // 1. Search by IMDb ID (only method - most reliable)
    log.debug(`Searching by IMDb ID: ${imdbId}`);
    const imdbResults = await searchOnSite(imdbId);

    if (imdbResults.length > 0) {
        // IMDb search usually returns single exact match
        match = imdbResults[0];
        log.info(`Found via IMDb ID: ${match.title} -> ${match.url}`);
    }

    // No title-based fallback - IMDb ID search only for accuracy
    if (!match) {
        log.warn(`No match found for IMDb ID: ${imdbId}`);
        throw new ContentNotFoundError(imdbId, { type, reason: 'not_found_on_site' });
    }

    log.info(`Match found: ${match.title} -> ${match.url}`);

    // 3. For series, find episode URL
    if (type === 'series' && season && episode) {
        const episodeUrl = await findEpisodeUrl(match.url, season, episode);
        if (!episodeUrl) {
            throw new ContentNotFoundError(`${match.title} S${season}E${episode}`, {
                type: 'episode',
                season,
                episode
            });
        }
        return {
            url: episodeUrl,
            title: `${match.title} S${season}E${episode}`,
            seriesTitle: match.title
        };
    }

    return {
        url: match.url,
        title: match.title
    };
}

module.exports = {
    findContent,
    searchOnSite,
    isValidImdbId
};
