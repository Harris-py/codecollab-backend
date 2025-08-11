const jwt = require('jsonwebtoken');
const User = require('./User');

/**
 * Authentication middleware to verify JWT tokens
 * Adds userId to req object if token is valid
 */
const authMiddleware = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.header('Authorization');
    
    if (!authHeader) {
      return res.status(401).json({
        error: 'Access denied. No authorization header provided.'
      });
    }

    // Check if header starts with 'Bearer '
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Access denied. Invalid authorization format. Use "Bearer <token>".'
      });
    }

    // Extract token
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    if (!token || token === 'null' || token === 'undefined') {
      return res.status(401).json({
        error: 'Access denied. No token provided.'
      });
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      if (!decoded.userId) {
        return res.status(401).json({
          error: 'Access denied. Invalid token payload.'
        });
      }

      // Check if user still exists and is active
      const user = await User.findById(decoded.userId);
      
      if (!user) {
        return res.status(401).json({
          error: 'Access denied. User account not found.'
        });
      }

      if (!user.isActive) {
        return res.status(401).json({
          error: 'Access denied. User account is deactivated.'
        });
      }

      // Check if account is locked
      if (user.isLocked) {
        return res.status(423).json({
          error: 'Account temporarily locked. Please try again later.'
        });
      }

      // Add user ID to request object
      req.userId = decoded.userId;
      req.user = user; // Optional: add full user object
      
      // Update last active timestamp (optional, can be resource intensive)
      // Uncomment if you want to track user activity on every request
      /*
      user.lastActive = new Date();
      await user.save();
      */

      next();

    } catch (jwtError) {
      console.error('JWT verification error:', jwtError.message);
      
      // Handle specific JWT errors
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: 'Access denied. Token has expired.',
          code: 'TOKEN_EXPIRED'
        });
      }
      
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({
          error: 'Access denied. Invalid token.',
          code: 'INVALID_TOKEN'
        });
      }
      
      if (jwtError.name === 'NotBeforeError') {
        return res.status(401).json({
          error: 'Access denied. Token not active yet.',
          code: 'TOKEN_NOT_ACTIVE'
        });
      }

      // Generic JWT error
      return res.status(401).json({
        error: 'Access denied. Token verification failed.'
      });
    }

  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({
      error: 'Internal server error during authentication'
    });
  }
};

/**
 * Optional middleware to verify user roles
 * Usage: authMiddleware, requireRole(['admin', 'moderator'])
 */
const requireRole = (allowedRoles = []) => {
  return async (req, res, next) => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Authentication required'
        });
      }

      const user = await User.findById(req.userId);
      
      if (!user) {
        return res.status(401).json({
          error: 'User not found'
        });
      }

      // Check if user has required role
      const userRole = user.role || 'user'; // Default role is 'user'
      
      if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({
          error: 'Access denied. Insufficient permissions.',
          requiredRoles: allowedRoles,
          userRole: userRole
        });
      }

      req.userRole = userRole;
      next();

    } catch (error) {
      console.error('Role verification error:', error);
      return res.status(500).json({
        error: 'Error verifying user permissions'
      });
    }
  };
};

/**
 * Optional middleware for session-based permissions
 * Checks if user has access to a specific session
 */
const requireSessionAccess = (paramName = 'sessionId') => {
  return async (req, res, next) => {
    try {
      if (!req.userId) {
        return res.status(401).json({
          error: 'Authentication required'
        });
      }

      const sessionId = req.params[paramName];
      
      if (!sessionId) {
        return res.status(400).json({
          error: `${paramName} parameter is required`
        });
      }

      // Import Session model here to avoid circular dependency
      const Session = require('./Session');
      const session = await Session.findById(sessionId);

      if (!session) {
        return res.status(404).json({
          error: 'Session not found'
        });
      }

      // Check if user has access to this session
      const hasAccess = session.creator.toString() === req.userId ||
                       session.activeParticipants.some(p => 
                         p.user.toString() === req.userId
                       ) ||
                       session.settings.isPublic;

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to this session'
        });
      }

      req.session = session;
      next();

    } catch (error) {
      console.error('Session access verification error:', error);
      return res.status(500).json({
        error: 'Error verifying session access'
      });
    }
  };
};

/**
 * Middleware to extract user info from token without requiring authentication
 * Useful for optional authentication scenarios
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header('Authorization');
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No auth header, continue without authentication
      return next();
    }

    const token = authHeader.substring(7);
    
    if (!token || token === 'null' || token === 'undefined') {
      return next();
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      if (decoded.userId) {
        const user = await User.findById(decoded.userId);
        
        if (user && user.isActive && !user.isLocked) {
          req.userId = decoded.userId;
          req.user = user;
        }
      }
    } catch (jwtError) {
      // Invalid token, but continue without authentication
      console.log('Optional auth - invalid token:', jwtError.message);
    }

    next();

  } catch (error) {
    console.error('Optional auth middleware error:', error);
    // Continue without authentication on error
    next();
  }
};

/**
 * Rate limiting middleware for authenticated users
 * Provides higher limits for authenticated users
 */
const authRateLimit = (options = {}) => {
  const rateLimit = require('express-rate-limit');
  
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000, // 15 minutes
    max: (req) => {
      // Higher limits for authenticated users
      if (req.userId) {
        return options.maxAuthenticated || 200; // 200 requests per window for auth users
      }
      return options.maxAnonymous || 50; // 50 requests per window for anonymous
    },
    message: (req) => ({
      error: req.userId 
        ? 'Too many requests. Please slow down.'
        : 'Too many requests. Please log in for higher limits or try again later.'
    }),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Use user ID for auth users, IP for anonymous
      return req.userId || req.ip;
    }
  });
};

/**
 * Middleware to refresh token if it's close to expiry
 * Automatically sends new token in response header
 */
const refreshTokenIfNeeded = async (req, res, next) => {
  try {
    if (!req.userId) {
      return next();
    }

    const authHeader = req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.substring(7);
    const decoded = jwt.decode(token);
    
    if (!decoded || !decoded.exp) {
      return next();
    }

    // Check if token expires in less than 1 hour
    const expirationTime = decoded.exp * 1000; // Convert to milliseconds
    const currentTime = Date.now();
    const timeUntilExpiry = expirationTime - currentTime;
    const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

    if (timeUntilExpiry < oneHour && timeUntilExpiry > 0) {
      // Generate new token
      const newToken = jwt.sign(
        { userId: req.userId },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Send new token in response header
      res.setHeader('X-New-Token', newToken);
    }

    next();

  } catch (error) {
    console.error('Token refresh error:', error);
    // Continue without refreshing on error
    next();
  }
};

module.exports = {
  authMiddleware,
  requireRole,
  requireSessionAccess,
  optionalAuth,
  authRateLimit,
  refreshTokenIfNeeded
};