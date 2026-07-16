/**
 * HDFilmCehennemi Addon Test Script
 * 
 * Tests the scraping and search functionality.
 */

const { getVideoAndSubtitles, toStremioStreams } = require('./scraper');
const { findContent, searchOnSite, isValidImdbId } = require('./search');
const { SITE_BASE_URL } = require('./config');
const { createLogger } = require('./logger');
const { ContentNotFoundError, ScrapingError, ValidationError } = require('./errors');

const log = createLogger('Test');

/**
 * Test scraping functionality
 */
async function testScraping() {
    log.info('='.repeat(60));
    log.info('Testing Scraper');
    log.info('='.repeat(60));

    // Override with TEST_URL env var if this slug rotates off the site
    const testUrl = process.env.TEST_URL || `${SITE_BASE_URL}/1-avatar-hd-film-izle-510/`;
    log.info(`Test URL: ${testUrl}`);

    try {
        const result = await getVideoAndSubtitles(testUrl, { fetchAudioTracks: true });

        log.info('✅ Scraping successful!');

        // Source
        if (result.source) {
            log.info(`📡 Source: ${result.source}`);
        }

        // Video URL
        log.info(`📹 Video URL: ${result.videoUrl ? result.videoUrl.substring(0, 80) + '...' : 'None'}`);

        // Audio Tracks
        log.info(`🔊 Audio Tracks: ${result.audioTracks.length}`);
        for (const track of result.audioTracks) {
            log.debug(`   - ${track.name}`);
        }

        // Subtitles
        log.info(`📝 Subtitles: ${result.subtitles.length}`);
        for (const sub of result.subtitles) {
            log.debug(`   - [${sub.lang}] ${sub.label}`);
        }

        // Alternative Sources
        log.info(`🔄 Alternative Sources: ${result.alternativeSources.length}`);

        // Stremio format
        const stremioFormat = toStremioStreams(result, 'Test Movie');
        log.info(`📦 Stremio Streams: ${stremioFormat.streams.length}`);

        return true;
    } catch (error) {
        log.error(`❌ Scraping failed: ${error.message}`);
        return false;
    }
}

/**
 * Test search functionality
 */
async function testSearch() {
    log.info('');
    log.info('='.repeat(60));
    log.info('Testing Search');
    log.info('='.repeat(60));

    // Test IMDb ID validation
    log.info('Testing IMDb ID validation...');
    console.log(`  tt0499549: ${isValidImdbId('tt0499549') ? '✅' : '❌'}`);
    console.log(`  tt12345678: ${isValidImdbId('tt12345678') ? '✅' : '❌'}`);
    console.log(`  invalid: ${!isValidImdbId('invalid') ? '✅' : '❌'}`);
    console.log(`  tt123: ${!isValidImdbId('tt123') ? '✅' : '❌'}`);

    // Test search by IMDb ID
    log.info('Testing IMDb ID search (Avatar - tt0499549)...');
    try {
        const results = await searchOnSite('tt0499549');
        if (results.length > 0) {
            log.info(`✅ Found ${results.length} result(s): ${results[0].title}`);
        } else {
            log.warn('⚠️ No results found');
        }
    } catch (error) {
        log.error(`❌ Search failed: ${error.message}`);
    }

    // Test findContent
    log.info('Testing findContent (movie)...');
    try {
        const content = await findContent('movie', 'tt0499549');
        log.info(`✅ Found: ${content.title} -> ${content.url}`);
    } catch (error) {
        if (error instanceof ContentNotFoundError) {
            log.warn(`⚠️ Content not found: ${error.query}`);
        } else {
            log.error(`❌ findContent failed: ${error.message}`);
        }
    }

    return true;
}

/**
 * Test error handling
 */
async function testErrorHandling() {
    log.info('');
    log.info('='.repeat(60));
    log.info('Testing Error Handling');
    log.info('='.repeat(60));

    // Test validation error
    log.info('Testing validation error (invalid IMDb ID)...');
    try {
        await findContent('movie', 'invalid_id');
        log.error('❌ Should have thrown ValidationError');
    } catch (error) {
        if (error instanceof ValidationError) {
            log.info(`✅ ValidationError caught: ${error.message}`);
        } else {
            log.error(`❌ Wrong error type: ${error.constructor.name}`);
        }
    }

    // Test content not found
    log.info('Testing content not found (non-existent movie)...');
    try {
        await findContent('movie', 'tt9999999');
        log.warn('⚠️ Expected ContentNotFoundError');
    } catch (error) {
        if (error instanceof ContentNotFoundError) {
            log.info(`✅ ContentNotFoundError caught: ${error.query}`);
        } else {
            log.info(`ℹ️ Got ${error.constructor.name}: ${error.message}`);
        }
    }

    return true;
}

/**
 * Run all tests
 */
async function runTests() {
    console.log('');
    log.info('HDFilmCehennemi Addon Test Suite');
    log.info(`Environment: LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}`);
    console.log('');



    const startTime = Date.now();

    try {
        await testScraping();
        await testSearch();
        await testErrorHandling();
    } catch (error) {
        log.error(`Test suite error: ${error.message}`, error);
    }

    const elapsed = Date.now() - startTime;
    console.log('');
    log.info('='.repeat(60));
    log.info(`Tests completed in ${elapsed}ms`);
    log.info('='.repeat(60));
}

runTests().catch(error => {
    log.error(`Fatal error: ${error.message}`, error);
    process.exit(1);
});
