const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Class = require('../models/Class');
const Quiz = require('../models/Quiz');
const { Progress } = require('../models/Progress');
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

// Create a new class (Instructor only)
router.post('/create', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can create classes' });
    }

    const { name, description, settings } = req.body;

    // Generate unique class code
    const code = await Class.generateClassCode();

    // Create new class
    const newClass = new Class({
      name,
      description: description || '',
      code,
      instructor: req.user._id,
      settings: {
        allowStudentJoin: settings?.allowStudentJoin ?? true,
        maxStudents: settings?.maxStudents ?? 100,
        requireApproval: settings?.requireApproval ?? false
      }
    });

    await newClass.save();

    // Add class to instructor's created classes
    req.user.createdClasses.push(newClass._id);
    await req.user.save();

    res.status(201).json({
      message: 'Class created successfully',
      class: {
        id: newClass._id,
        name: newClass.name,
        code: newClass.code,
        description: newClass.description,
        settings: newClass.settings,
        createdAt: newClass.createdAt
      }
    });
  } catch (error) {
    console.error('Create class error:', error);
    res.status(500).json({ message: 'Error creating class' });
  }
});

// Join a class using class code (Student only)
router.post('/join', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can join classes' });
    }

    const { classCode } = req.body;

    if (!classCode) {
      return res.status(400).json({ message: 'Class code is required' });
    }

    // Find class by code
    const classToJoin = await Class.findOne({ 
      code: classCode.toUpperCase(),
      isActive: true,
      'settings.allowStudentJoin': true
    });

    if (!classToJoin) {
      return res.status(404).json({ message: 'Invalid class code or class not accepting new students' });
    }

    // Check if student is already enrolled
    const alreadyEnrolled = classToJoin.students.find(
      s => s.student.toString() === req.user._id.toString()
    );

    if (alreadyEnrolled) {
      return res.status(400).json({ message: 'You are already enrolled in this class' });
    }

    // Check if class has reached max capacity
    if (classToJoin.students.length >= classToJoin.settings.maxStudents) {
      return res.status(400).json({ message: 'Class has reached maximum capacity' });
    }

    // Add student to class
    classToJoin.students.push({
      student: req.user._id,
      joinedAt: new Date(),
      isActive: true
    });

    await classToJoin.save();

    // Add class to student's enrolled classes
    req.user.enrolledClasses.push({
      class: classToJoin._id,
      joinedAt: new Date(),
      isActive: true
    });

    await req.user.save();

    res.json({
      message: 'Successfully joined class',
      class: {
        id: classToJoin._id,
        name: classToJoin.name,
        code: classToJoin.code,
        description: classToJoin.description,
        instructor: classToJoin.instructor,
        joinedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Join class error:', error);
    res.status(500).json({ message: 'Error joining class' });
  }
});

// Get instructor's classes
router.get('/instructor', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can view their classes' });
    }

    const classes = await Class.find({ 
      instructor: req.user._id,
      isActive: true
    })
    .populate('students.student', 'name email')
    .populate('quizzes', 'title totalQuestions timeLimit isActive')
    .sort({ createdAt: -1 });

    res.json({
      classes: classes.map(cls => ({
        id: cls._id,
        name: cls.name,
        code: cls.code,
        description: cls.description,
        stats: cls.stats,
        settings: cls.settings,
        students: cls.students.filter(s => s.isActive).map(s => ({
          id: s.student._id,
          name: s.student.name,
          email: s.student.email,
          joinedAt: s.joinedAt
        })),
        quizzes: cls.quizzes.filter(q => q.isActive),
        createdAt: cls.createdAt
      }))
    });
  } catch (error) {
    console.error('Get instructor classes error:', error);
    res.status(500).json({ message: 'Error fetching classes' });
  }
});

// Get student's enrolled classes
router.get('/student', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can view their enrolled classes' });
    }

    const classes = await Class.find({
      'students.student': req.user._id,
      'students.isActive': true,
      isActive: true
    })
    .populate('instructor', 'name email')
    .populate('quizzes', 'title totalQuestions timeLimit isActive')
    .sort({ createdAt: -1 });

    res.json({
      classes: classes.map(cls => {
        const studentInfo = cls.students.find(s => 
          s.student.toString() === req.user._id.toString()
        );

        return {
          id: cls._id,
          name: cls.name,
          code: cls.code,
          description: cls.description,
          instructor: {
            id: cls.instructor._id,
            name: cls.instructor.name,
            email: cls.instructor.email
          },
          stats: cls.stats,
          quizzes: cls.quizzes.filter(q => q.isActive),
          joinedAt: studentInfo.joinedAt,
          createdAt: cls.createdAt
        };
      })
    });
  } catch (error) {
    console.error('Get student classes error:', error);
    res.status(500).json({ message: 'Error fetching enrolled classes' });
  }
});

// Get class details by ID
router.get('/:classId', authenticateToken, async (req, res) => {
  try {
    const { classId } = req.params;

    const classDetails = await Class.findById(classId)
      .populate('instructor', 'name email')
      .populate('students.student', 'name email')
      .populate('quizzes', 'title description totalQuestions timeLimit isActive createdAt');

    if (!classDetails || !classDetails.isActive) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Check if user has access to this class
    const hasAccess = req.user.role === 'instructor' 
      ? classDetails.instructor._id.toString() === req.user._id.toString()
      : classDetails.students.some(s => 
          s.student._id.toString() === req.user._id.toString() && s.isActive
        );

    if (!hasAccess) {
      return res.status(403).json({ message: 'Access denied to this class' });
    }

    res.json({
      class: {
        id: classDetails._id,
        name: classDetails.name,
        code: classDetails.code,
        description: classDetails.description,
        instructor: {
          id: classDetails.instructor._id,
          name: classDetails.instructor.name,
          email: classDetails.instructor.email
        },
        stats: classDetails.stats,
        settings: classDetails.settings,
        students: classDetails.students.filter(s => s.isActive).map(s => ({
          id: s.student._id,
          name: s.student.name,
          email: s.student.email,
          joinedAt: s.joinedAt
        })),
        quizzes: classDetails.quizzes.filter(q => q.isActive),
        createdAt: classDetails.createdAt
      }
    });
  } catch (error) {
    console.error('Get class details error:', error);
    res.status(500).json({ message: 'Error fetching class details' });
  }
});

// Remove student from class (Instructor only)
router.delete('/:classId/students/:studentId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can remove students' });
    }

    const { classId, studentId } = req.params;

    const classToUpdate = await Class.findById(classId);

    if (!classToUpdate || classToUpdate.instructor.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'Class not found or access denied' });
    }

    // Remove student from class
    classToUpdate.students = classToUpdate.students.filter(
      s => s.student.toString() !== studentId
    );

    await classToUpdate.save();

    // Remove class from student's enrolled classes
    const student = await User.findById(studentId);
    if (student) {
      student.enrolledClasses = student.enrolledClasses.filter(
        ec => ec.class.toString() !== classId
      );
      await student.save();
    }

    res.json({ message: 'Student removed from class successfully' });
  } catch (error) {
    console.error('Remove student error:', error);
    res.status(500).json({ message: 'Error removing student from class' });
  }
});

// Update class settings (Instructor only)
router.put('/:classId/settings', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can update class settings' });
    }

    const { classId } = req.params;
    const { settings } = req.body;

    const classToUpdate = await Class.findById(classId);

    if (!classToUpdate || classToUpdate.instructor.toString() !== req.user._id.toString()) {
      return res.status(404).json({ message: 'Class not found or access denied' });
    }

    // Update settings
    if (settings) {
      classToUpdate.settings = {
        ...classToUpdate.settings,
        ...settings
      };
    }

    await classToUpdate.save();

    res.json({
      message: 'Class settings updated successfully',
      settings: classToUpdate.settings
    });
  } catch (error) {
    console.error('Update class settings error:', error);
    res.status(500).json({ message: 'Error updating class settings' });
  }
});

// Leave class (Student only)
router.delete('/:classId/leave', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ message: 'Only students can leave classes' });
    }

    const { classId } = req.params;

    const classToLeave = await Class.findById(classId);

    if (!classToLeave) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Remove student from class
    classToLeave.students = classToLeave.students.filter(
      s => s.student.toString() !== req.user._id.toString()
    );

    await classToLeave.save();

    // Remove class from student's enrolled classes
    req.user.enrolledClasses = req.user.enrolledClasses.filter(
      ec => ec.class.toString() !== classId
    );

    await req.user.save();

    res.json({ message: 'Successfully left the class' });
  } catch (error) {
    console.error('Leave class error:', error);
    res.status(500).json({ message: 'Error leaving class' });
  }
});

// Delete class (Instructor only)
router.delete('/:classId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'instructor') {
      return res.status(403).json({ message: 'Only instructors can delete classes' });
    }

    const { classId } = req.params;

    const classToDelete = await Class.findById(classId);

    if (!classToDelete) {
      return res.status(404).json({ message: 'Class not found' });
    }

    // Check if the instructor owns this class
    if (classToDelete.instructor.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only delete your own classes' });
    }

    // Remove class from instructor's created classes
    req.user.createdClasses = req.user.createdClasses.filter(
      cc => cc.toString() !== classId
    );

    // Remove class from all enrolled students
    const students = await User.find({
      'enrolledClasses.class': classId
    });

    for (const student of students) {
      student.enrolledClasses = student.enrolledClasses.filter(
        ec => ec.class.toString() !== classId
      );
      await student.save();
    }

    // Delete all quizzes in this class
    await Quiz.deleteMany({ class: classId });

    // Delete all progress records for this class
    await Progress.deleteMany({ quiz: { $in: classToDelete.quizzes } });

    // Delete the class
    await Class.findByIdAndDelete(classId);

    await req.user.save();

    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Delete class error:', error);
    res.status(500).json({ message: 'Error deleting class' });
  }
});

module.exports = router;
