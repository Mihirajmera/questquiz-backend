const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { Progress } = require('../models/Progress');
const GameState = require('../models/GameState');
const router = express.Router();

// Middleware to verify JWT token
const authenticateToken = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Get student's overall progress
router.get('/overview', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view progress' });
    }

    const gameState = await GameState.findOne({ student: req.user._id });
    const progressRecords = await Progress.find({ student: req.user._id })
      .populate('quiz', 'title topics')
      .sort({ lastAttempt: -1 });

    if (!gameState) {
      return res.status(404).json({ message: 'Game state not found' });
    }

    // Calculate level progress
    const levelInfo = gameState.calculateLevel();

    // Get recent activity
    const recentQuizzes = progressRecords.slice(0, 5).map(record => ({
      quizId: record.quiz._id,
      quizTitle: record.quiz.title,
      bestScore: record.bestScore,
      totalAttempts: record.totalAttempts,
      lastAttempt: record.lastAttempt,
      topicMastery: record.topicMastery
    }));

    // Calculate overall statistics
    const totalQuizzes = progressRecords.length;
    const averageScore = progressRecords.length > 0 
      ? progressRecords.reduce((sum, record) => sum + record.bestScore, 0) / progressRecords.length 
      : 0;

    res.json({
      gameState: {
        xp: gameState.xp,
        level: gameState.level,
        levelInfo,
        badges: gameState.badges,
        streaks: gameState.streaks,
        stats: gameState.stats,
        unlockedWorlds: gameState.unlockedWorlds,
        achievements: gameState.achievements
      },
      progress: {
        totalQuizzes,
        averageScore,
        recentQuizzes,
        overallMastery: calculateOverallMastery(progressRecords)
      }
    });
  } catch (error) {
    console.error('Get progress overview error:', error);
    res.status(500).json({ message: 'Error fetching progress overview' });
  }
});

// Get progress for specific quiz
router.get('/quiz/:quizId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view quiz progress' });
    }

    const progress = await Progress.findOne({
      student: req.user._id,
      quiz: req.params.quizId
    }).populate('quiz', 'title topics questions');

    if (!progress) {
      return res.status(404).json({ message: 'Progress not found for this quiz' });
    }

    res.json({
      progress: {
        quizId: progress.quiz._id,
        quizTitle: progress.quiz.title,
        bestScore: progress.bestScore,
        totalAttempts: progress.totalAttempts,
        lastAttempt: progress.lastAttempt,
        topicMastery: progress.topicMastery,
        weakTopics: progress.weakTopics,
        strongTopics: progress.strongTopics
      },
      quiz: {
        id: progress.quiz._id,
        title: progress.quiz.title,
        topics: progress.quiz.topics,
        totalQuestions: progress.quiz.questions.length
      }
    });
  } catch (error) {
    console.error('Get quiz progress error:', error);
    res.status(500).json({ message: 'Error fetching quiz progress' });
  }
});

// Get leaderboard
router.get('/leaderboard', authenticateToken, async (req, res) => {
  try {
    const { type = 'xp', limit = 10 } = req.query;

    let sortField = 'xp';
    if (type === 'level') sortField = 'level';
    if (type === 'streak') sortField = 'streaks.current';
    if (type === 'accuracy') sortField = 'stats.averageAccuracy';

    const leaderboard = await GameState.find()
      .populate('student', 'name avatar')
      .sort({ [sortField]: -1 })
      .limit(parseInt(limit));

    const formattedLeaderboard = leaderboard.map((gameState, index) => ({
      rank: index + 1,
      student: {
        id: gameState.student._id,
        name: gameState.student.name,
        avatar: gameState.student.avatar
      },
      xp: gameState.xp,
      level: gameState.level,
      streak: gameState.streaks.current,
      accuracy: gameState.stats.averageAccuracy,
      badges: gameState.badges.length,
      quizzesCompleted: gameState.stats.totalQuizzesCompleted
    }));

    res.json({ leaderboard: formattedLeaderboard });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ message: 'Error fetching leaderboard' });
  }
});

// Get student's badges
router.get('/badges', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view badges' });
    }

    const gameState = await GameState.findOne({ student: req.user._id });
    
    if (!gameState) {
      return res.status(404).json({ message: 'Game state not found' });
    }

    // Group badges by category
    const badgesByCategory = gameState.badges.reduce((acc, badge) => {
      if (!acc[badge.category]) {
        acc[badge.category] = [];
      }
      acc[badge.category].push(badge);
      return acc;
    }, {});

    res.json({
      badges: gameState.badges,
      badgesByCategory,
      totalBadges: gameState.badges.length
    });
  } catch (error) {
    console.error('Get badges error:', error);
    res.status(500).json({ message: 'Error fetching badges' });
  }
});

// Get student's achievements
router.get('/achievements', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view achievements' });
    }

    const gameState = await GameState.findOne({ student: req.user._id });
    
    if (!gameState) {
      return res.status(404).json({ message: 'Game state not found' });
    }

    // Calculate achievement progress
    const achievements = gameState.achievements.map(achievement => {
      let progress = 0;
      
      switch (achievement.id) {
        case 'quiz_master':
          progress = Math.min((gameState.stats.totalQuizzesCompleted / 10) * 100, 100);
          break;
        case 'speed_demon':
          progress = gameState.stats.fastestQuiz ? 
            Math.min((300 - gameState.stats.fastestQuiz) / 300 * 100, 100) : 0;
          break;
        case 'accuracy_expert':
          progress = Math.min(gameState.stats.averageAccuracy, 100);
          break;
        default:
          progress = achievement.progress || 0;
      }

      return {
        ...achievement,
        progress: Math.round(progress)
      };
    });

    res.json({
      achievements,
      totalAchievements: achievements.length,
      completedAchievements: achievements.filter(a => a.progress >= 100).length
    });
  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({ message: 'Error fetching achievements' });
  }
});

// Helper function to calculate overall mastery
function calculateOverallMastery(progressRecords) {
  if (progressRecords.length === 0) return 0;

  const allTopics = new Map();
  
  progressRecords.forEach(record => {
    record.topicMastery.forEach(topic => {
      if (allTopics.has(topic.topic)) {
        const existing = allTopics.get(topic.topic);
        existing.questionsAnswered += topic.questionsAnswered;
        existing.correctAnswers += topic.correctAnswers;
      } else {
        allTopics.set(topic.topic, {
          questionsAnswered: topic.questionsAnswered,
          correctAnswers: topic.correctAnswers
        });
      }
    });
  });

  const topicMasteries = Array.from(allTopics.values()).map(topic => 
    topic.questionsAnswered > 0 ? (topic.correctAnswers / topic.questionsAnswered) * 100 : 0
  );

  return topicMasteries.length > 0 
    ? topicMasteries.reduce((sum, mastery) => sum + mastery, 0) / topicMasteries.length 
    : 0;
}

module.exports = router;
