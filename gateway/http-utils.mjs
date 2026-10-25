/** Express 4 does not catch rejected promises from async handlers. */
export const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
