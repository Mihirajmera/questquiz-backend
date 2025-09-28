const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Quiz = require('../models/Quiz');
const aiService = require('../services/aiService');
const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, DOCX, and TXT files are allowed.'), false);
    }
  }
});

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

// Upload lecture and generate quiz
router.post('/lecture', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    // Check if user is instructor
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can upload lectures' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const { title, description, timeLimit, numQuestions } = req.body;

    // Extract text from uploaded file
    const extractedText = await aiService.extractTextFromFile(req.file);
    
    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ message: 'Could not extract text from file' });
    }

    // Extract topics from the content
    const topics = await aiService.extractTopics(extractedText);

    // Generate questions using AI
    const questions = await aiService.generateQuestions(
      extractedText, 
      topics, 
      parseInt(numQuestions) || 10
    );

    // Create quiz in database
    const quiz = new Quiz({
      title: title || req.file.originalname,
      description: description || '',
      instructor: req.user._id,
      lectureId: `lecture_${Date.now()}`,
      lectureTitle: title || req.file.originalname,
      questions: questions,
      topics: topics,
      timeLimit: parseInt(timeLimit) || 30,
      settings: {
        allowRetake: true,
        showCorrectAnswers: true,
        adaptiveMode: true
      }
    });

    await quiz.save();

    res.json({
      message: 'Quiz generated successfully',
      quiz: {
        id: quiz._id,
        title: quiz.title,
        description: quiz.description,
        totalQuestions: quiz.totalQuestions,
        timeLimit: quiz.timeLimit,
        topics: quiz.topics,
        createdAt: quiz.createdAt
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      message: 'Error processing lecture upload',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Get instructor's quizzes
router.get('/quizzes', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can view their quizzes' });
    }

    const quizzes = await Quiz.find({ instructor: req.user._id })
      .select('title description totalQuestions timeLimit createdAt stats')
      .sort({ createdAt: -1 });

    res.json({ quizzes });
  } catch (error) {
    console.error('Get quizzes error:', error);
    res.status(500).json({ message: 'Error fetching quizzes' });
  }
});

// Get specific quiz details
router.get('/quiz/:id', authenticateToken, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
    
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Check if user has access to this quiz
    if (req.user.role === 'instructor' && quiz.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({ quiz });
  } catch (error) {
    console.error('Get quiz error:', error);
    res.status(500).json({ message: 'Error fetching quiz' });
  }
});

// Update quiz settings
router.put('/quiz/:id', authenticateToken, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
    
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Check if user is the instructor
    if (quiz.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const { title, description, timeLimit, settings } = req.body;

    if (title) quiz.title = title;
    if (description !== undefined) quiz.description = description;
    if (timeLimit) quiz.timeLimit = timeLimit;
    if (settings) quiz.settings = { ...quiz.settings, ...settings };

    await quiz.save();

    res.json({ message: 'Quiz updated successfully', quiz });
  } catch (error) {
    console.error('Update quiz error:', error);
    res.status(500).json({ message: 'Error updating quiz' });
  }
});

// Delete quiz
router.delete('/quiz/:id', authenticateToken, async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
    
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    // Check if user is the instructor
    if (quiz.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await Quiz.findByIdAndDelete(req.params.id);

    res.json({ message: 'Quiz deleted successfully' });
  } catch (error) {
    console.error('Delete quiz error:', error);
    res.status(500).json({ message: 'Error deleting quiz' });
  }
});

module.exports = router;
