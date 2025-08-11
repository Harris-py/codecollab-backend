// server.js - Complete updated version
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

// ⭐ TRUST PROXY CONFIGURATION - CRITICAL FIX
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
} else {
  app.set('trust proxy', true);
}

// CORS origin configuration
const corsOrigin = process.env.CLIENT_URL || "http://localhost:3000";

// Socket.io setup with CORS
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

app.locals.validateObjectId = validateObjectId;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ⭐ IMPROVED RATE LIMITING with proxy handling
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  
  keyGenerator: (req) => {
    return req.ip; // Uses real IP when trust proxy is set
  },
  
  skip: (req) => {
    return req.path === '/health' || req.path === '/api/test';
  },
  
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  
  standardHeaders: true,
  legacyHeaders: false,
  
  handler: (req, res) => {
    console.log(`Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      error: 'Too many requests from this IP, please try again later.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

app.use('/api/', limiter);

// Development logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use('/api', (req, res, next) => {
    console.log(`📍 ${req.method} ${req.originalUrl} - IP: ${req.ip}`);
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
    environment: process.env.NODE_ENV,
    ip: req.ip
  });
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'CodeCollab API is working!',
    timestamp: new Date().toISOString(),
    ip: req.ip,
    trustProxy: app.get('trust proxy')
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/execute', executeRoutes);

// MongoDB connection
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

mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('📡 MongoDB disconnected');
});

// ⭐ REAL-TIME COLLABORATION STATE MANAGEMENT
const activeSessions = new Map(); // sessionId -> Map of socketId -> userData
const userSockets = new Map(); // userId -> socketId
const sessionCode = new Map(); // sessionId -> current code content
const sessionCursors = new Map(); // sessionId -> Map of socketId -> cursor position
const sessionChats = new Map(); // sessionId -> array of chat messages

// ⭐ SOCKET.IO CONNECTION HANDLING - COMPLETE IMPLEMENTATION
io.on('connection', (socket) => {
  console.log('🔌 User connected:', socket.id);

  // Handle user authentication
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

  // Join collaborative session
  socket.on('join-session', async (data) => {
    const { sessionId, user } = data;
    
    if (!sessionId || !user) {
      socket.emit('error', { message: 'Invalid session data' });
      return;
    }

    try {
      // Join the Socket.io room
      socket.join(sessionId);
      socket.currentSession = sessionId;

      // Initialize session maps if needed
      if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, new Map());
        sessionCode.set(sessionId, '// Welcome to CodeCollab!\n// Start coding together!\n\nconsole.log("Hello, World!");');
        sessionCursors.set(sessionId, new Map());
        sessionChats.set(sessionId, []);
      }

      // Add user to session
      const sessionUsers = activeSessions.get(sessionId);
      sessionUsers.set(socket.id, {
        ...user,
        socketId: socket.id,
        joinedAt: new Date(),
        isTyping: false,
        status: 'active',
        cursor: { line: 1, column: 1 }
      });

      // Send current code to new user
      const currentCode = sessionCode.get(sessionId);
      socket.emit('code-sync', { code: currentCode });

      // Send chat history to new user
      const chatHistory = sessionChats.get(sessionId);
      socket.emit('chat-history', { messages: chatHistory });

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
      socket.emit('error', { message: 'Failed to join session' });
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
        operation: operation || 'edit',
        from: socket.userData?.username || 'Anonymous',
        fromUserId: socket.userData?.id,
        socketId: socket.id,
        timestamp: new Date()
      });

      console.log(`📝 Code updated in session ${sessionId} by ${socket.userData?.username}`);

    } catch (error) {
      console.error('Error handling code change:', error);
    }
  });

  // Handle cursor position updates
  socket.on('cursor-position', (data) => {
    const { sessionId, position } = data;
    
    if (!sessionId || !socket.currentSession) {
      return;
    }

    try {
      // Update cursor position
      if (sessionCursors.has(sessionId)) {
        sessionCursors.get(sessionId).set(socket.id, {
          userId: socket.userData?.id,
          username: socket.userData?.username,
          position: position,
          lastUpdate: new Date()
        });
      }

      // Broadcast cursor position to other users
      socket.to(sessionId).emit('cursor-position', {
        userId: socket.userData?.id,
        username: socket.userData?.username,
        position: position,
        socketId: socket.id,
        timestamp: new Date()
      });

    } catch (error) {
      console.error('Error handling cursor position:', error);
    }
  });

  // Handle chat messages
  socket.on('chat-message', (data) => {
    const { sessionId, message } = data;
    
    if (!sessionId || !message || !socket.currentSession) {
      return;
    }

    try {
      const chatMessage = {
        id: Date.now() + Math.random(),
        message: message.trim(),
        userId: socket.userData?.id,
        username: socket.userData?.username,
        timestamp: new Date(),
        socketId: socket.id
      };

      // Store message in session chat history
      if (sessionChats.has(sessionId)) {
        const chatHistory = sessionChats.get(sessionId);
        chatHistory.push(chatMessage);
        
        // Keep only last 100 messages
        if (chatHistory.length > 100) {
          chatHistory.splice(0, chatHistory.length - 100);
        }
      }

      // Broadcast message to all users in session (including sender)
      io.to(sessionId).emit('chat-message', chatMessage);

      console.log(`💬 Chat message in session ${sessionId} from ${socket.userData?.username}: ${message}`);

    } catch (error) {
      console.error('Error handling chat message:', error);
    }
  });

  // Handle typing indicators
  socket.on('typing-start', (data) => {
    const { sessionId } = data;
    if (sessionId && socket.currentSession) {
      socket.to(sessionId).emit('user-typing', {
        userId: socket.userData?.id,
        username: socket.userData?.username,
        isTyping: true
      });
    }
  });

  socket.on('typing-stop', (data) => {
    const { sessionId } = data;
    if (sessionId && socket.currentSession) {
      socket.to(sessionId).emit('user-typing', {
        userId: socket.userData?.id,
        username: socket.userData?.username,
        isTyping: false
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
    
    if (socket.currentSession) {
      const sessionId = socket.currentSession;
      
      // Remove user from session
      if (activeSessions.has(sessionId)) {
        activeSessions.get(sessionId).delete(socket.id);
      }
      
      // Remove cursor
      if (sessionCursors.has(sessionId)) {
        sessionCursors.get(sessionId).delete(socket.id);
      }

      // Notify other users
      socket.to(sessionId).emit('user-left', {
        socketId: socket.id,
        userId: socket.userData?.id,
        username: socket.userData?.username,
        timestamp: new Date()
      });

      // Update participant count
      const remainingUsers = activeSessions.get(sessionId);
      if (remainingUsers) {
        io.to(sessionId).emit('participant-count-update', remainingUsers.size);
      }
    }

    // Remove from global user tracking
    if (socket.userData?.id) {
      userSockets.delete(socket.userData.id);
    }
  });

  // Handle leave session
  socket.on('leave-session', (data) => {
    const { sessionId } = data;
    
    if (sessionId && socket.currentSession === sessionId) {
      socket.leave(sessionId);
      socket.currentSession = null;
      
      // Remove from session tracking
      if (activeSessions.has(sessionId)) {
        activeSessions.get(sessionId).delete(socket.id);
      }
      
      // Notify others
      socket.to(sessionId).emit('user-left', {
        socketId: socket.id,
        userId: socket.userData?.id,
        username: socket.userData?.username
      });
    }
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 CORS Origin: ${corsOrigin}`);
  console.log(`🛡️  Trust Proxy: ${app.get('trust proxy')}`);
});
