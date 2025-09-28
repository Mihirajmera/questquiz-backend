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
    }).populate('student', 'name').populate('attempts');

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

// Get detailed individual student analytics
router.get('/student/:studentId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can view detailed student analytics' });
    }

    const { studentId } = req.params;
    const { timeRange = '30d' } = req.query;

    // Calculate date range
    const now = new Date();
    const daysBack = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
    const startDate = new Date(now.getTime() - (daysBack * 24 * 60 * 60 * 1000));

    // Get student information
    const student = await User.findById(studentId);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    // Get instructor's quizzes
    const instructorQuizzes = await Quiz.find({ instructor: req.user._id });
    const quizIds = instructorQuizzes.map(quiz => quiz._id);

    // Get student's progress records for instructor's quizzes
    const progressRecords = await Progress.find({ 
      student: studentId, 
      quiz: { $in: quizIds },
      lastAttempt: { $gte: startDate }
    }).populate('quiz', 'title topics questions');

    if (progressRecords.length === 0) {
      return res.json({
        student: {
          id: student._id,
          name: student.name,
          email: student.email
        },
        message: 'No quiz attempts found for this time period',
        topicAnalysis: [],
        recommendations: [],
        overallStats: {
          totalQuizzes: 0,
          totalAttempts: 0,
          averageScore: 0,
          improvementTrend: 'no_data'
        }
      });
    }

    // Calculate overall statistics
    const totalQuizzes = progressRecords.length;
    const totalAttempts = progressRecords.reduce((sum, record) => sum + record.totalAttempts, 0);
    const averageScore = progressRecords.reduce((sum, record) => sum + record.bestScore, 0) / totalQuizzes;

    // Analyze topic-wise performance
    const topicAnalysis = analyzeTopicPerformance(progressRecords);
    
    // Generate intelligent recommendations
    const recommendations = generateStudentRecommendations(topicAnalysis, progressRecords, student);

    // Calculate improvement trend
    const improvementTrend = calculateImprovementTrend(progressRecords);

    // Quiz-by-quiz performance
    const quizPerformance = progressRecords.map(record => ({
      quizId: record.quiz._id,
      quizTitle: record.quiz.title,
      bestScore: record.bestScore,
      totalAttempts: record.totalAttempts,
      lastAttempt: record.lastAttempt,
      topicMastery: record.topicMastery
    })).sort((a, b) => new Date(b.lastAttempt) - new Date(a.lastAttempt));

    // Weak and strong topics
    const weakTopics = topicAnalysis.filter(topic => topic.mastery < 60).map(topic => topic.topic);
    const strongTopics = topicAnalysis.filter(topic => topic.mastery >= 80).map(topic => topic.topic);

    res.json({
      student: {
        id: student._id,
        name: student.name,
        email: student.email,
        lastLogin: student.lastLogin
      },
      overallStats: {
        totalQuizzes,
        totalAttempts,
        averageScore: Math.round(averageScore),
        improvementTrend,
        timeRange: `${daysBack} days`
      },
      topicAnalysis,
      weakTopics,
      strongTopics,
      quizPerformance,
      recommendations,
      insights: generateStudentInsights(topicAnalysis, progressRecords)
    });

  } catch (error) {
    console.error('Get detailed student analytics error:', error);
    res.status(500).json({ message: 'Error fetching detailed student analytics' });
  }
});

// Helper functions for detailed student analytics
function analyzeTopicPerformance(progressRecords) {
  const topicMap = new Map();
  
  progressRecords.forEach(record => {
    record.topicMastery.forEach(topic => {
      if (topicMap.has(topic.topic)) {
        const existing = topicMap.get(topic.topic);
        existing.totalQuestions += topic.questionsAnswered;
        existing.correctAnswers += topic.correctAnswers;
        existing.quizzesAttempted += 1;
      } else {
        topicMap.set(topic.topic, {
          topic: topic.topic,
          totalQuestions: topic.questionsAnswered,
          correctAnswers: topic.correctAnswers,
          quizzesAttempted: 1
        });
      }
    });
  });

  return Array.from(topicMap.values()).map(topic => ({
    topic: topic.topic,
    mastery: topic.totalQuestions > 0 ? Math.round((topic.correctAnswers / topic.totalQuestions) * 100) : 0,
    totalQuestions: topic.totalQuestions,
    correctAnswers: topic.correctAnswers,
    quizzesAttempted: topic.quizzesAttempted,
    status: topic.totalQuestions > 0 && (topic.correctAnswers / topic.totalQuestions) >= 0.8 ? 'excellent' :
            topic.totalQuestions > 0 && (topic.correctAnswers / topic.totalQuestions) >= 0.6 ? 'good' :
            topic.totalQuestions > 0 && (topic.correctAnswers / topic.totalQuestions) >= 0.4 ? 'needs_improvement' : 'struggling'
  })).sort((a, b) => b.mastery - a.mastery);
}

function generateStudentRecommendations(topicAnalysis, progressRecords, student) {
  const recommendations = [];
  const weakTopics = topicAnalysis.filter(topic => topic.mastery < 60);
  const strongTopics = topicAnalysis.filter(topic => topic.mastery >= 80);
  const averageScore = progressRecords.reduce((sum, record) => sum + record.bestScore, 0) / progressRecords.length;

  // Overall performance recommendations
  if (averageScore < 50) {
    recommendations.push({
      type: 'overall_performance',
      priority: 'high',
      title: 'Overall Performance Needs Attention',
      description: `${student.name} is struggling with the material overall. Consider scheduling a one-on-one session to identify specific learning barriers.`,
      action: 'Schedule individual tutoring session',
      estimatedTime: '30-45 minutes'
    });
  } else if (averageScore < 70) {
    recommendations.push({
      type: 'overall_performance',
      priority: 'medium',
      title: 'Moderate Performance - Room for Improvement',
      description: `${student.name} shows understanding but could benefit from additional practice and targeted support.`,
      action: 'Provide additional practice materials',
      estimatedTime: '15-20 minutes daily'
    });
  }

  // Topic-specific recommendations
  weakTopics.forEach(topic => {
    if (topic.mastery < 40) {
      recommendations.push({
        type: 'topic_reteaching',
        priority: 'high',
        title: `Re-teach: ${topic.topic}`,
        description: `${student.name} is struggling significantly with ${topic.topic} (${topic.mastery}% mastery). This topic needs to be re-taught.`,
        action: 'Re-teach the topic in class with different examples',
        estimatedTime: '20-30 minutes in next class',
        topic: topic.topic
      });
    } else {
      recommendations.push({
        type: 'topic_practice',
        priority: 'medium',
        title: `Extra Practice: ${topic.topic}`,
        description: `${student.name} needs more practice with ${topic.topic} (${topic.mastery}% mastery).`,
        action: 'Assign additional practice problems',
        estimatedTime: '10-15 minutes daily',
        topic: topic.topic
      });
    }
  });

  // Strong topics encouragement
  if (strongTopics.length > 0) {
    recommendations.push({
      type: 'encouragement',
      priority: 'low',
      title: 'Excellent Progress',
      description: `${student.name} excels in: ${strongTopics.map(t => t.topic).join(', ')}. Consider using them as peer tutors for struggling topics.`,
      action: 'Encourage peer tutoring opportunities',
      estimatedTime: 'Optional'
    });
  }

  // Study habits recommendations
  const totalAttempts = progressRecords.reduce((sum, record) => sum + record.totalAttempts, 0);
  if (totalAttempts > progressRecords.length * 3) {
    recommendations.push({
      type: 'study_habits',
      priority: 'medium',
      title: 'Multiple Attempts Pattern',
      description: `${student.name} takes many attempts to complete quizzes. This might indicate rushing or not reading carefully.`,
      action: 'Encourage careful reading and time management',
      estimatedTime: '5-10 minutes per quiz'
    });
  }

  return recommendations;
}

function calculateImprovementTrend(progressRecords) {
  if (progressRecords.length < 2) return 'insufficient_data';
  
  // Sort by last attempt date
  const sortedRecords = progressRecords.sort((a, b) => new Date(a.lastAttempt) - new Date(b.lastAttempt));
  
  const recentScores = sortedRecords.slice(-3).map(r => r.bestScore);
  const olderScores = sortedRecords.slice(0, 3).map(r => r.bestScore);
  
  const recentAvg = recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length;
  const olderAvg = olderScores.reduce((sum, score) => sum + score, 0) / olderScores.length;
  
  const improvement = recentAvg - olderAvg;
  
  if (improvement > 10) return 'improving';
  if (improvement < -10) return 'declining';
  return 'stable';
}

function generateStudentInsights(topicAnalysis, progressRecords) {
  const insights = [];
  const averageScore = progressRecords.reduce((sum, record) => sum + record.bestScore, 0) / progressRecords.length;
  
  // Performance insights
  if (averageScore >= 85) {
    insights.push({
      type: 'performance',
      message: 'Excellent overall performance! This student demonstrates strong mastery of the material.',
      confidence: 'high'
    });
  } else if (averageScore >= 70) {
    insights.push({
      type: 'performance',
      message: 'Good performance with room for improvement in specific areas.',
      confidence: 'medium'
    });
  } else {
    insights.push({
      type: 'performance',
      message: 'Performance indicates need for additional support and targeted intervention.',
      confidence: 'high'
    });
  }

  // Topic diversity insights
  const topicsAttempted = topicAnalysis.length;
  if (topicsAttempted >= 5) {
    insights.push({
      type: 'engagement',
      message: 'High engagement - student attempts quizzes across multiple topics.',
      confidence: 'medium'
    });
  }

  // Consistency insights
  const scoreVariance = calculateScoreVariance(progressRecords.map(r => r.bestScore));
  if (scoreVariance < 100) {
    insights.push({
      type: 'consistency',
      message: 'Consistent performance across different quizzes.',
      confidence: 'medium'
    });
  } else {
    insights.push({
      type: 'consistency',
      message: 'Performance varies significantly - may indicate inconsistent study habits.',
      confidence: 'medium'
    });
  }

  return insights;
}

function calculateScoreVariance(scores) {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + Math.pow(score - mean, 2), 0) / scores.length;
  return variance;
}

// Original helper functions
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
      // Check if completedAt exists and is valid
      if (attempt.completedAt && attempt.completedAt instanceof Date && !isNaN(attempt.completedAt.getTime())) {
        const date = new Date(attempt.completedAt).toISOString().split('T')[0];
        if (!performanceMap.has(date)) {
          performanceMap.set(date, { totalAttempts: 0, totalScore: 0 });
        }
        const dayData = performanceMap.get(date);
        dayData.totalAttempts += 1;
        dayData.totalScore += attempt.score || 0;
      }
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
