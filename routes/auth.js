const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const GameState = require('../models/GameState');
const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validation
    if (!name || !email || !password || !role) {
      return res.status(400).json({ 
        message: 'All fields are required',
        details: 'Please fill in all the required fields'
      });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        message: 'Invalid email format',
        details: 'Please enter a valid email address'
      });
    }

    // Password validation
    if (password.length < 6) {
      return res.status(400).json({ 
        message: 'Password too short',
        details: 'Password must be at least 6 characters long'
      });
    }

    // Name validation
    if (name.trim().length < 2) {
      return res.status(400).json({ 
        message: 'Name too short',
        details: 'Name must be at least 2 characters long'
      });
    }

    // Role validation
    if (!['instructor', 'student'].includes(role)) {
      return res.status(400).json({ 
        message: 'Invalid role',
        details: 'Role must be either instructor or student'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ 
        message: 'Email already registered',
        details: 'An account with this email already exists. Please use a different email or try logging in.'
      });
    }

    // Create user
    const user = new User({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
      role
    });

    await user.save();

    // Create game state for students
    if (role === 'student') {
      const gameState = new GameState({
        student: user._id,
        xp: 0,
        level: 1,
        currentLevel: {
          level: 1,
          name: 'Level 1',
          xpRequired: 100,
          unlockedAt: new Date()
        },
        badges: [],
        streaks: {
          current: 0,
          longest: 0,
          lastActivity: new Date()
        },
        stats: {
          totalQuizzesCompleted: 0,
          totalQuestionsAnswered: 0,
          totalCorrectAnswers: 0,
          averageAccuracy: 0,
          totalTimeSpent: 0,
          fastestQuiz: null
        },
        unlockedWorlds: [],
        achievements: []
      });

      await gameState.save();
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle specific MongoDB errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ 
        message: 'Validation failed',
        details: errors.join(', ')
      });
    }
    
    if (error.code === 11000) {
      return res.status(400).json({ 
        message: 'Email already registered',
        details: 'An account with this email already exists. Please use a different email or try logging in.'
      });
    }
    
    res.status(500).json({ 
      message: 'Server error during registration',
      details: 'Something went wrong on our end. Please try again later.'
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET || 'fallback-secret',
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// Get current user
router.get('/me', async (req, res) => {
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

    res.json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(401).json({ message: 'Invalid token' });
  }
});

// Get all users (for testing purposes)
router.get('/users', async (req, res) => {
  try {
    const users = await User.find({}, 'name email role createdAt lastLogin').sort({ createdAt: -1 });
    res.json({
      message: 'Users retrieved successfully',
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Error fetching users' });
  }
});

module.exports = router;
