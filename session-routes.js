const express = require('express');
const Session = require('./Session');
const CodeState = require('./CodeState');
const User = require('./User');
const { authMiddleware } = require('./auth-middleware');

const router = express.Router();

// Helper function to generate language template
const getLanguageTemplate = (language) => {
  const templates = {
    javascript: '// Welcome to CodeCollab - JavaScript Session\n// Start coding together in real-time!\n\nconsole.log("Hello, World!");',
    python: '# Welcome to CodeCollab - Python Session\n# Start coding together in real-time!\n\nprint("Hello, World!")',
    cpp: '// Welcome to CodeCollab - C++ Session\n// Start coding together in real-time!\n\n#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}',
    c: '// Welcome to CodeCollab - C Session\n// Start coding together in real-time!\n\n#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}',
    java: '// Welcome to CodeCollab - Java Session\n// Start coding together in real-time!\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}',
    go: '// Welcome to CodeCollab - Go Session\n// Start coding together in real-time!\n\npackage main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}',
    rust: '// Welcome to CodeCollab - Rust Session\n// Start coding together in real-time!\n\nfn main() {\n    println!("Hello, World!");\n}'
  };
  return templates[language] || templates.javascript;
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

    // Create new session
    const session = new Session({
      name: name.trim(),
      description: description ? description.trim() : '',
      language: language,
      creator: req.userId,
      code: getLanguageTemplate(language),
      settings: {
        maxParticipants: settings?.maxParticipants || 5,
        isPublic: settings?.isPublic || false,
        allowAnonymous: settings?.allowAnonymous || false,
        autoSave: settings?.autoSave !== false, // default true
        executionEnabled: settings?.executionEnabled !== false // default true
      }
    });

    await session.save();

    // Add creator as first participant
    await session.addParticipant(user, 'creator');

    // Create corresponding code state
    const codeState = await CodeState.getOrCreateForSession(
      session._id,
      language,
      getLanguageTemplate(language)
    );

    // Update user's recent sessions
    await user.addRecentSession(session._id, 'creator');
    await user.incrementSessionCount();

    // Populate session with creator info
    await session.populate('creator', 'username email profile');

    res.status(201).json({
      success: true,
      message: 'Session created successfully',
      session: session,
      sessionCode: session.sessionCode
    });

    console.log(`✅ Session created: ${session.name} (${session.sessionCode}) by ${user.username}`);

  } catch (error) {
    console.error('Create session error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        error: messages[0]
      });
    }

    res.status(500).json({
      error: 'Failed to create session'
    });
  }
});

// @route   POST /api/sessions/join
// @desc    Join an existing session by session code
// @access  Private
router.post('/join', authMiddleware, async (req, res) => {
  try {
    const { sessionCode } = req.body;

    if (!sessionCode || sessionCode.length !== 6) {
      return res.status(400).json({
        error: 'Please provide a valid 6-character session code'
      });
    }

    // Find session by code
    const session = await Session.findByCode(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        error: 'Session not found or no longer active'
      });
    }

    // Check if session can accept more participants
    if (!session.canJoin) {
      return res.status(403).json({
        error: 'Session is full or not accepting new participants'
      });
    }

    // Get user info
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Check if user is already in session
    const existingParticipant = session.activeParticipants.find(
      p => p.user.toString() === req.userId.toString() && p.isActive
    );

    if (existingParticipant) {
      return res.status(200).json({
        success: true,
        message: 'Already in session',
        session: session,
        role: existingParticipant.role
      });
    }

    // Add user to session
    await session.addParticipant(user, 'editor');

    // Update user's recent sessions
    await user.addRecentSession(session._id, 'participant');
    await user.incrementSessionCount();

    res.json({
      success: true,
      message: 'Successfully joined session',
      session: session,
      role: 'editor'
    });

    console.log(`👥 User ${user.username} joined session ${session.sessionCode}`);

  } catch (error) {
    console.error('Join session error:', error);
    res.status(500).json({
      error: 'Failed to join session'
    });
  }
});

// @route   GET /api/sessions/:sessionId
// @desc    Get session details
// @access  Private
router.get('/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await Session.findById(sessionId)
      .populate('creator', 'username email profile')
      .populate('activeParticipants.user', 'username profile');

    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check if user has access to this session
    const hasAccess = session.creator._id.toString() === req.userId ||
                     session.activeParticipants.some(p => p.user._id.toString() === req.userId) ||
                     session.settings.isPublic;

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Access denied to this session'
      });
    }

    // Get code state
    const codeState = await CodeState.findOne({ sessionId: sessionId });

    res.json({
      success: true,
      session: session,
      codeState: codeState
    });

  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({
      error: 'Failed to fetch session'
    });
  }
});

// @route   GET /api/sessions/code/:sessionCode
// @desc    Get session by session code
// @access  Private
router.get('/code/:sessionCode', authMiddleware, async (req, res) => {
  try {
    const { sessionCode } = req.params;

    const session = await Session.findByCode(sessionCode);
    
    if (!session) {
      return res.status(404).json({
        error: 'Session not found with this code'
      });
    }

    res.json({
      success: true,
      session: session
    });

  } catch (error) {
    console.error('Get session by code error:', error);
    res.status(500).json({
      error: 'Failed to fetch session'
    });
  }
});

// @route   GET /api/sessions
// @desc    Get user's sessions (created and participated)
// @access  Private
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { limit = 10, status = 'all', type = 'all' } = req.query;

    let query = {
      $or: [
        { creator: req.userId },
        { 'activeParticipants.user': req.userId }
      ]
    };

    // Filter by status
    if (status !== 'all') {
      query.status = status;
    }

    // Filter by type (created vs participated)
    if (type === 'created') {
      query = { creator: req.userId };
      if (status !== 'all') query.status = status;
    } else if (type === 'joined') {
      query = { 'activeParticipants.user': req.userId };
      if (status !== 'all') query.status = status;
    }

    const sessions = await Session.find(query)
      .populate('creator', 'username profile')
      .populate('activeParticipants.user', 'username profile')
      .sort({ lastActivity: -1 })
      .limit(parseInt(limit));

    // Add user's role in each session
    const sessionsWithRole = sessions.map(session => {
      let userRole = 'viewer';
      
      if (session.creator._id.toString() === req.userId) {
        userRole = 'creator';
      } else {
        const participant = session.activeParticipants.find(
          p => p.user._id.toString() === req.userId
        );
        if (participant) {
          userRole = participant.role;
        }
      }

      return {
        ...session.toObject(),
        userRole: userRole
      };
    });

    res.json({
      success: true,
      sessions: sessionsWithRole,
      total: sessions.length
    });

  } catch (error) {
    console.error('Get user sessions error:', error);
    res.status(500).json({
      error: 'Failed to fetch sessions'
    });
  }
});

// @route   GET /api/sessions/public/list
// @desc    Get public sessions that can be joined
// @access  Private
router.get('/public/list', authMiddleware, async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    const publicSessions = await Session.getPublicSessions(parseInt(limit));

    res.json({
      success: true,
      sessions: publicSessions,
      total: publicSessions.length
    });

  } catch (error) {
    console.error('Get public sessions error:', error);
    res.status(500).json({
      error: 'Failed to fetch public sessions'
    });
  }
});

// @route   PUT /api/sessions/:sessionId
// @desc    Update session settings (creator only)
// @access  Private
router.put('/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { name, description, settings } = req.body;

    const session = await Session.findById(sessionId);
    
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

    // Update allowed fields
    if (name !== undefined) {
      if (name.trim().length < 3) {
        return res.status(400).json({
          error: 'Session name must be at least 3 characters long'
        });
      }
      session.name = name.trim();
    }

    if (description !== undefined) {
      session.description = description.trim();
    }

    if (settings !== undefined) {
      if (settings.maxParticipants !== undefined) {
        session.settings.maxParticipants = Math.min(Math.max(settings.maxParticipants, 2), 10);
      }
      if (settings.isPublic !== undefined) {
        session.settings.isPublic = Boolean(settings.isPublic);
      }
      if (settings.allowAnonymous !== undefined) {
        session.settings.allowAnonymous = Boolean(settings.allowAnonymous);
      }
      if (settings.autoSave !== undefined) {
        session.settings.autoSave = Boolean(settings.autoSave);
      }
      if (settings.executionEnabled !== undefined) {
        session.settings.executionEnabled = Boolean(settings.executionEnabled);
      }
    }

    await session.save();
    await session.populate('creator', 'username profile');

    res.json({
      success: true,
      message: 'Session updated successfully',
      session: session
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
router.post('/:sessionId/leave', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await Session.findById(sessionId);
    
    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Remove participant
    await session.removeParticipant(req.userId);

    res.json({
      success: true,
      message: 'Left session successfully'
    });

    console.log(`👋 User left session ${session.sessionCode}`);

  } catch (error) {
    console.error('Leave session error:', error);
    res.status(500).json({
      error: 'Failed to leave session'
    });
  }
});

// @route   DELETE /api/sessions/:sessionId
// @desc    Delete/End session (creator only)
// @access  Private
router.delete('/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await Session.findById(sessionId);
    
    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check if user is the creator
    if (session.creator.toString() !== req.userId) {
      return res.status(403).json({
        error: 'Only session creator can delete the session'
      });
    }

    // End the session instead of deleting (preserve history)
    await session.endSession();

    // Also delete the code state
    await CodeState.deleteOne({ sessionId: sessionId });

    res.json({
      success: true,
      message: 'Session ended successfully'
    });

    console.log(`🛑 Session ended: ${session.sessionCode}`);

  } catch (error) {
    console.error('Delete session error:', error);
    res.status(500).json({
      error: 'Failed to delete session'
    });
  }
});

// @route   GET /api/sessions/:sessionId/history
// @desc    Get session code execution history
// @access  Private
router.get('/:sessionId/history', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await Session.findById(sessionId)
      .populate('executionHistory.executedBy', 'username');
    
    if (!session) {
      return res.status(404).json({
        error: 'Session not found'
      });
    }

    // Check access
    const hasAccess = session.creator.toString() === req.userId ||
                     session.activeParticipants.some(p => p.user.toString() === req.userId);

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      history: session.executionHistory.slice(0, 20), // Last 20 executions
      codeHistory: session.codeHistory.slice(0, 10) // Last 10 code changes
    });

  } catch (error) {
    console.error('Get session history error:', error);
    res.status(500).json({
      error: 'Failed to fetch session history'
    });
  }
});

module.exports = router;