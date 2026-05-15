const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'taif-school-jwt-secret-change-in-production';

module.exports = function authMiddleware(req, res, next) {
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
};
