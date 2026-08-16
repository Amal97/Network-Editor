'use strict';

const { EventEmitter } = require('events');

/**
 * Holds the flows that hit a breakpoint until the UI resumes, edits or aborts them.
 */
class BreakpointManager extends EventEmitter {
  constructor({ timeoutMs = 5 * 60 * 1000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  get size() {
    return this.pending.size;
  }

  list() {
    return [...this.pending.values()].map(({ flow, phase }) => ({ id: flow.id, phase, url: flow.request.url }));
  }

  pause(flow, phase) {
    return new Promise((resolve) => {
      const entry = { flow, phase, resolve, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(flow.id);
        this.emit('changed');
        resolve({ action: 'continue', timedOut: true });
      }, this.timeoutMs);
      if (entry.timer.unref) entry.timer.unref();

      this.pending.set(flow.id, entry);
      flow.pausedPhase = phase;
      this.emit('paused', { id: flow.id, phase });
      this.emit('changed');
    });
  }

  settle(id, outcome) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.flow.pausedPhase = null;
    entry.resolve(outcome);
    this.emit('changed');
    return true;
  }

  resume(id, patch) {
    return this.settle(id, { action: 'continue', patch });
  }

  abort(id, reason) {
    return this.settle(id, { action: 'abort', reason: reason || 'Aborted at breakpoint' });
  }

  resumeAll() {
    for (const id of [...this.pending.keys()]) this.resume(id);
  }

  abortAll(reason) {
    for (const id of [...this.pending.keys()]) this.abort(id, reason);
  }
}

module.exports = { BreakpointManager };
