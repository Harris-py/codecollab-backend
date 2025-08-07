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
    operationId: {
      type: String,
      required: true,
      unique: true
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
      type: Number, // in milliseconds
      default: 0
    }
  },

  // Version control (simplified)
  version: {
    type: Number,
    default: 1
  },
  
  // Auto-save state
  lastSaved: {
    type: Date,
    default: Date.now
  },
  hasUnsavedChanges: {
    type: Boolean,
    default: false
  },

  // Performance metrics
  metrics: {
    totalOperations: {
      type: Number,
      default: 0
    },
    averageResponseTime: {
      type: Number, // in milliseconds
      default: 0
    },
    conflictResolutions: {
      type: Number,
      default: 0
    }
  }

}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.__v;
      return ret;
    }
  }
});

// Indexes for real-time performance
codeStateSchema.index({ sessionId: 1 });
codeStateSchema.index({ 'cursors.userId': 1 });
codeStateSchema.index({ 'operations.timestamp': -1 });
codeStateSchema.index({ 'operations.operationId': 1 }, { unique: true, sparse: true });

// Virtual for active cursors
codeStateSchema.virtual('activeCursors').get(function() {
  return this.cursors.filter(cursor => 
    cursor.isActive && 
    (Date.now() - cursor.lastUpdate.getTime()) < 30000 // Active in last 30 seconds
  );
});

// Virtual for lines of code
codeStateSchema.virtual('linesOfCode').get(function() {
  return this.content ? this.content.split('\n').length : 0;
});

// Virtual for character count
codeStateSchema.virtual('characterCount').get(function() {
  return this.content ? this.content.length : 0;
});

// Method to apply operation (simplified operational transform)
codeStateSchema.methods.applyOperation = function(operation) {
  const { type, position, content, length } = operation;
  const lines = this.content.split('\n');
  
  try {
    switch (type) {
      case 'insert':
        if (position.line < lines.length) {
          const line = lines[position.line];
          const beforeCursor = line.substring(0, position.column);
          const afterCursor = line.substring(position.column);
          
          if (content.includes('\n')) {
            // Multi-line insert
            const insertLines = content.split('\n');
            lines[position.line] = beforeCursor + insertLines[0];
            
            for (let i = 1; i < insertLines.length; i++) {
              lines.splice(position.line + i, 0, insertLines[i]);
            }
            
            if (insertLines.length > 1) {
              const lastIndex = position.line + insertLines.length - 1;
              lines[lastIndex] = lines[lastIndex] + afterCursor;
            }
          } else {
            // Single line insert
            lines[position.line] = beforeCursor + content + afterCursor;
          }
        }
        break;
        
      case 'delete':
        if (position.line < lines.length) {
          const line = lines[position.line];
          const beforeCursor = line.substring(0, position.column);
          const afterCursor = line.substring(position.column + length);
          lines[position.line] = beforeCursor + afterCursor;
        }
        break;
        
      case 'replace':
        if (position.line < lines.length) {
          const line = lines[position.line];
          const beforeCursor = line.substring(0, position.column);
          const afterCursor = line.substring(position.column + length);
          lines[position.line] = beforeCursor + content + afterCursor;
        }
        break;
    }
    
    this.content = lines.join('\n');
    this.version += 1;
    this.hasUnsavedChanges = true;
    this.metrics.totalOperations += 1;
    
    // Add to operations history
    this.operations.unshift({
      ...operation,
      operationId: `${operation.userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    });
    
    // Keep only last 100 operations
    if (this.operations.length > 100) {
      this.operations = this.operations.slice(0, 100);
    }
    
    return true;
  } catch (error) {
    console.error('Error applying operation:', error);
    return false;
  }
};

// Method to update cursor position
codeStateSchema.methods.updateCursor = function(userId, username, position, color = '#667eea') {
  const existingCursor = this.cursors.find(cursor => 
    cursor.userId.toString() === userId.toString()
  );
  
  if (existingCursor) {
    existingCursor.position = position;
    existingCursor.lastUpdate = new Date();
    existingCursor.isActive = true;
  } else {
    this.cursors.push({
      userId: userId,
      username: username,
      position: position,
      color: color,
      isActive: true,
      lastUpdate: new Date()
    });
  }
  
  // Clean up inactive cursors (older than 1 minute)
  this.cursors = this.cursors.filter(cursor => 
    (Date.now() - cursor.lastUpdate.getTime()) < 60000
  );
  
  return this.save();
};

// Method to set typing indicator
codeStateSchema.methods.setTyping = function(userId, username, position) {
  // Remove existing typing indicator for this user
  this.typingUsers = this.typingUsers.filter(user => 
    user.userId.toString() !== userId.toString()
  );
  
  // Add new typing indicator
  this.typingUsers.push({
    userId: userId,
    username: username,
    position: position,
    startedAt: new Date()
  });
  
  // Auto-remove after 3 seconds
  setTimeout(() => {
    this.typingUsers = this.typingUsers.filter(user => 
      user.userId.toString() !== userId.toString() ||
      (Date.now() - user.startedAt.getTime()) < 3000
    );
  }, 3000);
  
  return this.save();
};

// Method to clear typing indicator
codeStateSchema.methods.clearTyping = function(userId) {
  this.typingUsers = this.typingUsers.filter(user => 
    user.userId.toString() !== userId.toString()
  );
  return this.save();
};

// Method to update execution state
codeStateSchema.methods.updateExecution = function(executionData) {
  this.execution = {
    ...this.execution,
    ...executionData,
    lastExecutedAt: new Date()
  };
  return this.save();
};

// Method to save code (mark as saved)
codeStateSchema.methods.saveCode = function() {
  this.lastSaved = new Date();
  this.hasUnsavedChanges = false;
  return this.save();
};

// Static method to get or create code state for session
codeStateSchema.statics.getOrCreateForSession = async function(sessionId, language, initialContent = '') {
  let codeState = await this.findOne({ sessionId: sessionId });
  
  if (!codeState) {
    codeState = new this({
      sessionId: sessionId,
      language: language,
      content: initialContent,
      version: 1
    });
    await codeState.save();
  }
  
  return codeState;
};

// Static method to cleanup inactive sessions
codeStateSchema.statics.cleanupInactive = async function() {
  const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
  
  const result = await this.deleteMany({
    updatedAt: { $lt: cutoffTime }
  });
  
  console.log(`🗑️ Cleaned up ${result.deletedCount} inactive code states`);
  return result;
};

// Method to get conflict resolution statistics
codeStateSchema.methods.getConflictStats = function() {
  return {
    totalOperations: this.metrics.totalOperations,
    conflictResolutions: this.metrics.conflictResolutions,
    averageResponseTime: this.metrics.averageResponseTime,
    version: this.version,
    activeCursorsCount: this.activeCursors.length
  };
};

module.exports = mongoose.model('CodeState', codeStateSchema);