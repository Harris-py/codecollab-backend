const mongoose = require('mongoose');
const generateSessionCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};
sessionCode: {
  type: String,
  required: true,
  unique: true,
  length: 6,
  uppercase: true,
  default: generateSessionCode  // ✅ Now auto-generates!
},
const sessionSchema = new mongoose.Schema({
  // Session Basic Information
  name: {
    type: String,
    required: [true, 'Session name is required'],
    trim: true,
    minlength: [3, 'Session name must be at least 3 characters'],
    maxlength: [50, 'Session name cannot exceed 50 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [200, 'Description cannot exceed 200 characters'],
    default: ''
  },
  
  // Session ID for joining (6-character code)
  sessionCode: {
    type: String,
    required: true,
    unique: true,
    length: 6,
    uppercase: true
  },

  // Programming Language
  language: {
    type: String,
    required: [true, 'Programming language is required'],
    enum: {
      values: ['javascript', 'python', 'cpp', 'c', 'java', 'go', 'rust'],
      message: 'Unsupported programming language'
    },
    default: 'javascript'
  },

  // Code Content
  code: {
    type: String,
    default: function() {
      // Return language-specific template
      const templates = {
        javascript: '// Welcome to CodeCollab - JavaScript Session\n// Start coding together in real-time!\n\nconsole.log("Hello, World!");',
        python: '# Welcome to CodeCollab - Python Session\n# Start coding together in real-time!\n\nprint("Hello, World!")',
        cpp: '// Welcome to CodeCollab - C++ Session\n// Start coding together in real-time!\n\n#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}',
        c: '// Welcome to CodeCollab - C Session\n// Start coding together in real-time!\n\n#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}',
        java: '// Welcome to CodeCollab - Java Session\n// Start coding together in real-time!\n\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}',
        go: '// Welcome to CodeCollab - Go Session\n// Start coding together in real-time!\n\npackage main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}',
        rust: '// Welcome to CodeCollab - Rust Session\n// Start coding together in real-time!\n\nfn main() {\n    println!("Hello, World!");\n}'
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

// Generate unique session code before saving
sessionSchema.pre('save', async function(next) {
  if (!this.sessionCode) {
    this.sessionCode = await generateUniqueSessionCode();
  }
  
  // Update lastActivity
  if (this.isModified() && !this.isModified('lastActivity')) {
    this.lastActivity = new Date();
    // Extend expiration by 24 hours
    this.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
  
  next();
});

// Generate unique 6-character session code
async function generateUniqueSessionCode() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let isUnique = false;
  
  while (!isUnique) {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    
    // Check if code already exists
    const existingSession = await mongoose.model('Session').findOne({ sessionCode: code });
    if (!existingSession) {
      isUnique = true;
    }
  }
  
  return code;
}

// Instance method to add participant
sessionSchema.methods.addParticipant = function(user, role = 'editor') {
  // Check if user already in session
  const existingParticipant = this.activeParticipants.find(
    p => p.user.toString() === user._id.toString()
  );
  
  if (existingParticipant) {
    // Update existing participant
    existingParticipant.isActive = true;
    existingParticipant.joinedAt = new Date();
    existingParticipant.lastActivity = new Date();
  } else {
    // Add new participant
    const colors = ['#667eea', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#ffecd2'];
    const color = colors[this.activeParticipants.length % colors.length];
    
    this.activeParticipants.push({
      user: user._id,
      username: user.username,
      joinedAt: new Date(),
      role: role,
      isActive: true,
      lastActivity: new Date(),
      color: color
    });
    
    this.stats.totalParticipants += 1;
  }
  
  this.lastActivity = new Date();
  return this.save();
};

// Instance method to remove participant
sessionSchema.methods.removeParticipant = function(userId) {
  const participantIndex = this.activeParticipants.findIndex(
    p => p.user.toString() === userId.toString()
  );
  
  if (participantIndex !== -1) {
    this.activeParticipants[participantIndex].isActive = false;
    this.lastActivity = new Date();
    return this.save();
  }
  
  return Promise.resolve(this);
};

// Instance method to update code
sessionSchema.methods.updateCode = function(newCode, userId) {
  this.code = newCode;
  this.stats.totalCodeChanges += 1;
  this.stats.linesOfCode = newCode.split('\n').length;
  
  // Add to code history (keep last 50 changes)
  this.codeHistory.unshift({
    code: newCode,
    changedBy: userId,
    timestamp: new Date(),
    changeType: 'modified'
  });
  
  if (this.codeHistory.length > 50) {
    this.codeHistory = this.codeHistory.slice(0, 50);
  }
  
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
