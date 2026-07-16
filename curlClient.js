/**
 * HDFilmCehennemi Stremio Addon - curl Fallback HTTP Client
 *
 * The site's `/dizi/` (series) pages sit behind a Cloudflare TLS-fingerprint
 * (JA3) bot gate that returns 403 to Node's undici/native TLS stack, while the
 * SAME request from the system `curl` binary returns 200. Movie pages and the
 * embed host are not gated, so they keep using the fast undici path; only when
 * undici hits a 403 on a hdfilmcehennemi URL do we retry the request through
 * `curl`, whose libcurl+OpenSSL ClientHello passes the gate.
 *
 * This module shells out to the system `curl` for that single fallback case.
 * It is deliberately dependency-free (uses child_process) so it works in the
 * production `node:22-alpine` container once `curl` is installed there
 * (`apk add --no-cache curl`).
 *
 * @module curlClient
 */

const { execFile } = require('child_process');
const { createLogger } = require('./logger');

const log = createLogger('CurlClient');

/**
 * Fetch a URL via the system `curl` binary.
 *
 * Serialized, single-request semantics — the caller is responsible for pacing;
 * this helper issues exactly one `curl` process per call. Uses `--compressed`
 * so gzip/brotli responses are transparently decoded, and appends the HTTP
 * status via `-w` so we can read it back without a second request.
 *
 * @param {string} url - URL to fetch
 * @param {Object} [headers={}] - Request headers (key → value)
 * @param {number} [timeoutMs=15000] - Max time for the request in milliseconds
 * @returns {Promise<{status: number, body: string}>} HTTP status and response body
 * @throws {Error} If curl is missing or fails to run (non-HTTP failure)
 */
function curlGet(url, headers = {}, timeoutMs = 15000) {
    const maxSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

    // Build header args; -w appends "\n<status>" to stdout after the body so we
    // read the status code from the last line without an extra round trip.
    const args = ['-sS', '--compressed', '--max-time', String(maxSeconds)];
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined && value !== null) {
            args.push('-H', `${key}: ${value}`);
        }
    }
    args.push('-w', '\n%{http_code}', url);

    log.debug(`curl GET: ${url}`);

    return new Promise((resolve, reject) => {
        execFile(
            'curl',
            args,
            // Give the child a hard ceiling slightly above curl's own --max-time,
            // a large buffer for full HTML pages, and latin1 so binary-ish bytes
            // survive (cheerio/Buffer decoding happens downstream).
            { timeout: timeoutMs + 5000, maxBuffer: 32 * 1024 * 1024, encoding: 'latin1' },
            (error, stdout) => {
                if (error) {
                    log.warn(`curl failed for ${url}: ${error.message}`);
                    return reject(error);
                }
                const out = stdout || '';
                const idx = out.lastIndexOf('\n');
                const statusStr = idx >= 0 ? out.slice(idx + 1) : out;
                const body = idx >= 0 ? out.slice(0, idx) : '';
                const status = parseInt(statusStr, 10) || 0;
                log.debug(`curl GET success: ${url} (status ${status}, ${body.length} bytes)`);
                resolve({ status, body });
            }
        );
    });
}

module.exports = { curlGet };
