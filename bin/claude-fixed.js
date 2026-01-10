#!/usr/bin/env node
'use strict';

/**
 * wrapper script - runs claude with the terminal fix loaded
 *
 * finds your claude binary and runs it with our fix injected
 * you don't need any manual setup, just run claude-fixed instead of claude
 * it'll handle the rest
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// find the loader path - it's in the parent dir
const loaderPath = path.join(__dirname, '..', 'loader.cjs');

if (!fs.existsSync(loaderPath)) {
  console.error('loader not found at ' + loaderPath);
  process.exit(1);
}

// find claude binary
let claudeBin;
try {
  claudeBin = execSync('which claude', { encoding: 'utf8' }).trim();
} catch (e) {
  console.error('claude not found in PATH - make sure it\'s installed');
  process.exit(1);
}

// run claude with our fix loaded via NODE_OPTIONS - it's the cleanest way
const env = Object.assign({}, process.env, {
  NODE_OPTIONS: '--require ' + loaderPath + ' ' + (process.env.NODE_OPTIONS || '')
});

const child = spawn(claudeBin, process.argv.slice(2), {
  stdio: 'inherit',
  env: env
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
