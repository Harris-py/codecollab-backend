// Models/CodeState.js - Fixed version
const mongoose = require('mongoose');

// Real-time code state management for collaborative editing
const codeStateSchema = new mongoose.Schema({
  // Associated session
  sessionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Session',
    required: true,
    unique: true
  },

  // Current code content
  content: {
    type: String,
    default: ''
  },

  // Language for syntax highlighting
  language: {
    type: String,
    enum: ['javascript', 'python', 'cpp', 'c', 'java', 'go', 'rust'],
    required: true
  },

  // Real-time cursors of all users
  cursors: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    username: {
      type: String,
      required: true
    },
    position: {
      line: {
        type: Number,
        default: 0,
        min: 0
      },
      column: {
        type: Number,
        default: 0,
        min: 0
      }
    },
    selection: {
      start: {
        line: { type: Number, default: 0 },
        column: { type: Number, default: 0 }
      },
      end: {
        line: { type: Number, default: 0 },
        column: { type: Number, default: 0 }
      }
    },
    color: {
      type: String,
      default: '#667eea'
    },
    isActive: {
      type: Boolean,
      default: true
    },
    lastUpdate: {
      type: Date,
      default: Date.now
    }
  }],

  // Operational Transform operations for conflict resolution
  operations: [{
    type: {
      type: String,
      enum: ['insert', 'delete', 'replace'],
      required: true
    },
    position: {
      line: Number,
      column: Number
    },
    content: String, // Content for insert/replace operations
    length: Number, // Length for delete operations
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    // FIXED: Remove unique constraint and make operationId optional
    operationId: {
      type: String,
      // Remove the unique constraint that was causing issues
      // unique: true, 
      // Make it optional and provide default
      default: function() {
        return new mongoose.Types.ObjectId().toString() + '_' + Date.now();
      }
    }
  }],

  // Typing indicators
  typingUsers: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    username: String,
    position: {
      line: Number,
      column: Number
    },
    startedAt: {
      type: Date,
      default: Date.now
    }
  }],

  // Code execution state
  execution: {
    isRunning: {
      type: Boolean,
      default: false
    },
    lastOutput: {
      type: String,
      default: ''
    },
    lastError: {
      type: String,
      default: ''
    },
    lastExecutedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    lastExecutedAt: {
      type: Date
    },
    executionTime: {
      type: Number,
      default: 0
    }
  }

}, {
  timestamps: true,
  toJSON: { virtuals: true }
});

// Indexes for performance (FIXED: Remove problematic unique index)
codeStateSchema.index({ sessionId: 1 });
codeStateSchema.index({ 'cursors.userId': 1 });
codeStateSchema.index({ 'operations.timestamp': -1 });
// REMOVED: codeStateSchema.index({ 'operations.operationId': 1 }, { unique: true });

// Virtual for active cursors count
codeStateSchema.virtual('activeCursorsCount').get(function() {
  return this.cursors.filter(cursor => cursor.isActive).length;
});

// Virtual for recent operations
codeStateSchema.virtual('recentOperations').get(function() {
  return this.operations
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10);
});

// Method to add operation with proper ID generation
codeStateSchema.methods.addOperation = function(operationData) {
  const operation = {
    ...operationData,
    operationId: new mongoose.Types.ObjectId().toString() + '_' + Date.now(),
    timestamp: new Date()
  };
  
  this.operations.push(operation);
  
  // Keep only last 100 operations for performance
  if (this.operations.length > 100) {
    this.operations = this.operations.slice(-100);
  }
  
  return this.save();
};

// Method to update cursor position
codeStateSchema.methods.updateCursor = function(userId, username, position) {
  const existingCursorIndex = this.cursors.findIndex(
    cursor => cursor.userId.toString() === userId.toString()
  );
  
  if (existingCursorIndex >= 0) {
    this.cursors[existingCursorIndex].position = position;
    this.cursors[existingCursorIndex].lastUpdate = new Date();
    this.cursors[existingCursorIndex].isActive = true;
  } else {
    this.cursors.push({
      userId,
      username,
      position,
      isActive: true,
      lastUpdate: new Date()
    });
  }
  
  return this.save();
};

// Method to remove inactive cursors
codeStateSchema.methods.removeInactiveCursors = function(timeoutMinutes = 5) {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
  this.cursors = this.cursors.filter(cursor => cursor.lastUpdate > cutoff);
  return this.save();
};

// Method to add typing indicator
codeStateSchema.methods.addTypingUser = function(userId, username, position) {
  // Remove existing typing indicator for this user
  this.typingUsers = this.typingUsers.filter(
    user => user.userId.toString() !== userId.toString()
  );
  
  // Add new typing indicator
  this.typingUsers.push({
    userId,
    username,
    position,
    startedAt: new Date()
  });
  
  return this.save();
};

// Method to remove typing indicator
codeStateSchema.methods.removeTypingUser = function(userId) {
  this.typingUsers = this.typingUsers.filter(
    user => user.userId.toString() !== userId.toString()
  );
  return this.save();
};

// Static method to cleanup old typing indicators
codeStateSchema.statics.cleanupTypingIndicators = function() {
  const cutoff = new Date(Date.now() - 30 * 1000); // 30 seconds
  
  return this.updateMany(
    {},
    {
      $pull: {
        typingUsers: {
          startedAt: { $lt: cutoff }
        }
      }
    }
  );
};

// Static method to find or create code state for session
codeStateSchema.statics.findOrCreateForSession = async function(sessionId, language) {
  let codeState = await this.findOne({ sessionId });
  
  if (!codeState) {
    codeState = new this({
      sessionId,
      language,
      content: getLanguageTemplate(language)
    });
    await codeState.save();
  }
  
  return codeState;
};

// Helper function to get language template
function getLanguageTemplate(language) {
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
}

module.exports = mongoose.model('CodeState', codeStateSchema);
