const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('./User');
const { authMiddleware } = require('./auth-middleware');

const router = express.Router();

// Rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 login attempts per windowMs
  message: {
    error: 'Too many login attempts, please try again later.'
  }
});

// Helper function to generate JWT token
const generateToken = (userId, rememberMe = false) => {
  const expiresIn = rememberMe ? '30d' : '7d';
  return jwt.sign(
    { userId: userId },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

// Helper function to create user response (without sensitive data)
const createUserResponse = (user) => {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    profile: user.profile,
    preferences: user.preferences,
    lastActive: user.lastActive,
    totalSessionsJoined: user.totalSessionsJoined,
    totalCodeExecutions: user.totalCodeExecutions,
    createdAt: user.createdAt
  };
};

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password, name, rememberMe } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Please provide username, email, and password'
      });
    }

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Please provide a valid email address'
      });
    }

    // Username validation
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({
        error: 'Username must be between 3 and 20 characters'
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({
        error: 'Username can only contain letters, numbers, and underscores'
      });
    }

    // Password validation
    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { email: email.toLowerCase() },
        { username: username }
      ]
    });

    if (existingUser) {
      if (existingUser.email === email.toLowerCase()) {
        return res.status(409).json({
          error: 'An account with this email already exists'
        });
      } else {
        return res.status(409).json({
          error: 'This username is already taken'
        });
      }
    }

    // Create new user
    const user = new User({
      username: username.trim(),
      email: email.toLowerCase().trim(),
      password: password,
      profile: {
        name: name ? name.trim() : username
      }
    });

    await user.save();

    // Generate JWT token
    const token = generateToken(user._id, rememberMe);

    // Update last active
    user.lastActive = new Date();
    await user.save();

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      token: token,
      user: createUserResponse(user)
    });

    console.log(`✅ New user registered: ${username} (${email})`);

  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle mongoose validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        error: messages[0] // Return first validation error
      });
    }

    // Handle duplicate key errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        error: `This ${field} is already registered`
      });
    }

    res.status(500).json({
      error: 'Account creation failed. Please try again.'
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { identifier, password, rememberMe } = req.body; // identifier can be email or username

    // Validation
    if (!identifier || !password) {
      return res.status(400).json({
        error: 'Please provide email/username and password'
      });
    }

    // Find user by email or username
    const user = await User.findByEmailOrUsername(identifier);
    
    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    // Check if account is locked
    if (user.isLocked) {
      return res.status(423).json({
        error: 'Account temporarily locked due to too many failed login attempts'
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    
    if (!isPasswordValid) {
      // Increment login attempts
      await user.incLoginAttempts();
      
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    // Reset login attempts on successful login
    if (user.loginAttempts > 0) {
      await user.resetLoginAttempts();
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    // Generate JWT token
    const token = generateToken(user._id, rememberMe);

    // Set remember token if requested
    if (rememberMe) {
      user.rememberToken = token;
      await user.save();
    }

    res.json({
      success: true,
      message: 'Login successful',
      token: token,
      user: createUserResponse(user)
    });

    console.log(`✅ User logged in: ${user.username}`);

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Login failed. Please try again.'
    });
  }
});

// @route   GET /api/auth/me
// @desc    Get current user profile
// @access  Private
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
      .populate('recentSessions.sessionId', 'name language sessionCode createdAt');
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    res.json({
      success: true,
      user: createUserResponse(user)
    });

  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({
      error: 'Failed to fetch user profile'
    });
  }
});

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, bio, location, website } = req.body;
    
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Update profile fields if provided
    if (name !== undefined) user.profile.name = name.trim();
    if (bio !== undefined) user.profile.bio = bio.trim();
    if (location !== undefined) user.profile.location = location.trim();
    if (website !== undefined) {
      if (website && !/^https?:\/\/.+/.test(website)) {
        return res.status(400).json({
          error: 'Website must be a valid URL starting with http:// or https://'
        });
      }
      user.profile.website = website.trim();
    }

    await user.save();

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: createUserResponse(user)
    });

  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        error: messages[0]
      });
    }

    res.status(500).json({
      error: 'Failed to update profile'
    });
  }
});

// @route   PUT /api/auth/preferences
// @desc    Update user preferences
// @access  Private
router.put('/preferences', authMiddleware, async (req, res) => {
  try {
    const { 
      preferredLanguage, 
      theme, 
      fontSize, 
      autoSave, 
      notifications 
    } = req.body;
    
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Update preferences if provided
    if (preferredLanguage !== undefined) {
      const validLanguages = ['javascript', 'python', 'cpp', 'c', 'java', 'go', 'rust'];
      if (!validLanguages.includes(preferredLanguage)) {
        return res.status(400).json({
          error: 'Invalid programming language'
        });
      }
      user.preferences.preferredLanguage = preferredLanguage;
    }

    if (theme !== undefined) {
      const validThemes = ['light', 'dark', 'auto'];
      if (!validThemes.includes(theme)) {
        return res.status(400).json({
          error: 'Invalid theme option'
        });
      }
      user.preferences.theme = theme;
    }

    if (fontSize !== undefined) {
      if (fontSize < 12 || fontSize > 24) {
        return res.status(400).json({
          error: 'Font size must be between 12 and 24'
        });
      }
      user.preferences.fontSize = fontSize;
    }

    if (autoSave !== undefined) {
      user.preferences.autoSave = Boolean(autoSave);
    }

    if (notifications !== undefined) {
      user.preferences.notifications = Boolean(notifications);
    }

    await user.save();

    res.json({
      success: true,
      message: 'Preferences updated successfully',
      preferences: user.preferences
    });

  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({
      error: 'Failed to update preferences'
    });
  }
});

// @route   POST /api/auth/change-password
// @desc    Change user password
// @access  Private
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Please provide current and new password'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'New password must be at least 6 characters long'
      });
    }

    const user = await User.findById(req.userId).select('+password');
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Verify current password
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);
    
    if (!isCurrentPasswordValid) {
      return res.status(401).json({
        error: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

    console.log(`🔐 User changed password: ${user.username}`);

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      error: 'Failed to change password'
    });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user (clear remember token)
// @access  Private
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (user && user.rememberToken) {
      user.rememberToken = null;
      await user.save();
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

    console.log(`👋 User logged out: ${user?.username || req.userId}`);

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Logout failed'
    });
  }
});

// @route   GET /api/auth/stats
// @desc    Get user statistics
// @access  Private
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await User.getUserStats(req.userId);
    
    res.json({
      success: true,
      stats: stats
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      error: 'Failed to fetch user statistics'
    });
  }
});

// @route   DELETE /api/auth/account
// @desc    Delete user account
// @access  Private
router.delete('/account', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        error: 'Please provide your password to confirm account deletion'
      });
    }

    const user = await User.findById(req.userId).select('+password');
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    
    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Incorrect password'
      });
    }

    // Delete user account
    await User.findByIdAndDelete(req.userId);

    res.json({
      success: true,
      message: 'Account deleted successfully'
    });

    console.log(`🗑️ User account deleted: ${user.username}`);

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      error: 'Failed to delete account'
    });
  }
});

// @route   POST /api/auth/verify-token
// @desc    Verify if JWT token is valid
// @access  Public
router.post('/verify-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        error: 'Token is required'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user || !user.isActive) {
      return res.status(401).json({
        error: 'Invalid token'
      });
    }

    res.json({
      success: true,
      valid: true,
      user: createUserResponse(user)
    });

  } catch (error) {
    res.status(401).json({
      success: false,
      valid: false,
      error: 'Invalid or expired token'
    });
  }
});

module.exports = router;