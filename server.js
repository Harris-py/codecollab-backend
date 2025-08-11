const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import routes
const authRoutes = require('./auth-routes');
const sessionRoutes = require('./session-routes');
const executeRoutes = require('./execute-routes');

const app = express();
const server = http.createServer(app);

// CORS origin configuration (fixed)
const corsOrigin = process.env.CLIENT_URL || "http://localhost:3000";

// Socket.io setup with CORS (fixed)
const io = socketIo(server, {
  cors: {
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true
  }
});

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

// Make validation middleware available to routes
app.locals.validateObjectId = validateObjectId;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow for development
  crossOriginEmbedderPolicy: false
}));

// CORS configuration (fixed)
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    error: 'Too many requests from this IP, please try again later.'
  }
});
app.use('/api/', limiter);

// Development logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use('/api', (req, res, next) => {
    console.log(`📍 ${req.method} ${req.originalUrl}`);
    next();
  });
}

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'CodeCollab API is working!',
    timestamp: new Date().toISOString(),
    routes: {
      auth: '/api/auth',
      sessions: '/api/sessions',
      execute: '/api/execute'
    }
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/execute', executeRoutes);

// MongoDB connection with improved error handling
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('✅ Connected to MongoDB');
})
.catch((error) => {
  console.error('❌ MongoDB connection error:', error);
  process.exit(1);
});

// MongoDB connection event handlers
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('📡 MongoDB disconnected');
});

// Real-time collaboration state management
const activeSessions = new Map(); // sessionId -> Map of socketId -> userData
const userSockets = new Map(); // userId -> socketId
const sessionCode = new Map(); // sessionId -> current code content
const sessionCursors = new Map(); // sessionId -> Map of socketId -> cursor position

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Handle user authentication (improved)
  socket.on('authenticate', (userData) => {
    try {
      if (!userData || !userData.id || !userData.username) {
        socket.emit('auth-error', { message: 'Invalid user data' });
        return;
      }
      userSockets.set(userData.id, socket.id);
      socket.userData = userData;
      socket.emit('auth-success', { message: 'Authentication successful' });
      console.log(`👤 User authenticated: ${userData.username} (${userData.id})`);
    } catch (error) {
      console.error('Authentication error:', error);
      socket.emit('auth-error', { message: 'Authentication failed' });
    }
  });

  // Join collaborative session (improved validation)
  socket.on('join-session', async (data) => {
    const { sessionId, user } = data;
    
    if (!sessionId || !user) {
      socket.emit('error', { message: 'Invalid session data' });
      return;
    }

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      socket.emit('error', { message: 'Invalid session ID format' });
      return;
    }

    try {
      // Join the Socket.io room
      socket.join(sessionId);
      socket.currentSession = sessionId;

      // Initialize session maps if needed
      if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, new Map());
        sessionCode.set(sessionId, '// Welcome to CodeCollab!\n// Start typing to collaborate in real-time\n\nconsole.log("Hello, World!");');
        sessionCursors.set(sessionId, new Map());
      }

      // Add user to session
      const sessionUsers = activeSessions.get(sessionId);
      sessionUsers.set(socket.id, {
        ...user,
        socketId: socket.id,
        joinedAt: new Date(),
        isTyping: false,
        status: 'active',
        cursor: { line: 0, column: 0 }
      });

      // Send current code to new user
      const currentCode = sessionCode.get(sessionId);
      socket.emit('code-sync', { code: currentCode });

      // Send current participants to new user
      const participants = Array.from(sessionUsers.values());
      socket.emit('session-participants', participants);

      // Notify others about new user
      socket.to(sessionId).emit('user-joined', {
        user: user,
        socketId: socket.id,
        timestamp: new Date()
      });

      // Broadcast updated participant count
      io.to(sessionId).emit('participant-count-update', participants.length);

      console.log(`👥 User ${user.username} joined session ${sessionId}`);

    } catch (error) {
      console.error('Error joining session:', error);
      socket.emit('error', { 
        message: 'Failed to join session',
        code: 'JOIN_SESSION_ERROR'
      });
    }
  });

  // Handle real-time code changes
  socket.on('code-change', (data) => {
    const { sessionId, code, operation } = data;
    
    if (!sessionId || !socket.currentSession) {
      return;
    }

    try {
      // Update stored code
      sessionCode.set(sessionId, code);

      // Broadcast code change to all other users in session
      socket.to(sessionId).emit('code-change', {
        code: code,
        operation: operation,
        from: socket.userData?.username || 'Anonymous',
        socketId: socket.id,
        timestamp: new Date()
      });

      // Update user typing status
      const sessionUsers = activeSessions.get(sessionId);
      if (sessionUsers && sessionUsers.has(socket.id)) {
        const userData = sessionUsers.get(socket.id);
        userData.isTyping = true;
        userData.lastActivity = new Date();
        
        // Clear typing status after 2 seconds
        setTimeout(() => {
          if (sessionUsers.has(socket.id)) {
            sessionUsers.get(socket.id).isTyping = false;
            socket.to(sessionId).emit('typing-status-update', {
              socketId: socket.id,
              isTyping: false
            });
          }
        }, 2000);

        // Broadcast typing status
        socket.to(sessionId).emit('typing-status-update', {
          socketId: socket.id,
          username: userData.username,
          isTyping: true
        });
      }

    } catch (error) {
      console.error('Error handling code change:', error);
    }
  });

  // Handle cursor position updates
  socket.on('cursor-position', (data) => {
    const { sessionId, position } = data;
    
    if (!sessionId || !position) return;

    try {
      // Update cursor position
      const cursors = sessionCursors.get(sessionId);
      if (cursors) {
        cursors.set(socket.id, position);
        
        // Broadcast cursor position to others
        socket.to(sessionId).emit('cursor-update', {
          socketId: socket.id,
          username: socket.userData?.username,
          position: position,
          color: socket.userData?.color || '#667eea'
        });
      }
    } catch (error) {
      console.error('Error updating cursor position:', error);
    }
  });

  // Handle code execution requests
  socket.on('execute-code', async (data) => {
    const { sessionId, code, language, input } = data;
    
    if (!sessionId) return;

    try {
      // Notify session about execution start
      io.to(sessionId).emit('execution-started', {
        username: socket.userData?.username || 'Anonymous',
        language: language
      });

      // Execute code via Piston API
      const axios = require('axios');
      const response = await axios.post(`${process.env.PISTON_API_URL}/execute`, {
        language: language,
        version: '*',
        files: [{ content: code }],
        stdin: input || ''
      });

      const result = {
        output: response.data.run.stdout || response.data.run.stderr || 'No output',
        executionTime: response.data.run.runtime || 0,
        memoryUsed: response.data.run.memory || 0,
        exitCode: response.data.run.code,
        timestamp: new Date()
      };

      // Broadcast execution result to session
      io.to(sessionId).emit('execution-result', {
        result: result,
        executedBy: socket.userData?.username || 'Anonymous'
      });

    } catch (error) {
      console.error('Code execution error:', error);
      io.to(sessionId).emit('execution-error', {
        error: 'Code execution failed',
        message: error.message
      });
    }
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    const { sessionId, message } = data;
    
    if (!sessionId || !message || !socket.userData) return;

    const chatMessage = {
      id: Date.now() + Math.random(),
      username: socket.userData.username,
      message: message.trim(),
      timestamp: new Date(),
      socketId: socket.id
    };

    // Broadcast to session
    io.to(sessionId).emit('chat-message', chatMessage);
  });

  // Handle session leave
  socket.on('leave-session', (sessionId) => {
    handleUserLeaveSession(socket, sessionId);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
    
    // Remove from user sockets map
    if (socket.userData && socket.userData.id) {
      userSockets.delete(socket.userData.id);
    }

    // Handle leaving current session
    if (socket.currentSession) {
      handleUserLeaveSession(socket, socket.currentSession);
    }
  });

  // Helper function to handle user leaving session
  function handleUserLeaveSession(socket, sessionId) {
    try {
      const sessionUsers = activeSessions.get(sessionId);
      if (sessionUsers && sessionUsers.has(socket.id)) {
        const userData = sessionUsers.get(socket.id);
        sessionUsers.delete(socket.id);

        // Remove cursor
        const cursors = sessionCursors.get(sessionId);
        if (cursors) {
          cursors.delete(socket.id);
        }

        // Notify others about user leaving
        socket.to(sessionId).emit('user-left', {
          user: userData,
          socketId: socket.id,
          timestamp: new Date()
        });

        // Update participant count
        const remainingParticipants = Array.from(sessionUsers.values());
        io.to(sessionId).emit('participant-count-update', remainingParticipants.length);

        // Leave the socket room
        socket.leave(sessionId);

        console.log(`👋 User ${userData.username} left session ${sessionId}`);

        // Clean up empty sessions
        if (sessionUsers.size === 0) {
          activeSessions.delete(sessionId);
          sessionCode.delete(sessionId);
          sessionCursors.delete(sessionId);
          console.log(`🗑️ Cleaned up empty session ${sessionId}`);
        }
      }
    } catch (error) {
      console.error('Error handling user leave:', error);
    }
  }
});

// Error handling middleware for MongoDB errors
app.use('/api', (err, req, res, next) => {
  if (err.code === 11000) {
    // Duplicate key error
    const field = Object.keys(err.keyPattern)[0];
    return res.status(409).json({
      error: `This ${field} is already in use`
    });
  }
  next(err);
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    path: req.originalUrl 
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 CodeCollab server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
  console.log(`🌐 CORS Origin: ${corsOrigin}`);
});
