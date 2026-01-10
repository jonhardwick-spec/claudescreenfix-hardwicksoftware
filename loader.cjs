'use strict';

/**
 * loader for --require usage
 *
 * use like: node --require claudescreenfix-hardwicksoftware/loader.cjs $(which claude)
 *
 * this auto-installs the fix before claude code even starts
 * you don't need to change any code in claude itself - it just works
 */

const fix = require('./index.cjs');

// install immediately on require
fix.install();
