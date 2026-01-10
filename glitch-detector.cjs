'use strict';

/**
 * glitch detector - catches when the terminal's cooked
 *
 * watches for these signals:
 * - stdin goes quiet while stdout's still busy (input blocked)
 * - too many resize events too fast (sigwinch spam)
 * - render rate going crazy (ink thrashing)
 *
 * when 2+ signals fire we know shit's broken and try to recover
 */

const EventEmitter = require('events');
const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');

// Default configuration
const DEFAULT_CONFIG = {
  stdinTimeoutMs: 2000,       // stdin silence threshold
  sigwinchThresholdMs: 10,    // minimum ms between resize events
  sigwinchStormCount: 5,      // resize events/sec to trigger storm alert
  renderRateLimit: 500,       // max renders per minute before alert
  lineLimitMax: 120,          // max terminal lines before trim
  checkIntervalMs: 500,       // how often to check for glitch state
  recoveryDelayMs: 1000,      // delay before recovery actions
  debug: process.env.CLAUDE_GLITCH_DETECTOR_DEBUG === '1'
};

class GlitchDetector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // State tracking
    this.lastStdinTime = Date.now();
    this.lastStdoutTime = 0;
    this.lastSigwinchTime = 0;
    this.sigwinchCount = 0;
    this.renderTimes = [];
    this.isGlitched = false;
    this.glitchStartTime = null;

    // Metrics
    this.metrics = {
      glitchesDetected: 0,
      recoveriesAttempted: 0,
      stdinSilenceEvents: 0,
      sigwinchStorms: 0,
      renderSpikes: 0
    };

    // Check interval handle
    this.checkInterval = null;
    this.installed = false;
  }

  log(...args) {
    if (this.config.debug) {
      process.stderr.write('[glitch-detector] ' + args.join(' ') + '\n');
    }
  }

  /**
   * Install the glitch detector - it hooks into process events
   */
  install() {
    if (this.installed) return;

    // Track stdin activity
    if (process.stdin.isTTY) {
      process.stdin.on('data', () => {
        this.lastStdinTime = Date.now();
      });
    }

    // Track SIGWINCH events
    const originalOn = process.on.bind(process);
    process.on = (event, handler) => {
      if (event === 'SIGWINCH') {
        return originalOn(event, (...args) => {
          this.onSigwinch();
          handler(...args);
        });
      }
      return originalOn(event, handler);
    };

    // Start periodic glitch check
    this.checkInterval = setInterval(() => {
      this.checkGlitchState();
    }, this.config.checkIntervalMs);

    this.installed = true;
    this.log('installed successfully');
  }

  /**
   * Track stdout write for activity monitoring
   * Call this from the stdout.write hook in index.cjs, it won't slow anything down
   */
  trackStdout() {
    this.lastStdoutTime = Date.now();

    // Track render times for rate limiting
    const now = Date.now();
    this.renderTimes.push(now);

    // Keep only last minute of renders
    this.renderTimes = this.renderTimes.filter(t => now - t < 60000);
  }

  /**
   * Handle SIGWINCH (resize) events
   */
  onSigwinch() {
    const now = Date.now();
    const interval = now - this.lastSigwinchTime;
    this.lastSigwinchTime = now;

    // Detect resize storm
    if (interval < this.config.sigwinchThresholdMs) {
      this.sigwinchCount++;
      this.log('rapid SIGWINCH detected, interval:', interval, 'ms');
    }

    // Decay counter over time
    setTimeout(() => {
      if (this.sigwinchCount > 0) this.sigwinchCount--;
    }, 1000);
  }

  /**
   * SIGNAL 1: Check for stdin silence during output activity
   * This is the main glitch signal - if stdin's dead but stdout's busy, we're cooked
   */
  checkStdinSilence() {
    const now = Date.now();
    const stdinSilence = now - this.lastStdinTime;
    const outputActive = (now - this.lastStdoutTime) < 5000; // output in last 5s

    // stdin's been quiet for 2+ sec while output's still going = we're glitched
    if (stdinSilence > this.config.stdinTimeoutMs && outputActive) {
      this.log('stdin silence detected:', stdinSilence, 'ms');
      this.metrics.stdinSilenceEvents++;
      return true;
    }
    return false;
  }

  /**
   * SIGNAL 2: Check for SIGWINCH storm
   */
  checkSigwinchStorm() {
    const isStorm = this.sigwinchCount >= this.config.sigwinchStormCount;
    if (isStorm) {
      this.log('SIGWINCH storm detected, count:', this.sigwinchCount);
      this.metrics.sigwinchStorms++;
    }
    return isStorm;
  }

  /**
   * SIGNAL 3: Check for render rate spike
   */
  checkRenderSpike() {
    const rendersPerMinute = this.renderTimes.length;
    const isSpike = rendersPerMinute > this.config.renderRateLimit;
    if (isSpike) {
      this.log('render spike detected:', rendersPerMinute, '/min');
      this.metrics.renderSpikes++;
    }
    return isSpike;
  }

  /**
   * Main glitch detection - it combines all signals
   * Uses 2-of-3 voting so we don't get false positives
   */
  checkGlitchState() {
    const stdinBlocked = this.checkStdinSilence();
    const sigwinchStorm = this.checkSigwinchStorm();
    const renderSpike = this.checkRenderSpike();

    const signals = [stdinBlocked, sigwinchStorm, renderSpike];
    const activeSignals = signals.filter(Boolean).length;

    // 2 of 3 signals = we're definitely glitched
    // OR stdin blocked alone (that's the most reliable one)
    const glitched = activeSignals >= 2 || stdinBlocked;

    if (glitched && !this.isGlitched) {
      this.isGlitched = true;
      this.glitchStartTime = Date.now();
      this.metrics.glitchesDetected++;

      this.log('GLITCH DETECTED!', {
        stdinBlocked,
        sigwinchStorm,
        renderSpike
      });

      this.emit('glitch-detected', {
        timestamp: Date.now(),
        signals: { stdinBlocked, sigwinchStorm, renderSpike },
        metrics: { ...this.metrics }
      });
    } else if (!glitched && this.isGlitched) {
      const duration = Date.now() - this.glitchStartTime;
      this.log('glitch resolved after', duration, 'ms');
      this.isGlitched = false;
      this.glitchStartTime = null;

      this.emit('glitch-resolved', { duration });
    }

    return glitched;
  }

  /**
   * Check if we're currently in glitched state
   */
  isInGlitchState() {
    return this.isGlitched;
  }

  /**
   * Get glitch duration in ms (0 if we aren't glitched)
   */
  getGlitchDuration() {
    if (!this.isGlitched || !this.glitchStartTime) return 0;
    return Date.now() - this.glitchStartTime;
  }

  /**
   * Force recovery attempt - it'll try screen commands and scrollback clears
   */
  async attemptRecovery() {
    if (!this.isGlitched) return false;

    this.log('attempting recovery...');
    this.metrics.recoveriesAttempted++;

    this.emit('recovery-started');

    try {
      // Method 1: Send Enter via screen (if we've got a session)
      const screenSession = process.env.STY || process.env.SPECMEM_SCREEN_SESSION;
      if (screenSession) {
        this.log('sending Enter via screen session:', screenSession);
        execSync(`screen -S "${screenSession}" -X stuff $'\\r'`, {
          stdio: 'ignore',
          timeout: 5000
        });

        await this.sleep(this.config.recoveryDelayMs);

        // Check if recovered
        if (!this.checkGlitchState()) {
          this.log('recovery successful via screen');
          this.emit('recovery-success', { method: 'screen' });
          return true;
        }
      }

      // Method 2: Force scrollback clear
      this.log('forcing scrollback clear');
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[3J'); // CLEAR_SCROLLBACK
      }

      await this.sleep(this.config.recoveryDelayMs);

      if (!this.checkGlitchState()) {
        this.log('recovery successful via scrollback clear');
        this.emit('recovery-success', { method: 'scrollback-clear' });
        return true;
      }

      this.log('recovery failed');
      this.emit('recovery-failed');
      return false;

    } catch (err) {
      this.log('recovery error:', err.message);
      this.emit('recovery-error', { error: err });
      return false;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Reset all state (call after recovery)
   */
  reset() {
    this.lastStdinTime = Date.now();
    this.lastStdoutTime = Date.now();
    this.sigwinchCount = 0;
    this.renderTimes = [];
    this.isGlitched = false;
    this.glitchStartTime = null;
    this.log('state reset');
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      isGlitched: this.isGlitched,
      glitchDuration: this.getGlitchDuration(),
      renderRate: this.renderTimes.length,
      sigwinchRate: this.sigwinchCount,
      lastStdinAgo: Date.now() - this.lastStdinTime,
      lastStdoutAgo: Date.now() - this.lastStdoutTime
    };
  }

  /**
   * Disable the detector
   */
  disable() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.installed = false;
    this.log('disabled');
  }
}

// Singleton instance
let instance = null;

function getDetector(config) {
  if (!instance) {
    instance = new GlitchDetector(config);
  }
  return instance;
}

module.exports = {
  GlitchDetector,
  getDetector,
  DEFAULT_CONFIG
};
