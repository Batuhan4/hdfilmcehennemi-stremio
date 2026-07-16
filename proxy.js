/**
 * HDFilmCehennemi Stremio Addon - Proxy Module
 * 
 * Handles proxy list fetching, caching, and rotation for bypassing Cloudflare blocks.
 * Uses multiple proxy sources merged together for reliability.
 * Supports HTTP, SOCKS4, and SOCKS5 proxies.
 * 
 * @module proxy
 */

const { fetch, ProxyAgent } = require('undici');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { createLogger } = require('./logger');
const { SITE_BASE_URL, PROXY_MODE } = require('./config');

const log = createLogger('Proxy');

// HTTP proxy sources - Turkey only
const HTTP_SOURCES = [
    // ProxyScrape - Turkey HTTP proxies (most reliable, ~11 proxies)
    'https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=TR&ssl=all&anonymity=all&skip=0',
    // Proxy-List.download - Turkey HTTP (no anon filter = all anonymity levels)
    'https://www.proxy-list.download/api/v1/get?type=http&country=TR',
    // Geonode - Turkey HTTP (JSON format, no anonymity filter = all levels)
    'https://proxylist.geonode.com/api/proxy-list?country=TR&protocols=http&page=1&sort_by=lastChecked&sort_type=desc&limit=100',
];

// SOCKS4 proxy sources - Turkey only
const SOCKS4_SOURCES = [
    // Geonode - Turkey SOCKS4
    'https://proxylist.geonode.com/api/proxy-list?country=TR&protocols=socks4&page=1&sort_by=lastChecked&sort_type=desc&limit=100',
];

// SOCKS5 proxy sources - Turkey only
const SOCKS5_SOURCES = [
    // Geonode - Turkey SOCKS5
    'https://proxylist.geonode.com/api/proxy-list?country=TR&protocols=socks5&page=1&sort_by=lastChecked&sort_type=desc&limit=100',
];

// Combined sources for backward compatibility
const PROXY_SOURCES = [...HTTP_SOURCES, ...SOCKS4_SOURCES, ...SOCKS5_SOURCES];

// Configuration
const CONFIG = {
    proxyEnabled: PROXY_MODE, // 'never' (default) | 'auto' | 'always'
    cacheTTL: 10 * 60 * 1000, // 10 minutes
    testTimeout: 8000, // 8 seconds for proxy test
    maxProxiesToTest: 100, // Test all available proxies for fastest discovery
    testUrl: `${SITE_BASE_URL}/` // URL to test proxies against
};

// Proxy list cache - now stores objects with type info
let proxyListCache = {
    proxies: [], // Array of { address: 'ip:port', type: 'http'|'socks4'|'socks5' }
    timestamp: 0,
    workingProxies: [] // Array of { address: 'ip:port', type: 'http'|'socks4'|'socks5' }
};

/**
 * Fetch proxies from a single source with type annotation
 * @param {string} url - Proxy source URL
 * @param {string} type - Proxy type ('http', 'socks4', 'socks5')
 * @returns {Promise<Array<{address: string, type: string}>>} Array of proxy objects
 */
async function fetchFromSource(url, type) {
    try {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(8000)
        });

        if (!response.ok) return [];

        const text = await response.text();
        let addresses = [];

        // Handle JSON response (geonode format)
        if (url.includes('geonode')) {
            try {
                const json = JSON.parse(text);
                if (json.data && Array.isArray(json.data)) {
                    addresses = json.data.map(p => `${p.ip}:${p.port}`);
                }
            } catch { return []; }
        } else {
            // Handle plain text response
            addresses = text
                .split(/[\n\r]+/)
                .map(line => line.trim())
                .filter(line => line && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(line));
        }

        // Return with type annotation
        return addresses.map(address => ({ address, type }));
    } catch (error) {
        log.debug(`Failed to fetch from ${url}: ${error.message}`);
        return [];
    }
}

/**
 * Fetch and merge proxy lists from all sources
 * @returns {Promise<Array<{address: string, type: string}>>} Array of unique proxy objects
 */
async function fetchProxyList() {
    // Check cache
    if (proxyListCache.proxies.length > 0 &&
        Date.now() - proxyListCache.timestamp < CONFIG.cacheTTL) {
        log.debug(`Using cached proxy list (${proxyListCache.proxies.length} proxies)`);
        return proxyListCache.proxies;
    }

    log.info(`Fetching proxies from all sources (HTTP, SOCKS4, SOCKS5)...`);

    // Fetch from all sources in parallel with type annotation
    const fetchPromises = [
        ...HTTP_SOURCES.map(url => fetchFromSource(url, 'http')),
        ...SOCKS4_SOURCES.map(url => fetchFromSource(url, 'socks4')),
        ...SOCKS5_SOURCES.map(url => fetchFromSource(url, 'socks5')),
    ];

    const results = await Promise.all(fetchPromises);
    const allProxies = results.flat();

    // Deduplicate by address (keep first occurrence with its type)
    const seen = new Set();
    const uniqueProxies = allProxies.filter(p => {
        if (seen.has(p.address)) return false;
        seen.add(p.address);
        return true;
    });

    // Count by type for logging
    const counts = { http: 0, socks4: 0, socks5: 0 };
    uniqueProxies.forEach(p => counts[p.type]++);
    log.info(`Fetched ${uniqueProxies.length} unique proxies (HTTP: ${counts.http}, SOCKS4: ${counts.socks4}, SOCKS5: ${counts.socks5})`);

    if (uniqueProxies.length > 0) {
        // Update cache - PRESERVE working proxies!
        proxyListCache.proxies = uniqueProxies;
        proxyListCache.timestamp = Date.now();
    }

    return uniqueProxies.length > 0 ? uniqueProxies : proxyListCache.proxies;
}


/**
 * Create proxy agent based on proxy type
 * @param {{address: string, type: string}} proxy - Proxy object with address and type
 * @returns {ProxyAgent|SocksProxyAgent} Appropriate proxy agent
 */
function createProxyAgentForType(proxy) {
    const { address, type } = proxy;

    if (type === 'socks4') {
        return new SocksProxyAgent(`socks4://${address}`);
    } else if (type === 'socks5') {
        return new SocksProxyAgent(`socks5://${address}`);
    } else {
        // Default to HTTP
        return new ProxyAgent(`http://${address}`);
    }
}

/**
 * Test if a proxy works for HDFilmCehennemi
 * @param {{address: string, type: string}} proxy - Proxy object with address and type
 * @returns {Promise<boolean>} True if proxy works
 */
async function testProxy(proxy) {
    try {
        const dispatcher = createProxyAgentForType(proxy);

        const response = await fetch(CONFIG.testUrl, {
            dispatcher,
            signal: AbortSignal.timeout(CONFIG.testTimeout),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Check if we got past Cloudflare (not 403)
        if (response.status === 200) {
            const text = await response.text();
            // Make sure it's not a Cloudflare challenge page
            if (!text.includes('cf-browser-verification') &&
                !text.includes('Just a moment') &&
                text.length > 1000) {
                log.debug(`✅ Proxy works: ${proxy.type}://${proxy.address}`);
                return true;
            }
        }

        log.debug(`❌ Proxy blocked: ${proxy.type}://${proxy.address} (status: ${response.status})`);
        return false;
    } catch (error) {
        log.debug(`❌ Proxy failed: ${proxy.type}://${proxy.address} (${error.message})`);
        return false;
    }
}

/**
 * Get a working proxy for HDFilmCehennemi
 * Reuses cached working proxy if available, only tests new ones if needed
 * Tests proxies in PARALLEL for speed
 * KEEPS RETRYING until a working proxy is found (up to maxRetries)
 * @returns {Promise<{address: string, type: string}|null>} Working proxy object or null
 */
async function getWorkingProxy() {
    if (CONFIG.proxyEnabled === 'never') {
        log.debug('Proxy disabled by configuration');
        return null;
    }

    // Return cached working proxy if available - no re-testing needed!
    if (proxyListCache.workingProxies.length > 0) {
        const proxy = proxyListCache.workingProxies[0];
        log.info(`♻️ Reusing cached working proxy: ${proxy.type}://${proxy.address}`);
        return proxy;
    }

    const maxRetries = 5;
    const retryDelay = 3000; // 3 seconds between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        // Fetch fresh proxy list (force refresh on retry)
        if (attempt > 1) {
            proxyListCache.timestamp = 0; // Force refresh
        }
        const proxies = await fetchProxyList();

        if (proxies.length === 0) {
            log.warn('No proxies available from sources');
            if (attempt < maxRetries) {
                log.info(`Retrying in ${retryDelay / 1000}s... (attempt ${attempt}/${maxRetries})`);
                await new Promise(r => setTimeout(r, retryDelay));
                continue;
            }
            return null;
        }

        // Shuffle and select proxies to test
        const shuffled = [...proxies].sort(() => Math.random() - 0.5);
        const toTest = shuffled.slice(0, CONFIG.maxProxiesToTest);

        // Count types for logging
        const counts = { http: 0, socks4: 0, socks5: 0 };
        toTest.forEach(p => counts[p.type]++);
        log.info(`Testing ${toTest.length} proxies in parallel (HTTP: ${counts.http}, SOCKS4: ${counts.socks4}, SOCKS5: ${counts.socks5})... (attempt ${attempt}/${maxRetries})`);

        // Test ALL proxies in parallel - much faster!
        const results = await Promise.all(
            toTest.map(async (proxy) => {
                const works = await testProxy(proxy);
                return { proxy, works };
            })
        );

        // Find first working proxy
        const working = results.find(r => r.works);
        if (working) {
            proxyListCache.workingProxies.push(working.proxy);
            log.info(`✅ Found working proxy: ${working.proxy.type}://${working.proxy.address}`);
            return working.proxy;
        }

        log.warn(`No working proxy found in batch (attempt ${attempt}/${maxRetries})`);

        if (attempt < maxRetries) {
            log.info(`⏳ Retrying in ${retryDelay / 1000}s...`);
            await new Promise(r => setTimeout(r, retryDelay));
        }
    }

    log.error('Failed to find working proxy after all retries');
    return null;
}

/**
 * Mark a proxy as bad (failed during use)
 * @param {{address: string, type: string}} proxy - Proxy object to remove
 */
function markProxyBad(proxy) {
    proxyListCache.workingProxies = proxyListCache.workingProxies.filter(
        p => p.address !== proxy.address
    );
    log.debug(`Marked proxy as bad: ${proxy.type}://${proxy.address}`);
}

/**
 * Create a ProxyAgent for the given proxy (supports HTTP, SOCKS4, SOCKS5)
 * @param {{address: string, type: string}} proxy - Proxy object with address and type
 * @returns {ProxyAgent|SocksProxyAgent} Appropriate proxy agent
 */
function createProxyAgent(proxy) {
    return createProxyAgentForType(proxy);
}

/**
 * Check if proxy usage is enabled
 * @returns {boolean}
 */
function isProxyEnabled() {
    return CONFIG.proxyEnabled !== 'never';
}

/**
 * Check if proxy should always be used
 * @returns {boolean}
 */
function isProxyAlways() {
    return CONFIG.proxyEnabled === 'always';
}

/**
 * Clear proxy cache (for testing)
 */
function clearProxyCache() {
    proxyListCache = {
        proxies: [],
        timestamp: 0,
        workingProxies: []
    };
    log.info('Proxy cache cleared');
}

module.exports = {
    getWorkingProxy,
    markProxyBad,
    createProxyAgent,
    isProxyEnabled,
    isProxyAlways
};
