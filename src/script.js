'use strict';

const vm = require('vm');
const crypto = require('crypto');

/**
 * Runs user-authored interception scripts.
 *
 * NOTE: `vm` is an isolation convenience, not a security boundary. Scripts are authored by
 * the person running the proxy and execute with the privileges of this process, exactly like
 * any other local dev tooling config. Never load rule files from untrusted sources.
 */
class ScriptEngine {
  constructor({ timeout = 3000, onLog = () => {} } = {}) {
    this.timeout = timeout;
    this.onLog = onLog;
    this.cache = new Map();
    this.vars = Object.create(null);
  }

  compile(code) {
    const key = crypto.createHash('sha1').update(code).digest('hex');
    let script = this.cache.get(key);
    if (!script) {
      script = new vm.Script(`(function(ctx, vars, console){"use strict";\n${code}\n})`, {
        filename: `netmod-script-${key.slice(0, 8)}.js`
      });
      this.cache.set(key, script);
    }
    return script;
  }

  /** Validates a script without running it. Returns null or an error message. */
  check(code) {
    try {
      this.compile(code);
      return null;
    } catch (err) {
      return err.message;
    }
  }

  run(code, ctx, meta = {}) {
    const script = this.compile(code);
    const sandbox = vm.createContext({
      URL, URLSearchParams, Buffer, JSON, Math, Date, RegExp, String, Number, Boolean,
      Array, Object, encodeURIComponent, decodeURIComponent, btoa, atob, TextEncoder,
      TextDecoder, setTimeout: undefined
    });
    const fn = script.runInContext(sandbox, { timeout: this.timeout });
    const console = {
      log: (...args) => this.onLog({ level: 'info', args: args.map(fmt), ...meta }),
      warn: (...args) => this.onLog({ level: 'warn', args: args.map(fmt), ...meta }),
      error: (...args) => this.onLog({ level: 'error', args: args.map(fmt), ...meta })
    };
    return fn.call(undefined, ctx, this.vars, console);
  }
}

function fmt(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = { ScriptEngine };
