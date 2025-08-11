// server.js - Updated with automatic index fix
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

// Production-ready CORS configuration for Railway
const getCorsOrigins = () => {
  const origins = [];
  
  // Add explicit client URL if set
  if (process.env.CLIENT_URL) {
    origins.push(process.env.CLIENT_URL);
  }
  
  // Add additional allowed origins
  if (process.env.ALLOWED_ORIGINS) {
    origins.push(...process.env.ALLOWED_ORIGINS.split(','));
  }
  
  // Common frontend deployment platforms
  if (process.env.NODE_ENV === 'production') {
    origins.push(
      // Add your frontend URLs here
      'https://codecollab-frontend.vercel.app',
      'https://codecollab-frontend.netlify.app',
      // Add any other frontend domains you might use
    );
  }
  
  // Development origins
  if (process.env.NODE_ENV === 'development') {
    origins.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }
  
  // If no origins specified, allow all in development, restrict in production
  if (origins.length === 0) {
    return process.env.NODE_ENV === 'development' ? true : false;
  }
  
  console.log('🌐 Allowed CORS Origins:', origins);
  return origins;
};

const corsOrigins = getCorsOrigins();

// Socket.io setup with production-ready CORS
const io = socketIo(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Enhanced security middleware for production
app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"]
    }
  } : false,
  crossOriginEmbedderPolicy: false
}));

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (Array.isArray(corsOrigins)) {
      if (corsOrigins.includes(origin)) {
        return callback(null, true);
      }
    } else if (corsOrigins === true) {
      return callback(null, true);
    }
    
    console.log('❌ CORS blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Production-ready rate limiting
const createRateLimiter = () => {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
  const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
  
  return rateLimit({
    windowMs,
    max: maxRequests,
    message: { error: 'Too many requests from this IP, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health'
  });
};

app.use('/api/', createRateLimiter());

// Request logging
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const log = `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`;
    
    if (res.statusCode >= 400) {
      console.error('❌', log);
    } else if (process.env.NODE_ENV === 'development') {
      console.log('✅', log);
    }
  });
  
  next();
};

if (process.env.NODE_ENV !== 'test') {
  app.use(requestLogger);
}

// Body parsing middleware
app.use(express.json({ 
  limit: process.env.MAX_JSON_SIZE || '10mb',
  strict: true
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: process.env.MAX_URL_ENCODED_SIZE || '10mb'
}));

// Enhanced health check
app.get('/health', (req, res) => {
  const healthCheck = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    version: process.env.npm_package_version || '1.0.0',
    memory: process.memoryUsage(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    railway: {
      service: process.env.RAILWAY_SERVICE_NAME || 'codecollab-backend',
      deployment: process.env.RAILWAY_DEPLOYMENT_ID || 'unknown'
    }
  };
  
  res.status(200).json(healthCheck);
});

// API test endpoint
app.get('/api/test', (req, res) => {
  res.json({
    message: 'CodeCollab API is working!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    cors: corsOrigins
  });
});

// MongoDB connection with production settings and index fix
const connectDB = async () => {
  try {
    const mongoOptions = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      bufferMaxEntries: 0,
      bufferCommands: false,
    };

    if (process.env.NODE_ENV === 'production') {
      mongoOptions.ssl = true;
      mongoOptions.retryWrites = true;
    }

    await mongoose.connect(process.env.MONGODB_URI, mongoOptions);
    console.log('✅ Connected to MongoDB');
    
    // Fix the index issue automatically
    await fixDatabaseIndexes();
    
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Function to fix database indexes automatically
const fixDatabaseIndexes = async () => {
  try {
    console.log('🔧 Checking and fixing database indexes...');
    
    const db = mongoose.connection.db;
    const collection = db.collection('codestates');
    
    // Try to drop the problematic index
    try {
      await collection.dropIndex('operations.operationId_1');
      console.log('✅ Dropped problematic index: operations.operationId_1');
    } catch (error) {
      if (error.code === 27) {
        console.log('ℹ️  Index operations.operationId_1 does not exist (already fixed)');
      } else {
        console.log('ℹ️  Could not drop index (might not exist):', error.message);
      }
    }
    
    // Clean up documents with null operationId
    try {
      const result = await collection.updateMany(
        { 'operations.operationId': null },
        { 
          $pull: { 
            operations: { operationId: null } 
          } 
        }
      );
      
      if (result.modifiedCount > 0) {
        console.log(`✅ Cleaned up ${result.modifiedCount} documents with null operationId`);
      }
    } catch (error) {
      console.log('ℹ️  Error cleaning up null operationIds:', error.message);
    }
    
    console.log('🎉 Database index fix completed');
    
  } catch (error) {
    console.error('❌ Error fixing database indexes:', error.message);
    // Don't crash the server for index issues
  }
};

connectDB();

// MongoDB event handlers
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('📡 MongoDB disconnected');
  if (process.env.NODE_ENV === 'production') {
    setTimeout(connectDB, 5000);
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/execute', executeRoutes);

// Real-time collaboration state management
const activeSessions = new Map();
const userSockets = new Map();
const sessionCode = new Map();
const sessionCursors = new Map();

// Socket.io connection handling with enhanced error handling
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

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      socket.emit('error', { message: 'Invalid session ID format' });
      return;
    }

    try {
      socket.join(sessionId);
      socket.currentSession = sessionId;

      if (!activeSessions.has(sessionId)) {
        activeSessions.set(sessionId, new Map());
        sessionCode.set(sessionId, '// Welcome to CodeCollab!\n// Start typing to collaborate in real-time\n\nconsole.log("Hello, World!");');
        sessionCursors.set(sessionId, new Map());
      }

      const sessionUsers = activeSessions.get(sessionId);
      sessionUsers.set(socket.id, user);

      const participants = Array.from(sessionUsers.values());
      const currentCode = sessionCode.get(sessionId);

      socket.emit('session-joined', {
        participants,
        currentCode,
        sessionId
      });

      socket.to(sessionId).emit('user-joined', {
        user,
        socketId: socket.id,
        timestamp: new Date()
      });

      console.log(`👥 User ${user.username} joined session ${sessionId}`);

    } catch (error) {
      console.error('Join session error:', error);
      socket.emit('error', { message: 'Failed to join session' });
    }
  });

  // Handle code changes
  socket.on('code-change', (data) => {
    const { sessionId, code, operation } = data;
    
    if (!sessionId || code === undefined) return;

    try {
      sessionCode.set(sessionId, code);
      
      socket.to(sessionId).emit('code-change', {
        code,
        operation,
        from: socket.userData?.username || 'Anonymous',
        timestamp: new Date()
      });

    } catch (error) {
      console.error('Code change error:', error);
    }
  });

  // Handle cursor position updates
  socket.on('cursor-position', (data) => {
    const { sessionId, position } = data;
    
    if (!sessionId || !position) return;

    try {
      const cursors = sessionCursors.get(sessionId);
      if (cursors) {
        cursors.set(socket.id, {
          ...position,
          username: socket.userData?.username || 'Anonymous',
          timestamp: new Date()
        });

        socket.to(sessionId).emit('cursor-update', {
          socketId: socket.id,
          position,
          username: socket.userData?.username || 'Anonymous'
        });
      }
    } catch (error) {
      console.error('Cursor position error:', error);
    }
  });

  // Handle code execution
  socket.on('execute-code', async (data) => {
    const { sessionId, code, language, input } = data;
    
    if (!sessionId || !code || !language) return;

    try {
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

    io.to(sessionId).emit('chat-message', chatMessage);
  });

  // Handle session leave
  socket.on('leave-session', (sessionId) => {
    handleUserLeaveSession(socket, sessionId);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('🔌 User disconnected:', socket.id);
    
    if (socket.userData && socket.userData.id) {
      userSockets.delete(socket.userData.id);
    }

    if (socket.currentSession) {
      handleUserLeaveSession(socket, socket.currentSession);
    }
  });

  // Error handling
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
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

// Error handling middleware for MongoDB errors
app.use('/api', (err, req, res, next) => {
  if (err.code === 11000) {
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    mongoose.connection.close(false, () => {
      console.log('Process terminated');
      process.exit(0);
    });
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 CodeCollab server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
  console.log(`🌐 CORS Origins:`, corsOrigins);
  console.log(`🔗 Railway URL: https://codecollab-backend-production-783d.up.railway.app`);
});
