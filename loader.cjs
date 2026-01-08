'use strict';

/**
 * loader for --require usage
 *
 * use like: node --require claudescreenfix-hardwicksoftware/loader.cjs $(which claude)
 *
 * this auto-installs the fix before claude code even starts
 * no code changes needed in claude itself
 */

const fix = require('./index.cjs');

// install immediately on require
fix.install();
