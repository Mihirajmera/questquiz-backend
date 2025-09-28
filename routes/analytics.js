const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Quiz = require('../models/Quiz');
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

// Get instructor dashboard analytics
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can view analytics' });
    }

    const { timeRange = '30d' } = req.query;
    
    // Calculate date range
    const now = new Date();
    const daysBack = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
    const startDate = new Date(now.getTime() - (daysBack * 24 * 60 * 60 * 1000));

    // Get instructor's quizzes
    const quizzes = await Quiz.find({ 
      instructor: req.user._id,
      createdAt: { $gte: startDate }
    }).populate('instructor', 'name');

    // Get all progress records for these quizzes
    const quizIds = quizzes.map(quiz => quiz._id);
    const progressRecords = await Progress.find({
      quiz: { $in: quizIds }
    }).populate('student', 'name');

    // Calculate overall statistics
    const totalQuizzes = quizzes.length;
    const totalStudents = new Set(progressRecords.map(p => p.student._id.toString())).size;
    const totalAttempts = progressRecords.reduce((sum, p) => sum + p.totalAttempts, 0);
    const averageScore = progressRecords.length > 0 
      ? progressRecords.reduce((sum, p) => sum + p.bestScore, 0) / progressRecords.length 
      : 0;

    // Quiz performance data
    const quizPerformance = quizzes.map(quiz => {
      const quizProgress = progressRecords.filter(p => p.quiz.toString() === quiz._id.toString());
      const quizAttempts = quizProgress.reduce((sum, p) => sum + p.totalAttempts, 0);
      const quizAverageScore = quizProgress.length > 0 
        ? quizProgress.reduce((sum, p) => sum + p.bestScore, 0) / quizProgress.length 
        : 0;

      return {
        quizId: quiz._id,
        title: quiz.title,
        totalAttempts: quizAttempts,
        averageScore: Math.round(quizAverageScore),
        completionRate: quizProgress.length > 0 ? (quizProgress.length / totalStudents) * 100 : 0,
        createdAt: quiz.createdAt
      };
    });

    // Topic mastery heatmap
    const topicMastery = calculateTopicMastery(progressRecords);

    // Student performance over time
    const performanceOverTime = calculatePerformanceOverTime(progressRecords, daysBack);

    // Top performing students
    const studentPerformance = calculateStudentPerformance(progressRecords);

    res.json({
      overview: {
        totalQuizzes,
        totalStudents,
        totalAttempts,
        averageScore: Math.round(averageScore),
        timeRange: `${daysBack} days`
      },
      quizPerformance,
      topicMastery,
      performanceOverTime,
      topStudents: studentPerformance.slice(0, 10),
      recentActivity: getRecentActivity(progressRecords, 10)
    });
  } catch (error) {
    console.error('Get dashboard analytics error:', error);
    res.status(500).json({ message: 'Error fetching dashboard analytics' });
  }
});

// Get detailed quiz analytics
router.get('/quiz/:quizId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can view quiz analytics' });
    }

    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Check if user owns this quiz
    if (quiz.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const progressRecords = await Progress.find({ quiz: quiz._id })
      .populate('student', 'name');

    // Question-level analytics
    const questionAnalytics = quiz.questions.map(question => {
      const questionAnswers = progressRecords.flatMap(record => 
        record.attempts.flatMap(attempt => 
          attempt.answers.filter(answer => answer.questionId === question.questionId)
        )
      );

      const correctAnswers = questionAnswers.filter(answer => answer.isCorrect).length;
      const totalAnswers = questionAnswers.length;
      const accuracy = totalAnswers > 0 ? (correctAnswers / totalAnswers) * 100 : 0;
      const averageTime = questionAnswers.length > 0 
        ? questionAnswers.reduce((sum, answer) => sum + answer.timeSpent, 0) / questionAnswers.length 
        : 0;

      return {
        questionId: question.questionId,
        text: question.text,
        type: question.type,
        topic: question.topic,
        difficulty: question.difficulty,
        accuracy: Math.round(accuracy),
        totalAnswers,
        correctAnswers,
        averageTime: Math.round(averageTime)
      };
    });

    // Topic performance
    const topicPerformance = calculateTopicPerformance(progressRecords, quiz.topics);

    // Student performance
    const studentPerformance = progressRecords.map(record => ({
      studentId: record.student._id,
      studentName: record.student.name,
      bestScore: record.bestScore,
      totalAttempts: record.totalAttempts,
      lastAttempt: record.lastAttempt,
      topicMastery: record.topicMastery
    }));

    // Score distribution
    const scoreDistribution = calculateScoreDistribution(progressRecords);

    res.json({
      quiz: {
        id: quiz._id,
        title: quiz.title,
        totalQuestions: quiz.totalQuestions,
        topics: quiz.topics
      },
      questionAnalytics,
      topicPerformance,
      studentPerformance,
      scoreDistribution,
      summary: {
        totalStudents: progressRecords.length,
        totalAttempts: progressRecords.reduce((sum, p) => sum + p.totalAttempts, 0),
        averageScore: progressRecords.length > 0 
          ? Math.round(progressRecords.reduce((sum, p) => sum + p.bestScore, 0) / progressRecords.length)
          : 0
      }
    });
  } catch (error) {
    console.error('Get quiz analytics error:', error);
    res.status(500).json({ message: 'Error fetching quiz analytics' });
  }
});

// Get student analytics for instructors
router.get('/students', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can view student analytics' });
    }

    // Get all students who have attempted instructor's quizzes
    const instructorQuizzes = await Quiz.find({ instructor: req.user._id });
    const quizIds = instructorQuizzes.map(quiz => quiz._id);
    
    const progressRecords = await Progress.find({ quiz: { $in: quizIds } })
      .populate('student', 'name email')
      .populate('quiz', 'title');

    // Group by student
    const studentMap = new Map();
    progressRecords.forEach(record => {
      const studentId = record.student._id.toString();
      if (!studentMap.has(studentId)) {
        studentMap.set(studentId, {
          student: record.student,
          quizzes: [],
          totalAttempts: 0,
          averageScore: 0,
          lastActivity: null
        });
      }

      const studentData = studentMap.get(studentId);
      studentData.quizzes.push({
        quizId: record.quiz._id,
        quizTitle: record.quiz.title,
        bestScore: record.bestScore,
        attempts: record.totalAttempts
      });
      studentData.totalAttempts += record.totalAttempts;
      studentData.lastActivity = record.lastAttempt > studentData.lastActivity 
        ? record.lastAttempt 
        : studentData.lastActivity;
    });

    // Calculate averages and sort
    const students = Array.from(studentMap.values()).map(studentData => {
      const averageScore = studentData.quizzes.length > 0 
        ? studentData.quizzes.reduce((sum, q) => sum + q.bestScore, 0) / studentData.quizzes.length 
        : 0;

      return {
        ...studentData,
        averageScore: Math.round(averageScore)
      };
    }).sort((a, b) => b.averageScore - a.averageScore);

    res.json({ students });
  } catch (error) {
    console.error('Get student analytics error:', error);
    res.status(500).json({ message: 'Error fetching student analytics' });
  }
});

// Helper functions
function calculateTopicMastery(progressRecords) {
  const topicMap = new Map();
  
  progressRecords.forEach(record => {
    record.topicMastery.forEach(topic => {
      if (topicMap.has(topic.topic)) {
        const existing = topicMap.get(topic.topic);
        existing.totalQuestions += topic.questionsAnswered;
        existing.correctAnswers += topic.correctAnswers;
        existing.students += 1;
      } else {
        topicMap.set(topic.topic, {
          topic: topic.topic,
          totalQuestions: topic.questionsAnswered,
          correctAnswers: topic.correctAnswers,
          students: 1
        });
      }
    });
  });

  return Array.from(topicMap.values()).map(topic => ({
    topic: topic.topic,
    mastery: topic.totalQuestions > 0 ? Math.round((topic.correctAnswers / topic.totalQuestions) * 100) : 0,
    totalQuestions: topic.totalQuestions,
    students: topic.students
  }));
}

function calculatePerformanceOverTime(progressRecords, daysBack) {
  const performanceMap = new Map();
  
  progressRecords.forEach(record => {
    record.attempts.forEach(attempt => {
      const date = new Date(attempt.completedAt).toISOString().split('T')[0];
      if (!performanceMap.has(date)) {
        performanceMap.set(date, { totalAttempts: 0, totalScore: 0 });
      }
      const dayData = performanceMap.get(date);
      dayData.totalAttempts += 1;
      dayData.totalScore += attempt.score;
    });
  });

  return Array.from(performanceMap.entries()).map(([date, data]) => ({
    date,
    averageScore: Math.round(data.totalScore / data.totalAttempts),
    totalAttempts: data.totalAttempts
  })).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function calculateStudentPerformance(progressRecords) {
  const studentMap = new Map();
  
  progressRecords.forEach(record => {
    const studentId = record.student._id.toString();
    if (!studentMap.has(studentId)) {
      studentMap.set(studentId, {
        student: record.student,
        totalQuizzes: 0,
        totalScore: 0,
        totalAttempts: 0
      });
    }
    
    const studentData = studentMap.get(studentId);
    studentData.totalQuizzes += 1;
    studentData.totalScore += record.bestScore;
    studentData.totalAttempts += record.totalAttempts;
  });

  return Array.from(studentMap.values()).map(student => ({
    ...student,
    averageScore: Math.round(student.totalScore / student.totalQuizzes)
  })).sort((a, b) => b.averageScore - a.averageScore);
}

function calculateTopicPerformance(progressRecords, topics) {
  const topicMap = new Map();
  
  topics.forEach(topic => {
    topicMap.set(topic.name, {
      topic: topic.name,
      totalQuestions: 0,
      correctAnswers: 0,
      students: 0
    });
  });

  progressRecords.forEach(record => {
    record.topicMastery.forEach(topic => {
      if (topicMap.has(topic.topic)) {
        const topicData = topicMap.get(topic.topic);
        topicData.totalQuestions += topic.questionsAnswered;
        topicData.correctAnswers += topic.correctAnswers;
        topicData.students += 1;
      }
    });
  });

  return Array.from(topicMap.values()).map(topic => ({
    ...topic,
    mastery: topic.totalQuestions > 0 ? Math.round((topic.correctAnswers / topic.totalQuestions) * 100) : 0
  }));
}

function calculateScoreDistribution(progressRecords) {
  const distribution = {
    '0-20': 0,
    '21-40': 0,
    '41-60': 0,
    '61-80': 0,
    '81-100': 0
  };

  progressRecords.forEach(record => {
    const score = record.bestScore;
    if (score <= 20) distribution['0-20']++;
    else if (score <= 40) distribution['21-40']++;
    else if (score <= 60) distribution['41-60']++;
    else if (score <= 80) distribution['61-80']++;
    else distribution['81-100']++;
  });

  return distribution;
}

function getRecentActivity(progressRecords, limit) {
  const activities = [];
  
  progressRecords.forEach(record => {
    record.attempts.forEach(attempt => {
      if (attempt.completedAt) {
        activities.push({
          student: record.student,
          quiz: record.quiz,
          score: attempt.score,
          completedAt: attempt.completedAt
        });
      }
    });
  });

  return activities
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
    .slice(0, limit);
}

module.exports = router;
