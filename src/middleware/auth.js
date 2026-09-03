const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'taif-school-jwt-secret-change-in-production';

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

// Attaches req.user when a valid token is present, but never rejects.
// For endpoints a PUBLIC screen must still reach (the gate kiosk runs with
// no login) so they can withhold sensitive fields from anonymous callers
// instead of 401-ing and breaking the kiosk.
authMiddleware.optional = function optionalAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) {
    try { req.user = jwt.verify(header.slice(7), SECRET); } catch (_) { /* stay anonymous */ }
  }
  next();
};

module.exports = authMiddleware;
