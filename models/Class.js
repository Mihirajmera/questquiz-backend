const mongoose = require('mongoose');

const classSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  code: {
    type: String,
    required: true,
    uppercase: true,
    minlength: 6,
    maxlength: 8
  },
  instructor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  students: [{
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    isActive: {
      type: Boolean,
      default: true
    }
  }],
  quizzes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz'
  }],
  settings: {
    allowStudentJoin: {
      type: Boolean,
      default: true
    },
    maxStudents: {
      type: Number,
      default: 100
    },
    requireApproval: {
      type: Boolean,
      default: false
    }
  },
  stats: {
    totalStudents: {
      type: Number,
      default: 0
    },
    activeStudents: {
      type: Number,
      default: 0
    },
    totalQuizzes: {
      type: Number,
      default: 0
    }
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for efficient queries
classSchema.index({ code: 1 }, { unique: true });
classSchema.index({ instructor: 1 });
classSchema.index({ 'students.student': 1 });

// Generate unique class code
classSchema.statics.generateClassCode = async function() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  let isUnique = false;
  
  while (!isUnique) {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    const existingClass = await this.findOne({ code });
    if (!existingClass) {
      isUnique = true;
    }
  }
  
  return code;
};

// Update stats when students are added/removed
classSchema.methods.updateStats = function() {
  this.stats.totalStudents = this.students.length;
  this.stats.activeStudents = this.students.filter(s => s.isActive).length;
  this.stats.totalQuizzes = this.quizzes.length;
};

// Pre-save middleware to update stats
classSchema.pre('save', function(next) {
  this.updateStats();
  next();
});

// Virtual for student count
classSchema.virtual('studentCount').get(function() {
  return this.students.filter(s => s.isActive).length;
});

module.exports = mongoose.model('Class', classSchema);
