const mongoose = require('mongoose');

const badgeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  icon: {
    type: String,
    required: true
  },
  unlockedAt: {
    type: Date,
    default: Date.now
  },
  category: {
    type: String,
    enum: ['achievement', 'streak', 'mastery', 'speed', 'accuracy'],
    required: true
  }
});

const levelSchema = new mongoose.Schema({
  level: {
    type: Number,
    required: true,
    min: 1
  },
  name: {
    type: String,
    required: true
  },
  xpRequired: {
    type: Number,
    required: true
  },
  unlockedAt: {
    type: Date,
    default: Date.now
  }
});

const gameStateSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  xp: {
    type: Number,
    default: 0
  },
  level: {
    type: Number,
    default: 1
  },
  currentLevel: levelSchema,
  badges: [badgeSchema],
  streaks: {
    current: {
      type: Number,
      default: 0
    },
    longest: {
      type: Number,
      default: 0
    },
    lastActivity: {
      type: Date,
      default: Date.now
    }
  },
  stats: {
    totalQuizzesCompleted: {
      type: Number,
      default: 0
    },
    totalQuestionsAnswered: {
      type: Number,
      default: 0
    },
    totalCorrectAnswers: {
      type: Number,
      default: 0
    },
    averageAccuracy: {
      type: Number,
      default: 0
    },
    totalTimeSpent: {
      type: Number, // in minutes
      default: 0
    },
    fastestQuiz: {
      type: Number, // in seconds
      default: null
    }
  },
  unlockedWorlds: [{
    worldId: String,
    name: String,
    unlockedAt: Date
  }],
  achievements: [{
    id: String,
    name: String,
    description: String,
    unlockedAt: Date,
    progress: Number // 0-100
  }]
}, {
  timestamps: true
});

// Calculate level based on XP
gameStateSchema.methods.calculateLevel = function() {
  const xp = this.xp;
  let level = 1;
  let xpForNextLevel = 100;
  
  while (xp >= xpForNextLevel) {
    level++;
    xpForNextLevel += level * 50; // Increasing XP requirement per level
  }
  
  return {
    level,
    xpForCurrentLevel: xpForNextLevel - level * 50,
    xpForNextLevel,
    progress: ((xp - (xpForNextLevel - level * 50)) / (level * 50)) * 100
  };
};

// Add XP and check for level up
gameStateSchema.methods.addXP = function(amount, reason = 'quiz_completion') {
  const oldLevel = this.level;
  this.xp += amount;
  
  const levelInfo = this.calculateLevel();
  this.level = levelInfo.level;
  
  // Check for level up
  if (this.level > oldLevel) {
    this.currentLevel = {
      level: this.level,
      name: `Level ${this.level}`,
      xpRequired: levelInfo.xpForNextLevel,
      unlockedAt: new Date()
    };
    
    return {
      leveledUp: true,
      newLevel: this.level,
      xpGained: amount,
      totalXP: this.xp,
      levelInfo
    };
  }
  
  return {
    leveledUp: false,
    xpGained: amount,
    totalXP: this.xp,
    levelInfo
  };
};

// Check and unlock badges
gameStateSchema.methods.checkBadges = function() {
  const newBadges = [];
  
  // First quiz completion
  if (this.stats.totalQuizzesCompleted === 1 && !this.badges.find(b => b.id === 'first_quiz')) {
    newBadges.push({
      id: 'first_quiz',
      name: 'First Steps',
      description: 'Completed your first quiz!',
      icon: '🎯',
      category: 'achievement'
    });
  }
  
  // Perfect score
  if (this.stats.averageAccuracy === 100 && !this.badges.find(b => b.id === 'perfectionist')) {
    newBadges.push({
      id: 'perfectionist',
      name: 'Perfectionist',
      description: 'Achieved 100% accuracy!',
      icon: '⭐',
      category: 'achievement'
    });
  }
  
  // Streak badges
  if (this.streaks.current >= 7 && !this.badges.find(b => b.id === 'week_warrior')) {
    newBadges.push({
      id: 'week_warrior',
      name: 'Week Warrior',
      description: '7-day quiz streak!',
      icon: '🔥',
      category: 'streak'
    });
  }
  
  // Add new badges
  this.badges.push(...newBadges);
  return newBadges;
};

module.exports = mongoose.model('GameState', gameStateSchema);
