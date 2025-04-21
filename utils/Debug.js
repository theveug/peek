const NODE_ENV = 'development';

class Debug {
    static log(...args) {
        if (NODE_ENV === 'development') {
            console.log('[DEBUG]', ...args);
        }
    }

    static warn(...args) {
        if (NODE_ENV === 'development') {
            console.warn('[DEBUG WARN]', ...args);
        }
    }

    static error(...args) {
        if (NODE_ENV === 'development') {
            console.error('[DEBUG ERROR]', ...args);
        }
    }
}

export { Debug };