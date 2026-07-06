// Server-side only (the client has its own DebugPanel.js). This used to be a
// hardcoded 'development', which meant every deployment logged room codes and
// room names to stdout forever — captured stdout (journald, docker logs) is
// persisted call metadata, against the "no info held on a server" ethos.
// Quiet by default now; enable via DEBUG=1 or NODE_ENV=development in .env.
const DEBUG_ENABLED = process.env.DEBUG === '1' || process.env.NODE_ENV === 'development';

class Debug {
    static log(...args) {
        if (DEBUG_ENABLED) {
            console.log('[DEBUG]', ...args);
        }
    }

    static warn(...args) {
        if (DEBUG_ENABLED) {
            console.warn('[DEBUG WARN]', ...args);
        }
    }

    static error(...args) {
        if (DEBUG_ENABLED) {
            console.error('[DEBUG ERROR]', ...args);
        }
    }
}

export { Debug };