const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters long'],
    maxlength: [20, 'Username cannot exceed 20 characters'],
    match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    validate: {
      validator: validator.isEmail,
      message: 'Please provide a valid email address'
    }
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    select: false // Don't include password in queries by default
  },
  
  // User Preferences
  preferences: {
    preferredLanguage: {
      type: String,
      enum: ['javascript', 'python', 'cpp', 'c', 'java', 'go', 'rust'],
      default: 'javascript'
    },
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'dark'
    },
    fontSize: {
      type: Number,
      min: 12,
      max: 24,
      default: 14
    },
    autoSave: {
      type: Boolean,
      default: true
    },
    notifications: {
      type: Boolean,
      default: true
    }
  },

  // Profile Information
  profile: {
    name: {
      type: String,
      trim: true,
      maxlength: [50, 'Name cannot exceed 50 characters']
    },
    bio: {
      type: String,
      maxlength: [200, 'Bio cannot exceed 200 characters']
    },
    avatar: {
      type: String,
      default: ''
    },
    location: {
      type: String,
      maxlength: [50, 'Location cannot exceed 50 characters']
    },
    website: {
      type: String,
      validate: {
        validator: function(v) {
          return !v || validator.isURL(v);
        },
        message: 'Please provide a valid URL'
      }
    }
  },

  // Activity Tracking
  lastActive: {
    type: Date,
    default: Date.now
  },
  totalSessionsJoined: {
    type: Number,
    default: 0
  },
  totalCodeExecutions: {
    type: Number,
    default: 0
  },
  totalCollaborationTime: {
    type: Number, // in minutes
    default: 0
  },

  // Account Status
  isActive: {
    type: Boolean,
    default: true
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  
  // Remember Me Token
  rememberToken: {
    type: String,
    default: null
  },

  // Security
  loginAttempts: {
    type: Number,
    default: 0
  },
  lockUntil: {
    type: Date
  },

  // Sessions History (referenced sessions)
  recentSessions: [{
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Session'
    },
    lastJoined: {
      type: Date,
      default: Date.now
    },
    role: {
      type: String,
      enum: ['creator', 'participant'],
      default: 'participant'
    }
  }]

}, {
  timestamps: true, // Adds createdAt and updatedAt
  toJSON: { 
    transform: function(doc, ret) {
      delete ret.password;
      delete ret.rememberToken;
      delete ret.loginAttempts;
      delete ret.lockUntil;
      return ret;
    }
  }
});

// Indexes for better performance
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ lastActive: -1 });
userSchema.index({ 'recentSessions.lastJoined': -1 });

// Virtual for account lock status
userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return next();
  
  try {
    // Hash password with cost of 12
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Update lastActive before saving
userSchema.pre('save', function(next) {
  if (this.isModified('lastActive') === false) {
    this.lastActive = new Date();
  }
  next();
});

// Instance method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    throw new Error('Password comparison failed');
  }
};

// Instance method to update activity
userSchema.methods.updateActivity = function() {
  this.lastActive = new Date();
  return this.save();
};

// Instance method to add session to recent sessions
userSchema.methods.addRecentSession = function(sessionId, role = 'participant') {
  // Remove existing entry for this session
  this.recentSessions = this.recentSessions.filter(
    session => !session.sessionId.equals(sessionId)
  );
  
  // Add to beginning of array
  this.recentSessions.unshift({
    sessionId: sessionId,
    lastJoined: new Date(),
    role: role
  });
  
  // Keep only last 10 recent sessions
  if (this.recentSessions.length > 10) {
    this.recentSessions = this.recentSessions.slice(0, 10);
  }
  
  return this.save();
};

// Instance method to increment session count
userSchema.methods.incrementSessionCount = function() {
  this.totalSessionsJoined += 1;
  return this.save();
};

// Instance method to increment code execution count
userSchema.methods.incrementExecutionCount = function() {
  this.totalCodeExecutions += 1;
  return this.save();
};

// Instance method to add collaboration time
userSchema.methods.addCollaborationTime = function(minutes) {
  this.totalCollaborationTime += minutes;
  return this.save();
};

// Static method to find by email or username
userSchema.statics.findByEmailOrUsername = function(identifier) {
  return this.findOne({
    $or: [
      { email: identifier.toLowerCase() },
      { username: identifier }
    ]
  }).select('+password');
};

// Static method to get user stats
userSchema.statics.getUserStats = async function(userId) {
  const user = await this.findById(userId);
  if (!user) throw new Error('User not found');
  
  return {
    totalSessions: user.totalSessionsJoined,
    totalExecutions: user.totalCodeExecutions,
    totalTime: user.totalCollaborationTime,
    memberSince: user.createdAt,
    lastActive: user.lastActive,
    recentSessionsCount: user.recentSessions.length
  };
};

// Static method to handle failed login attempts
userSchema.methods.incLoginAttempts = function() {
  const maxAttempts = 5;
  const lockTime = 2 * 60 * 60 * 1000; // 2 hours
  
  // If we have a previous lock that has expired, restart at 1
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: { lockUntil: 1 },
      $set: { loginAttempts: 1 }
    });
  }
  
  const updates = { $inc: { loginAttempts: 1 } };
  
  // Lock account after max attempts
  if (this.loginAttempts + 1 >= maxAttempts && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + lockTime };
  }
  
  return this.updateOne(updates);
};

// Static method to reset login attempts
userSchema.methods.resetLoginAttempts = function() {
  return this.updateOne({
    $unset: { loginAttempts: 1, lockUntil: 1 }
  });
};

module.exports = mongoose.model('User', userSchema);