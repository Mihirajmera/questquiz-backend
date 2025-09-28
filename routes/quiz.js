const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Quiz = require('../models/Quiz');
const { Progress, Attempt } = require('../models/Progress');
const GameState = require('../models/GameState');
const aiService = require('../services/aiService');
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

// Get available quizzes for students
router.get('/available', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view available quizzes' });
    }

    const quizzes = await Quiz.find({ isActive: true })
      .select('title description totalQuestions timeLimit topics createdAt stats')
      .populate('instructor', 'name')
      .sort({ createdAt: -1 });

    res.json({ quizzes });
  } catch (error) {
    console.error('Get available quizzes error:', error);
    res.status(500).json({ message: 'Error fetching quizzes' });
  }
});

// Start a quiz attempt
router.post('/start/:quizId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can start quizzes' });
    }

    // Validate quizId parameter
    const { quizId } = req.params;
    if (!quizId || quizId === 'undefined' || quizId === 'null') {
      return res.status(400).json({ message: 'Invalid quiz ID provided' });
    }

    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Check if quiz is active
    if (!quiz.isActive) {
      return res.status(400).json({ message: 'Quiz is not active' });
    }

    // Get or create progress record
    let progress = await Progress.findOne({
      student: req.user._id,
      quiz: quiz._id
    });

    if (!progress) {
      progress = new Progress({
        student: req.user._id,
        quiz: quiz._id,
        attempts: [],
        bestScore: 0,
        totalAttempts: 0,
        topicMastery: quiz.topics.map(topic => ({
          topic: topic.name,
          mastery: 0,
          questionsAnswered: 0,
          correctAnswers: 0
        })),
        weakTopics: [],
        strongTopics: []
      });
      await progress.save();
    }

    // Create new attempt
    const attempt = new Attempt({
      student: req.user._id,
      quiz: quiz._id,
      answers: [],
      totalQuestions: quiz.totalQuestions,
      timeSpent: 0
    });

    await attempt.save();

    // Add attempt to progress
    progress.attempts.push(attempt._id);
    progress.totalAttempts += 1;
    progress.lastAttempt = new Date();
    await progress.save();

    // Get first question (adaptive or random)
    const firstQuestion = quiz.questions[0]; // For now, start with first question

    res.json({
      message: 'Quiz started successfully',
      attemptId: attempt._id,
      quiz: {
        id: quiz._id,
        title: quiz.title,
        totalQuestions: quiz.totalQuestions,
        timeLimit: quiz.timeLimit
      },
      currentQuestion: firstQuestion,
      questionNumber: 1,
      timeRemaining: quiz.timeLimit * 60 // Convert to seconds
    });
  } catch (error) {
    console.error('Start quiz error:', error);
    res.status(500).json({ message: 'Error starting quiz' });
  }
});

// Submit answer and get next question
router.post('/submit-answer', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can submit answers' });
    }

    const { attemptId, questionId, answer, timeSpent } = req.body;

    const attempt = await Attempt.findById(attemptId);
    if (!attempt) {
      return res.status(404).json({ message: 'Quiz attempt not found' });
    }

    // Check if attempt belongs to user
    if (attempt.student.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get quiz to find the question
    const quiz = await Quiz.findById(attempt.quiz);
    const question = quiz.questions.find(q => q.questionId === questionId);
    
    if (!question) {
      return res.status(404).json({ message: 'Question not found' });
    }

    // Check if answer is correct
    let isCorrect = false;
    if (question.type === 'multiple-choice' || question.type === 'true-false') {
      isCorrect = answer === question.correctAnswer;
    } else if (question.type === 'short-answer') {
      // For short answers, do a simple comparison (could be enhanced with AI)
      isCorrect = answer.toLowerCase().trim() === question.correctAnswer.toLowerCase().trim();
    }

    // Add answer to attempt
    const answerData = {
      questionId,
      answer,
      isCorrect,
      timeSpent: timeSpent || 0,
      timestamp: new Date()
    };

    attempt.answers.push(answerData);
    attempt.timeSpent += timeSpent || 0;

    if (isCorrect) {
      attempt.correctAnswers += 1;
    }

    await attempt.save();

    // Update progress
    const progress = await Progress.findOne({
      student: req.user._id,
      quiz: attempt.quiz
    });

    if (progress) {
      // Update topic mastery
      const topicIndex = progress.topicMastery.findIndex(tm => tm.topic === question.topic);
      if (topicIndex !== -1) {
        progress.topicMastery[topicIndex].questionsAnswered += 1;
        if (isCorrect) {
          progress.topicMastery[topicIndex].correctAnswers += 1;
        }
        progress.topicMastery[topicIndex].mastery = 
          (progress.topicMastery[topicIndex].correctAnswers / progress.topicMastery[topicIndex].questionsAnswered) * 100;
      }
    }

    // Check if quiz is complete
    if (attempt.answers.length >= quiz.totalQuestions) {
      // Calculate final score
      attempt.score = (attempt.correctAnswers / quiz.totalQuestions) * 100;
      attempt.isCompleted = true;
      attempt.completedAt = new Date();
      await attempt.save();

      // Update progress
      if (progress) {
        if (attempt.score > progress.bestScore) {
          progress.bestScore = attempt.score;
        }

        // Update weak and strong topics
        progress.weakTopics = progress.topicMastery
          .filter(tm => tm.mastery < 70 && tm.questionsAnswered > 0)
          .map(tm => tm.topic);
        
        progress.strongTopics = progress.topicMastery
          .filter(tm => tm.mastery >= 80 && tm.questionsAnswered > 0)
          .map(tm => tm.topic);

        await progress.save();
      }

      // Update game state
      await updateGameState(req.user._id, attempt, quiz);

      return res.json({
        message: 'Quiz completed!',
        completed: true,
        score: attempt.score,
        correctAnswers: attempt.correctAnswers,
        totalQuestions: quiz.totalQuestions,
        timeSpent: attempt.timeSpent,
        nextQuestion: null
      });
    }

    // Get next question (adaptive logic)
    const nextQuestion = getNextQuestion(quiz, attempt, progress);
    const questionNumber = attempt.answers.length + 1;

    res.json({
      message: 'Answer submitted successfully',
      completed: false,
      isCorrect,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      nextQuestion,
      questionNumber,
      timeRemaining: quiz.timeLimit * 60 - attempt.timeSpent
    });
  } catch (error) {
    console.error('Submit answer error:', error);
    res.status(500).json({ message: 'Error submitting answer' });
  }
});

// Get quiz results
router.get('/results/:attemptId', authenticateToken, async (req, res) => {
  try {
    const attempt = await Attempt.findById(req.params.attemptId)
      .populate('quiz', 'title questions topics');

    if (!attempt) {
      return res.status(404).json({ message: 'Quiz attempt not found' });
    }

    // Check if attempt belongs to user
    if (attempt.student.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Get progress for topic analysis
    const progress = await Progress.findOne({
      student: req.user._id,
      quiz: attempt.quiz._id
    });

    res.json({
      attempt: {
        id: attempt._id,
        score: attempt.score,
        correctAnswers: attempt.correctAnswers,
        totalQuestions: attempt.totalQuestions,
        timeSpent: attempt.timeSpent,
        completedAt: attempt.completedAt,
        answers: attempt.answers
      },
      quiz: {
        id: attempt.quiz._id,
        title: attempt.quiz.title,
        questions: attempt.quiz.questions,
        topics: attempt.quiz.topics
      },
      progress: progress ? {
        bestScore: progress.bestScore,
        totalAttempts: progress.totalAttempts,
        topicMastery: progress.topicMastery,
        weakTopics: progress.weakTopics,
        strongTopics: progress.strongTopics
      } : null
    });
  } catch (error) {
    console.error('Get results error:', error);
    res.status(500).json({ message: 'Error fetching results' });
  }
});

// Helper function to get next question (adaptive logic)
function getNextQuestion(quiz, attempt, progress) {
  // Simple adaptive logic - prioritize weak topics
  if (progress && progress.weakTopics.length > 0) {
    const weakTopicQuestions = quiz.questions.filter(q => 
      progress.weakTopics.includes(q.topic) && 
      !attempt.answers.find(a => a.questionId === q.questionId)
    );
    
    if (weakTopicQuestions.length > 0) {
      return weakTopicQuestions[0];
    }
  }

  // Fallback to random unanswered question
  const unansweredQuestions = quiz.questions.filter(q => 
    !attempt.answers.find(a => a.questionId === q.questionId)
  );

  if (unansweredQuestions.length > 0) {
    return unansweredQuestions[Math.floor(Math.random() * unansweredQuestions.length)];
  }

  return null;
}

// Helper function to update game state
async function updateGameState(userId, attempt, quiz) {
  try {
    let gameState = await GameState.findOne({ student: userId });
    
    if (!gameState) {
      gameState = new GameState({ student: userId });
    }

    // Calculate XP based on performance
    const baseXP = 50;
    const accuracyBonus = Math.floor(attempt.score / 10) * 10;
    const speedBonus = attempt.timeSpent < quiz.timeLimit * 30 ? 20 : 0; // Bonus for finishing early
    const totalXP = baseXP + accuracyBonus + speedBonus;

    // Add XP and check for level up
    const levelResult = gameState.addXP(totalXP, 'quiz_completion');

    // Update stats
    gameState.stats.totalQuizzesCompleted += 1;
    gameState.stats.totalQuestionsAnswered += attempt.totalQuestions;
    gameState.stats.totalCorrectAnswers += attempt.correctAnswers;
    gameState.stats.averageAccuracy = 
      (gameState.stats.totalCorrectAnswers / gameState.stats.totalQuestionsAnswered) * 100;
    gameState.stats.totalTimeSpent += Math.floor(attempt.timeSpent / 60); // Convert to minutes

    if (!gameState.stats.fastestQuiz || attempt.timeSpent < gameState.stats.fastestQuiz) {
      gameState.stats.fastestQuiz = attempt.timeSpent;
    }

    // Update streak
    const now = new Date();
    const lastActivity = new Date(gameState.streaks.lastActivity);
    const daysDiff = Math.floor((now - lastActivity) / (1000 * 60 * 60 * 24));

    if (daysDiff === 1) {
      gameState.streaks.current += 1;
    } else if (daysDiff > 1) {
      gameState.streaks.current = 1;
    }

    if (gameState.streaks.current > gameState.streaks.longest) {
      gameState.streaks.longest = gameState.streaks.current;
    }

    gameState.streaks.lastActivity = now;

    // Check for new badges
    const newBadges = gameState.checkBadges();

    await gameState.save();

    return {
      levelResult,
      newBadges,
      xpGained: totalXP
    };
  } catch (error) {
    console.error('Update game state error:', error);
    return null;
  }
}

module.exports = router;
