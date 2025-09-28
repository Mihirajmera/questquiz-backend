const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
  questionId: {
    type: String,
    required: true
  },
  answer: {
    type: String,
    required: true
  },
  isCorrect: {
    type: Boolean,
    required: true
  },
  timeSpent: {
    type: Number, // in seconds
    default: 0
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

const attemptSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  quiz: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
    required: true
  },
  answers: [answerSchema],
  score: {
    type: Number,
    default: 0
  },
  totalQuestions: {
    type: Number,
    required: true
  },
  correctAnswers: {
    type: Number,
    default: 0
  },
  timeSpent: {
    type: Number, // total time in seconds
    default: 0
  },
  completedAt: {
    type: Date,
    default: null
  },
  isCompleted: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

const progressSchema = new mongoose.Schema({
  student: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  quiz: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quiz',
    required: true
  },
  attempts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Attempt'
  }],
  bestScore: {
    type: Number,
    default: 0
  },
  totalAttempts: {
    type: Number,
    default: 0
  },
  lastAttempt: {
    type: Date,
    default: null
  },
  topicMastery: [{
    topic: String,
    mastery: Number, // 0-100 percentage
    questionsAnswered: Number,
    correctAnswers: Number
  }],
  weakTopics: [String], // Topics where student struggles
  strongTopics: [String] // Topics where student excels
}, {
  timestamps: true
});

// Index for efficient queries
progressSchema.index({ student: 1, quiz: 1 });
attemptSchema.index({ student: 1, quiz: 1 });

module.exports = {
  Progress: mongoose.model('Progress', progressSchema),
  Attempt: mongoose.model('Attempt', attemptSchema)
};
