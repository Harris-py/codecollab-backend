// Session.js - Fixed model with currentCode field
const mongoose = require('mongoose');

// Helper function to generate unique 6-character session code
const generateSessionCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const sessionSchema = new mongoose.Schema({
  // Basic session information
  name: {
    type: String,
    required: true,
    trim: true,
    minlength: 3,
    maxlength: 100
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500,
    default: ''
  },
  
  // Unique 6-character session code for joining
  sessionCode: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    length: 6,
    match: /^[A-Z0-9]{6}$/
  },

  // Programming language for the session
  language: {
    type: String,
    required: true,
    enum: ['javascript', 'python', 'cpp', 'c', 'java', 'go', 'rust'],
    default: 'javascript'
  },

  // Current code content in the session
  currentCode: {
    type: String,
    default: function() {
      const templates = {
        'javascript': '// Welcome to CodeCollab - JavaScript Session\n// Start coding together in real-time!\n\nconsole.log("Hello, World!");',
        'python': '# Welcome to CodeCollab - Python Session\n# Start coding together in real-time!\n\nprint("Hello, World!")',
        'cpp': '// Welcome to CodeCollab - C++ Session\n// Start coding together in real-time!\n\n#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}',
        'c': '// Welcome to CodeCollab - C Session\n// Start coding together in real-time!\n\n#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}',
        'java': '// Welcome to CodeCollab - Java Session\n// Start coding together in real-time!\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}',
        'go': '// Welcome to CodeCollab - Go Session\n// Start coding together in real-time!\n\npackage main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}',
        'rust': '// Welcome to CodeCollab - Rust Session\n// Start coding together in real-time!\n\nfn main() {\n    println!("Hello, World!");\n}'
      };
      return templates[this.language] || templates.javascript;
    }
  },

  // Session Creator/Owner
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Current Active Participants
  activeParticipants: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    username: {
      type: String,
      required: true
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    role: {
      type: String,
      enum: ['creator', 'editor', 'viewer'],
      default: 'editor'
    },
    isActive: {
      type: Boolean,
      default: true
    },
    lastActivity: {
      type: Date,
      default: Date.now
    },
    cursor: {
      line: { type: Number, default: 0 },
      column: { type: Number, default: 0 }
    },
    color: {
      type: String,
      default: '#667eea' // Default user color for cursor
    }
  }],

  // Session Settings
  settings: {
    maxParticipants: {
      type: Number,
      min: 2,
      max: 10,
      default: 5
    },
    isPublic: {
      type: Boolean,
      default: false
    },
    allowAnonymous: {
      type: Boolean,
      default: false
    },
    autoSave: {
      type: Boolean,
      default: true
    },
    executionEnabled: {
      type: Boolean,
      default: true
    }
  },

  // Session Status
  status: {
    type: String,
    enum: ['active', 'paused', 'ended', 'archived'],
    default: 'active'
  },

  // Code Execution History
  executionHistory: [{
    code: String,
    language: String,
    input: String,
    output: String,
    error: String,
    executionTime: Number, // in milliseconds
    memoryUsed: Number, // in KB
    executedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    executedAt: {
      type: Date,
      default: Date.now
    }
  }],

  // Session Statistics
  stats: {
    totalParticipants: {
      type: Number,
      default: 0
    },
    totalExecutions: {
      type: Number,
      default: 0
    },
    totalCodeChanges: {
      type: Number,
      default: 0
    },
    averageSessionTime: {
      type: Number, // in minutes
      default: 0
    },
    linesOfCode: {
      type: Number,
      default: 0
    }
  },

  // Version History (simplified)
  codeHistory: [{
    code: String,
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    changeType: {
      type: String,
      enum: ['created', 'modified', 'executed'],
      default: 'modified'
    }
  }],

  // Session Timestamps
  lastActivity: {
    type: Date,
    default: Date.now
  },
  endedAt: {
    type: Date
  },
  
  // Auto-delete after inactivity (TTL)
  expiresAt: {
    type: Date,
    default: function() {
      // Sessions expire after 24 hours of inactivity
      return new Date(Date.now() + 24 * 60 * 60 * 1000);
    }
  }

}, {
  timestamps: true, // Adds createdAt and updatedAt
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for performance
sessionSchema.index({ sessionCode: 1 });
sessionSchema.index({ creator: 1 });
sessionSchema.index({ status: 1 });
sessionSchema.index({ lastActivity: -1 });
sessionSchema.index({ createdAt: -1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Virtual for session duration
sessionSchema.virtual('duration').get(function() {
  const end = this.endedAt || new Date();
  return Math.floor((end - this.createdAt) / (1000 * 60)); // in minutes
});

// Virtual for active participants count
sessionSchema.virtual('activeParticipantsCount').get(function() {
  return this.activeParticipants.filter(p => p.isActive).length;
});

// Virtual for can join status
sessionSchema.virtual('canJoin').get(function() {
  return this.status === 'active' && 
         this.activeParticipantsCount < this.settings.maxParticipants;
});

// Pre-save middleware to ensure unique session code
sessionSchema.pre('save', async function(next) {
  if (this.isNew && !this.sessionCode) {
    let unique = false;
    let attempts = 0;
    
    while (!unique && attempts < 10) {
      const code = generateSessionCode();
      const existing = await this.constructor.findOne({ sessionCode: code });
      
      if (!existing) {
        this.sessionCode = code;
        unique = true;
      }
      attempts++;
    }
    
    if (!unique) {
      return next(new Error('Unable to generate unique session code'));
    }
  }
  next();
});

// Pre-save middleware to update lastActivity
sessionSchema.pre('save', function(next) {
  if (this.isModified() && !this.isModified('lastActivity')) {
    this.lastActivity = new Date();
  }
  next();
});

// Instance method to add code change to history
sessionSchema.methods.addCodeChange = function(code, userId, changeType = 'modified') {
  this.codeHistory.unshift({
    code: code,
    changedBy: userId,
    timestamp: new Date(),
    changeType: changeType
  });
  
  // Keep only last 50 changes
  if (this.codeHistory.length > 50) {
    this.codeHistory = this.codeHistory.slice(0, 50);
  }
  
  this.stats.totalCodeChanges += 1;
  this.currentCode = code;
  this.lastActivity = new Date();
  return this.save();
};

// Instance method to add execution result
sessionSchema.methods.addExecution = function(executionData) {
  this.executionHistory.unshift({
    ...executionData,
    executedAt: new Date()
  });
  
  // Keep last 20 executions
  if (this.executionHistory.length > 20) {
    this.executionHistory = this.executionHistory.slice(0, 20);
  }
  
  this.stats.totalExecutions += 1;
  this.lastActivity = new Date();
  return this.save();
};

// Instance method to end session
sessionSchema.methods.endSession = function() {
  this.status = 'ended';
  this.endedAt = new Date();
  
  // Mark all participants as inactive
  this.activeParticipants.forEach(participant => {
    participant.isActive = false;
  });
  
  return this.save();
};

// Static method to find by session code
sessionSchema.statics.findByCode = function(sessionCode) {
  return this.findOne({ 
    sessionCode: sessionCode.toUpperCase(),
    status: 'active'
  }).populate('creator', 'username email profile')
   .populate('activeParticipants.user', 'username profile');
};

// Static method to get user's sessions
sessionSchema.statics.getUserSessions = function(userId, limit = 10) {
  return this.find({
    $or: [
      { creator: userId },
      { 'activeParticipants.user': userId }
    ]
  })
  .populate('creator', 'username profile')
  .sort({ lastActivity: -1 })
  .limit(limit);
};

// Static method to get active public sessions
sessionSchema.statics.getPublicSessions = function(limit = 20) {
  return this.find({
    status: 'active',
    'settings.isPublic': true
  })
  .populate('creator', 'username profile')
  .sort({ createdAt: -1 })
  .limit(limit);
};

// Static method to cleanup expired sessions
sessionSchema.statics.cleanupExpiredSessions = async function() {
  const result = await this.deleteMany({
    status: 'active',
    lastActivity: { 
      $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours ago
    }
  });
  console.log(`🗑️ Cleaned up ${result.deletedCount} expired sessions`);
  return result;
};

module.exports = mongoose.model('Session', sessionSchema);
