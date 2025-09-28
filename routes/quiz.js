const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Quiz = require('../models/Quiz');
const Class = require('../models/Class');
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
      console.log('❌ User not found with ID:', decoded.userId);
      return res.status(404).json({ message: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('❌ Token verification error:', error.message);
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Get available quizzes for students (filtered by enrolled classes)
router.get('/available', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view available quizzes' });
    }

    // Get student's enrolled class IDs
    const enrolledClassIds = req.user.enrolledClasses
      .filter(ec => ec.isActive)
      .map(ec => ec.class);

    const quizzes = await Quiz.find({ 
      isActive: true,
      class: { $in: enrolledClassIds }
    })
      .select('title description totalQuestions timeLimit topics createdAt stats class')
      .populate('instructor', 'name')
      .populate('class', 'name code')
      .sort({ createdAt: -1 });

    res.json({ quizzes });
  } catch (error) {
    console.error('Get available quizzes error:', error);
    res.status(500).json({ message: 'Error fetching quizzes' });
  }
});

// Get quizzes for a specific class
router.get('/class/:classId', authenticateToken, async (req, res) => {
  try {
    const { classId } = req.params;

    if (!classId || classId === 'undefined' || classId === 'null') {
      return res.status(400).json({
        message: 'Invalid class ID provided',
        receivedId: classId
      });
    }

    // Check if user has access to this class
    let hasAccess = false;
    
    if (req.user.role === 'instructor') {
      // Check if instructor owns this class
      const Class = require('../models/Class');
      const classExists = await Class.findOne({
        _id: classId,
        instructor: req.user._id,
        isActive: true
      });
      hasAccess = !!classExists;
    } else if (req.user.role === 'student') {
      // Check if student is enrolled in this class
      hasAccess = req.user.enrolledClasses.some(ec => 
        ec.class.toString() === classId && ec.isActive
      );
    }

    if (!hasAccess) {
      return res.status(403).json({ message: 'Access denied to this class' });
    }

    // Get quizzes for this class
    const quizzes = await Quiz.find({ 
      class: classId,
      isActive: true
    })
      .select('title description totalQuestions timeLimit topics createdAt stats adaptiveMode adaptiveSettings')
      .populate('instructor', 'name email')
      .populate('class', 'name code')
      .sort({ createdAt: -1 });

    res.json({ 
      quizzes,
      class: quizzes.length > 0 ? quizzes[0].class : null,
      totalQuizzes: quizzes.length
    });
  } catch (error) {
    console.error('Get class quizzes error:', error);
    res.status(500).json({ message: 'Error fetching class quizzes' });
  }
});

// Get instructor's quizzes for a specific class
router.get('/instructor/class/:classId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can view their class quizzes' });
    }

    const { classId } = req.params;

    if (!classId || classId === 'undefined' || classId === 'null') {
      return res.status(400).json({
        message: 'Invalid class ID provided',
        receivedId: classId
      });
    }

    // Verify the class belongs to the instructor
    const Class = require('../models/Class');
    const classExists = await Class.findOne({
      _id: classId,
      instructor: req.user._id,
      isActive: true
    });

    if (!classExists) {
      return res.status(404).json({ message: 'Class not found or access denied' });
    }

    // Get all quizzes for this class (including inactive ones for management)
    const quizzes = await Quiz.find({ 
      class: classId
    })
      .select('title description totalQuestions timeLimit topics createdAt stats isActive adaptiveMode adaptiveSettings')
      .populate('class', 'name code')
      .sort({ createdAt: -1 });

    res.json({ 
      quizzes,
      class: {
        id: classExists._id,
        name: classExists.name,
        code: classExists.code,
        description: classExists.description
      },
      totalQuizzes: quizzes.length,
      activeQuizzes: quizzes.filter(q => q.isActive).length
    });
  } catch (error) {
    console.error('Get instructor class quizzes error:', error);
    res.status(500).json({ message: 'Error fetching instructor class quizzes' });
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
      return res.status(400).json({ 
        message: 'Invalid quiz ID provided',
        receivedId: quizId,
        expectedFormat: '/api/quiz/start/:quizId'
      });
    }

    const quiz = await Quiz.findById(quizId).populate('class');
    if (!quiz) {
      console.log('❌ Quiz not found with ID:', quizId);
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Check if student is enrolled in the class
    const isEnrolled = req.user.enrolledClasses.some(ec => 
      ec.class.toString() === quiz.class._id.toString() && ec.isActive
    );

    if (!isEnrolled) {
      return res.status(403).json({ message: 'You are not enrolled in this class' });
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
      timeSpent: 0,
      correctAnswers: 0,
      isCompleted: false
    });

    await attempt.save();

    // Add attempt to progress (store the full attempt object, not just the ID)
    progress.attempts.push(attempt._id);
    progress.totalAttempts += 1;
    progress.lastAttempt = new Date();
    
    // Save progress
    await progress.save();

    // Get first question (adaptive or random)
    let firstQuestion;
    if (quiz.settings.adaptiveMode) {
      // Find the first easy question for adaptive tests
      firstQuestion = quiz.questions.find(q => q.difficulty === 'easy') || quiz.questions[0];
    } else {
      firstQuestion = quiz.questions[0];
    }

    res.json({
      message: 'Quiz started successfully',
      attemptId: attempt._id,
      quiz: {
        id: quiz._id,
        title: quiz.title,
        totalQuestions: quiz.totalQuestions,
        timeLimit: quiz.timeLimit,
        adaptiveMode: quiz.settings.adaptiveMode,
        adaptiveSettings: quiz.settings.adaptiveSettings
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

// Test Gemini API endpoint (for development/testing purposes)
router.get('/test-gemini', async (req, res) => {
  try {
    console.log('🧪 Testing Gemini API...');
    
    // Test simple prompt
    const testPrompt = "Hello! Please respond with 'Gemini API is working correctly!' if you can read this.";
    
    const result = await aiService.gemini.generateContent(testPrompt);
    const response = await result.response;
    const text = response.text();

    // Test quiz generation capability
    const quizPrompt = `
      Generate 2 simple quiz questions about JavaScript. Return a JSON array with this format:
      [
        {
          "questionId": "q1",
          "text": "What is JavaScript?",
          "type": "multiple-choice",
          "options": [
            {"text": "A programming language", "isCorrect": true},
            {"text": "A markup language", "isCorrect": false}
          ],
          "correctAnswer": "A programming language",
          "topic": "JavaScript Basics",
          "difficulty": "easy",
          "explanation": "JavaScript is a programming language",
          "points": 5
        }
      ]
    `;

    const quizResult = await aiService.gemini.generateContent(quizPrompt);
    const quizResponse = await quizResult.response;
    const quizText = quizResponse.text();

    res.json({
      status: 'success',
      message: 'Gemini API is working correctly!',
      tests: {
        basicConnection: {
          status: 'passed',
          response: text.trim()
        },
        quizGeneration: {
          status: 'passed',
          response: quizText.trim()
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Gemini API test failed:', error);
    
    res.status(500).json({
      status: 'error',
      message: 'Gemini API test failed',
      error: error.message,
      suggestions: [
        'Check if GEMINI_API_KEY is set in your .env file',
        'Verify the API key is correct and has proper permissions',
        'Ensure you have enabled the Gemini API in Google Cloud Console',
        'Check your API quota and billing settings'
      ],
      timestamp: new Date().toISOString()
    });
  }
});

// Get next adaptive question based on performance
router.get('/adaptive/next/:attemptId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can take adaptive quizzes' });
    }

    const { attemptId } = req.params;
    const attempt = await Attempt.findById(attemptId).populate('quiz');
    
    if (!attempt) {
      return res.status(404).json({ message: 'Attempt not found' });
    }

    if (attempt.student.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (!attempt.quiz.settings.adaptiveMode) {
      return res.status(400).json({ message: 'This quiz is not in adaptive mode' });
    }

    // Calculate current performance
    const answeredQuestions = attempt.answers.length;
    if (answeredQuestions === 0) {
      // First question - start with easy
      const easyQuestion = attempt.quiz.questions.find(q => q.difficulty === 'easy');
      return res.json({
        question: easyQuestion,
        questionNumber: answeredQuestions + 1,
        performance: null
      });
    }

    const correctAnswers = attempt.answers.filter(a => a.isCorrect).length;
    const currentAccuracy = correctAnswers / answeredQuestions;

    // Determine next difficulty based on performance
    let nextDifficulty;
    if (currentAccuracy >= 0.8) {
      nextDifficulty = 'hard';
    } else if (currentAccuracy >= 0.6) {
      nextDifficulty = 'medium';
    } else {
      nextDifficulty = 'easy';
    }

    // Find next question of appropriate difficulty
    const availableQuestions = attempt.quiz.questions.filter(q => 
      q.difficulty === nextDifficulty && 
      !attempt.answers.some(a => a.questionId === q.questionId)
    );

    if (availableQuestions.length === 0) {
      // No more questions of this difficulty, try others
      const allRemainingQuestions = attempt.quiz.questions.filter(q => 
        !attempt.answers.some(a => a.questionId === q.questionId)
      );
      
      if (allRemainingQuestions.length === 0) {
        return res.json({
          message: 'No more questions available',
          quizComplete: true,
          performance: {
            accuracy: currentAccuracy,
            difficulty: nextDifficulty
          }
        });
      }

      const nextQuestion = allRemainingQuestions[0];
      return res.json({
        question: nextQuestion,
        questionNumber: answeredQuestions + 1,
        performance: {
          accuracy: currentAccuracy,
          difficulty: nextDifficulty
        }
      });
    }

    const nextQuestion = availableQuestions[0];
    res.json({
      question: nextQuestion,
      questionNumber: answeredQuestions + 1,
      performance: {
        accuracy: currentAccuracy,
        difficulty: nextDifficulty
      }
    });

  } catch (error) {
    console.error('Get next adaptive question error:', error);
    res.status(500).json({ message: 'Error getting next question' });
  }
});

module.exports = router;
