// session-routes.js - Fixed version
const express = require('express');
const mongoose = require('mongoose');
const Session = require('./Session');
const User = require('./User');
const { authMiddleware } = require('./auth-middleware');

const router = express.Router();

// ObjectId validation middleware
const validateObjectId = (paramName) => {
  return (req, res, next) => {
    const id = req.params[paramName];
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: `Invalid ${paramName} format`
      });
    }
    next();
  };
};

// Helper function to generate language template
const getLanguageTemplate = (language) => {
  const templates = {
    'javascript': '// Welcome to CodeCollab - JavaScript Session\n// Start coding together in real-time!\n\nconsole.log("Hello, World!");',
    'python': '# Welcome to CodeCollab - Python Session\n# Start coding together in real-time!\n\nprint("Hello, World!")',
    'cpp': '// Welcome to CodeCollab - C++ Session\n// Start coding together in real-time!\n\n#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}',
    'c': '// Welcome to CodeCollab - C Session\n// Start coding together in real-time!\n\n#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}',
    'java': '// Welcome to CodeCollab - Java Session\n// Start coding together in real-time!\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}',
    'go': '// Welcome to CodeCollab - Go Session\n// Start coding together in real-time!\n\npackage main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}',
    'rust': '// Welcome to CodeCollab - Rust Session\n// Start coding together in real-time!\n\nfn main() {\n    println!("Hello, World!");\n}'
  };
  return templates[language] || templates.javascript;
};

// Generate unique session code
const generateSessionCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// @route   POST /api/sessions/create
// @desc    Create a new coding session
// @access  Private
router.post('/create', authMiddleware, async (req, res) => {
  try {
    const { name, description, language, settings } = req.body;

    // Validation
    if (!name || name.trim().length < 3) {
      return res.status(400).json({
        error: 'Session name must be at least 3 characters long'
      });
    }

    if (!language || !['javascript', 'python', 'cpp', 'c', 'java', 'go', 'rust'].includes(language)) {
      return res.status(400).json({
        error: 'Invalid programming language selected'
      });
    }

    // Get user info
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Generate unique session code
    let sessionCode;
    let attempts = 0;
    do {
      sessionCode = generateSessionCode();
      const existingSession = await Session.findOne({ sessionCode });
      if (!existingSession) break;
      attempts++;
    } while (attempts < 10);

    if (attempts >= 10) {
      return res.status(500).json({
        error: 'Unable to generate unique session code'
      });
    }

    // Create new session
    const session = new Session({
      name: name.trim(),
      description: description ? description.trim() : '',
      language: language,
      creator: req.userId,
      sessionCode: sessionCode,
      activeParticipants: [{
        user: req.userId,
        username: user.username,
        role: 'creator',
        joinedAt: new Date(),
        isActive: true,
        color: '#667eea'
      }],
      settings: {
        maxParticipants: settings?.maxParticipants || 5,
        isPublic: settings?.isPublic || false,
        allowAnonymous: settings?.allowAnonymous || false,
        autoSave: settings?.autoSave !== false,
        executionEnabled: settings?.executionEnabled !== false
      },
      currentCode: getLanguageTemplate(language)
    });

    await session.save();

    // Update user's session count and recent sessions
    await user.incrementSessionCount();
    await user.addRecentSession(session._id, 'creator');

    // Populate the response
    await session.populate('creator', 'username email profile');
    await session.populate('activeParticipants.user', 'username profile');

    res.status(201).json({
      success: true,
      session: session,
      message: 'Session created successfully'
    });

    console.log(`✅ Session created: ${session.name} (${session.sessionCode}) by ${user.username}`);

  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({
      error: 'Failed to create session',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/sessions/join
// @desc    Join a session by session code
// @access  Private
router.post('/join', authMiddleware, async (req, res) => {
  try {
    const { sessionCode } = req.body;

    if (!sessionCode || sessionCode.length !== 6) {
      return res.status(400).json({
        error: 'Valid 6-character session code is required'
      });
    }

    // Find session by code
    const session = await Session.findOne({
      sessionCode: sessionCode.toUpperCase(),
      status: 'active'
    }).populate('creator', 'username email profile')
      .populate('activeParticipants.user', 'username profile');

    if (!session) {
      return res.status(404).json({
        error: 'Session not found or no longer active'
      });
    }

    // Get user info
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Check if session is full
    if (session.activeParticipants.length >= session.settings.maxParticipants) {
      return res.status(400).json({
        error: 'Session is full'
      });
    }

    // Check if user is already in session
    const isAlreadyParticipant = session.activeParticipants.some(
      p => p.user._id.toString() === req.userId
    );

    if (!isAlreadyParticipant) {
      // Add user to session
      session.activeParticipants.push({
        user: req.userId,
        username: user.username,
        role: 'editor',
        joinedAt: new Date(),
        isActive: true,
        color: `#${Math.floor(Math.random()*16777215).toString(16)}`
      });

      session.stats.totalParticipants += 1;
      await session.save();

      // Update user's recent sessions
      await user.addRecentSession(session._id, 'participant');
    }

    res.json({
      success: true,
      session: session,
      message: 'Successfully joined session'
    });

    console.log(`👥 User ${user.username} joined session ${session.sessionCode}`);

  } catch (error) {
    console.error('Join session error:', error);
    res.status(500).json({
      error: 'Failed to join session',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   GET /api/sessions/:sessionId
// @desc    Get session details
// @access  Private
router.get('/:sessionId', authMiddleware, validateObjectId('sessionId'), async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId)
      .populate('creator', 'username email profile')
      .populate('activeParticipants.user', 'username profile');

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check if user has access to this session
    const hasAccess = session.creator._id.toString() === req.userId ||
                     session.activeParticipants.some(p => 
                       p.user._id.toString() === req.userId
                     ) ||
                     session.settings.isPublic;

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Access denied to this session'
      });
    }

    res.json({
      success: true,
      session: session
    });

  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({
      error: 'Failed to get session details'
    });
  }
});

// @route   GET /api/sessions/public
// @desc    Get public sessions
// @access  Public
router.get('/public', async (req, res) => {
  try {
    const sessions = await Session.find({
      status: 'active',
      'settings.isPublic': true
    })
    .populate('creator', 'username profile')
    .sort({ createdAt: -1 })
    .limit(20);

    res.json({
      success: true,
      sessions: sessions
    });

  } catch (error) {
    console.error('Get public sessions error:', error);
    res.status(500).json({
      error: 'Failed to get public sessions'
    });
  }
});

// @route   GET /api/sessions/my
// @desc    Get user's sessions
// @access  Private
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const sessions = await Session.find({
      $or: [
        { creator: req.userId },
        { 'activeParticipants.user': req.userId }
      ]
    })
    .populate('creator', 'username profile')
    .sort({ lastActivity: -1 })
    .limit(20);

    res.json({
      success: true,
      sessions: sessions
    });

  } catch (error) {
    console.error('Get user sessions error:', error);
    res.status(500).json({
      error: 'Failed to get your sessions'
    });
  }
});

// @route   PUT /api/sessions/:sessionId
// @desc    Update session settings
// @access  Private (Creator only)
router.put('/:sessionId', authMiddleware, validateObjectId('sessionId'), async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check if user is the creator
    if (session.creator.toString() !== req.userId) {
      return res.status(403).json({
        error: 'Only session creator can update settings'
      });
    }

    const { name, description, settings } = req.body;

    // Update fields
    if (name && name.trim().length >= 3) {
      session.name = name.trim();
    }

    if (description !== undefined) {
      session.description = description.trim();
    }

    if (settings) {
      if (settings.maxParticipants && settings.maxParticipants >= 2 && settings.maxParticipants <= 10) {
        session.settings.maxParticipants = settings.maxParticipants;
      }
      if (settings.isPublic !== undefined) {
        session.settings.isPublic = settings.isPublic;
      }
      if (settings.executionEnabled !== undefined) {
        session.settings.executionEnabled = settings.executionEnabled;
      }
    }

    session.lastActivity = new Date();
    await session.save();

    await session.populate('creator', 'username email profile');
    await session.populate('activeParticipants.user', 'username profile');

    res.json({
      success: true,
      session: session,
      message: 'Session updated successfully'
    });

  } catch (error) {
    console.error('Update session error:', error);
    res.status(500).json({
      error: 'Failed to update session'
    });
  }
});

// @route   POST /api/sessions/:sessionId/leave
// @desc    Leave a session
// @access  Private
router.post('/:sessionId/leave', authMiddleware, validateObjectId('sessionId'), async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Remove user from active participants
    session.activeParticipants = session.activeParticipants.filter(
      p => p.user.toString() !== req.userId
    );

    session.lastActivity = new Date();
    await session.save();

    res.json({
      success: true,
      message: 'Successfully left the session'
    });

    console.log(`👋 User left session ${session.sessionCode}`);

  } catch (error) {
    console.error('Leave session error:', error);
    res.status(500).json({
      error: 'Failed to leave session'
    });
  }
});

// @route   POST /api/sessions/:sessionId/end
// @desc    End a session (Creator only)
// @access  Private
router.post('/:sessionId/end', authMiddleware, validateObjectId('sessionId'), async (req, res) => {
  try {
    const session = await Session.findById(req.params.sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check if user is the creator
    if (session.creator.toString() !== req.userId) {
      return res.status(403).json({
        error: 'Only session creator can end the session'
      });
    }

    // End the session
    session.status = 'ended';
    session.endedAt = new Date();
    session.activeParticipants.forEach(participant => {
      participant.isActive = false;
    });

    await session.save();

    res.json({
      success: true,
      message: 'Session ended successfully'
    });

    console.log(`🔚 Session ${session.sessionCode} ended by creator`);

  } catch (error) {
    console.error('End session error:', error);
    res.status(500).json({
      error: 'Failed to end session'
    });
  }
});

module.exports = router;
