const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

class AIService {
  constructor() {
    this.gemini = genAI.getGenerativeModel({ model: "gemini-pro" });
  }

  // Extract text from various file formats
  async extractTextFromFile(file) {
    const { originalname, buffer } = file;
    const extension = originalname.split('.').pop().toLowerCase();

    try {
      switch (extension) {
        case 'pdf':
          const pdfData = await pdfParse(buffer);
          return pdfData.text;
        
        case 'docx':
          const docxResult = await mammoth.extractRawText({ buffer });
          return docxResult.value;
        
        case 'txt':
          return buffer.toString('utf-8');
        
        default:
          throw new Error(`Unsupported file format: ${extension}`);
      }
    } catch (error) {
      console.error('Text extraction error:', error);
      throw new Error(`Failed to extract text from ${originalname}`);
    }
  }

  // Extract topics from lecture content using Gemini
  async extractTopics(text) {
    try {
      const prompt = `
        Analyze the following lecture content and extract the main topics and concepts. 
        Return a JSON array of topics with their importance weights (1-10).
        
        Content:
        ${text.substring(0, 4000)} // Limit to avoid token limits
        
        Return format:
        [
          {"name": "Topic Name", "weight": 8, "description": "Brief description"},
          ...
        ]
      `;

      const result = await this.gemini.generateContent(prompt);
      const response = await result.response;
      const topics = JSON.parse(response.text());
      return topics;
    } catch (error) {
      console.error('Gemini topic extraction error:', error);
      return this.getFallbackTopics();
    }
  }

  // Fallback topics when API calls fail
  getFallbackTopics() {
    return [
      { name: "General Concepts", weight: 5, description: "Main concepts from the lecture" }
    ];
  }

  // Fallback questions when API calls fail
  getFallbackQuestions(numQuestions = 10) {
    const questions = [];
    for (let i = 1; i <= numQuestions; i++) {
      questions.push({
        questionId: `q${i}`,
        text: `This is a sample question ${i}. What is the main concept discussed in the lecture?`,
        type: "multiple-choice",
        options: [
          {"text": "Option A", "isCorrect": false},
          {"text": "Option B", "isCorrect": true},
          {"text": "Option C", "isCorrect": false},
          {"text": "Option D", "isCorrect": false}
        ],
        correctAnswer: "Option B",
        topic: "General Concepts",
        difficulty: "medium",
        explanation: "This is a sample explanation for the correct answer.",
        points: 10
      });
    }
    return questions;
  }

  // Generate quiz questions from lecture content using Gemini
  async generateQuestions(text, topics, numQuestions = 10) {
    try {
      const prompt = `
        Generate ${numQuestions} quiz questions based on the following lecture content.
        Create a mix of question types: multiple-choice, true/false, and short-answer.
        Focus on the key concepts and ensure questions test understanding, not just memorization.
        
        Lecture Content:
        ${text.substring(0, 6000)} // Limit content to avoid token limits
        
        Topics to focus on: ${topics.map(t => t.name).join(', ')}
        
        Return a JSON array with this exact format:
        [
          {
            "questionId": "q1",
            "text": "Question text here?",
            "type": "multiple-choice",
            "options": [
              {"text": "Option A", "isCorrect": false},
              {"text": "Option B", "isCorrect": true},
              {"text": "Option C", "isCorrect": false},
              {"text": "Option D", "isCorrect": false}
            ],
            "correctAnswer": "Option B",
            "topic": "Topic Name",
            "difficulty": "medium",
            "explanation": "Explanation of why this answer is correct",
            "points": 10
          }
        ]
        
        Question types:
        - multiple-choice: 4 options, one correct
        - true-false: 2 options (True/False)
        - short-answer: no options, correctAnswer is the expected answer
        
        Difficulty levels: easy, medium, hard
        Points: 5 for easy, 10 for medium, 15 for hard
      `;

      const result = await this.gemini.generateContent(prompt);
      const response = await result.response;
      const questions = JSON.parse(response.text());
      return questions;
    } catch (error) {
      console.error('Gemini question generation error:', error);
      return this.getFallbackQuestions(numQuestions);
    }
  }

  // Generate adaptive follow-up questions based on weak topics using Gemini
  async generateAdaptiveQuestions(weakTopics, originalContent, numQuestions = 5) {
    try {
      const prompt = `
        Generate ${numQuestions} follow-up questions focusing on these weak topics: ${weakTopics.join(', ')}.
        Make these questions slightly easier than the original to help reinforce learning.
        
        Original Content Context:
        ${originalContent.substring(0, 3000)}
        
        Return a JSON array with the same format as before, but focus on:
        1. Basic understanding of weak topics
        2. Simple applications
        3. Clear explanations
        
        Make the difficulty "easy" or "medium" and provide detailed explanations.
      `;

      const result = await this.gemini.generateContent(prompt);
      const response = await result.response;
      const questions = JSON.parse(response.text());
      return questions;
    } catch (error) {
      console.error('Gemini adaptive question generation error:', error);
      return [];
    }
  }

  // Analyze student performance and suggest improvements
  async analyzePerformance(answers, topics) {
    try {
      const correctAnswers = answers.filter(a => a.isCorrect).length;
      const totalAnswers = answers.length;
      const accuracy = (correctAnswers / totalAnswers) * 100;

      const topicPerformance = topics.map(topic => {
        const topicAnswers = answers.filter(a => a.topic === topic.name);
        const topicCorrect = topicAnswers.filter(a => a.isCorrect).length;
        const topicAccuracy = topicAnswers.length > 0 ? (topicCorrect / topicAnswers.length) * 100 : 0;
        
        return {
          topic: topic.name,
          accuracy: topicAccuracy,
          questionsAnswered: topicAnswers.length,
          correctAnswers: topicCorrect
        };
      });

      const weakTopics = topicPerformance
        .filter(tp => tp.accuracy < 70 && tp.questionsAnswered > 0)
        .map(tp => tp.topic);

      const strongTopics = topicPerformance
        .filter(tp => tp.accuracy >= 80 && tp.questionsAnswered > 0)
        .map(tp => tp.topic);

      return {
        overallAccuracy: accuracy,
        topicPerformance,
        weakTopics,
        strongTopics,
        recommendations: this.generateRecommendations(weakTopics, strongTopics, accuracy)
      };
    } catch (error) {
      console.error('Performance analysis error:', error);
      return {
        overallAccuracy: 0,
        topicPerformance: [],
        weakTopics: [],
        strongTopics: [],
        recommendations: ['Focus on reviewing the material']
      };
    }
  }

  generateRecommendations(weakTopics, strongTopics, accuracy) {
    const recommendations = [];

    if (accuracy < 50) {
      recommendations.push('Consider reviewing the lecture material before retaking the quiz');
    } else if (accuracy < 70) {
      recommendations.push('Good progress! Focus on the weak topics to improve your score');
    } else if (accuracy >= 90) {
      recommendations.push('Excellent work! You have a strong understanding of the material');
    }

    if (weakTopics.length > 0) {
      recommendations.push(`Focus on these topics: ${weakTopics.join(', ')}`);
    }

    if (strongTopics.length > 0) {
      recommendations.push(`Great job on: ${strongTopics.join(', ')}`);
    }

    return recommendations;
  }
}

module.exports = new AIService();
