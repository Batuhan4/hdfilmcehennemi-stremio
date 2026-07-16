/**
 * HDFilmCehennemi Stremio Addon - Site Configuration
 *
 * Central place for site domains and proxy mode so a domain rotation
 * (e.g. .ws -> .nl) is a config change, not a code edit.
 *
 * Environment variables:
 * - SITE_DOMAIN:   main site domain (default: hdfilmcehennemi.nl)
 * - EMBED_DOMAIN:  embed/player host (default: hdfilmcehennemi.mobi)
 * - PROXY_ENABLED: 'never' | 'auto' | 'always' (default: never — the proxy
 *   subsystem only exists to bypass Cloudflare geo-blocking from outside
 *   Turkey; when deployed in Turkey the site is reachable directly)
 *
 * @module config
 */

// Load .env before reading any environment variables (idempotent)
require('dotenv').config();

const SITE_DOMAIN = process.env.SITE_DOMAIN || 'hdfilmcehennemi.nl';
const EMBED_DOMAIN = process.env.EMBED_DOMAIN || 'hdfilmcehennemi.mobi';

const SITE_BASE_URL = `https://www.${SITE_DOMAIN}`;
const EMBED_BASE_URL = `https://${EMBED_DOMAIN}`;

const PROXY_MODE = process.env.PROXY_ENABLED || 'never';

/**
 * Check if URL belongs to an HDFilmCehennemi domain (site or embed host).
 * Matches any of the site's rotating TLDs by brand name.
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isHdfilmcehennemiUrl(url) {
    return url.includes('hdfilmcehennemi');
}

module.exports = {
    SITE_DOMAIN,
    EMBED_DOMAIN,
    SITE_BASE_URL,
    EMBED_BASE_URL,
    PROXY_MODE,
    isHdfilmcehennemiUrl
};
