#!/usr/bin/env node
'use strict';

/**
 * wrapper script - runs claude with the terminal fix loaded
 *
 * finds your claude binary and runs it with our fix injected
 * no manual setup needed, just run claude-fixed instead of claude
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// find the loader path
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
  console.error('claude not found in PATH - make sure its installed');
  process.exit(1);
}

// run claude with our fix loaded via NODE_OPTIONS
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
