const { GoogleGenerativeAI } = require('@google/generative-ai');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

class AIService {
  constructor() {
    this.gemini = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
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
        Focus on specific, concrete topics mentioned in the content, not generic categories.
        
        Content:
        ${text.substring(0, 4000)}
        
        IMPORTANT: Return ONLY valid JSON array, no markdown, no code blocks, no extra text.
        Extract REAL topics from the content, not generic ones like "General Concepts".
        
        Return format:
        [
          {"name": "Specific Topic from Content", "weight": 8, "description": "Brief description based on content"},
          ...
        ]
      `;

      // Add timeout to the AI service call itself
      const result = await Promise.race([
        this.gemini.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API timeout')), 25000))
      ]);
      
      const response = await result.response;
      const responseText = response.text();
      
      console.log('📚 Topic extraction response length:', responseText.length);
      console.log('📚 Topic extraction preview:', responseText.substring(0, 200) + '...');
      
      // Clean up the response text
      let cleanText = responseText;
      
      // Remove markdown code blocks if present
      if (cleanText.includes('```json')) {
        cleanText = cleanText.replace(/```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleanText.includes('```')) {
        cleanText = cleanText.replace(/```\s*/, '').replace(/```\s*$/, '');
      }
      
      // Try to extract JSON array
      const jsonMatch = cleanText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const topics = JSON.parse(jsonMatch[0]);
          console.log('✅ Successfully extracted', topics.length, 'topics from content');
          console.log('📋 Topics:', topics.map(t => t.name).join(', '));
          return topics;
        } catch (parseError) {
          console.error('❌ Topic JSON parse error:', parseError.message);
        }
      }
      
      // Fallback if no JSON found
      console.log('❌ No topics found in response, using fallback topics');
      console.log('❌ Clean text preview:', cleanText.substring(0, 300));
      return this.getFallbackTopics();
    } catch (error) {
      console.error('❌ Gemini topic extraction error:', error);
      return this.getFallbackTopics();
    }
  }

  // Fallback topics when API calls fail
  getFallbackTopics() {
    return [
      { name: "General Concepts", weight: 8, description: "Main concepts from the lecture content" },
      { name: "Key Topics", weight: 6, description: "Important topics covered in the material" },
      { name: "Core Principles", weight: 7, description: "Fundamental principles discussed in the lecture" }
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
        You are an expert quiz creator. Generate ${numQuestions} high-quality quiz questions based on the lecture content below.
        
        LECTURE CONTENT:
        ${text.substring(0, 4000)}
        
        TOPICS TO FOCUS ON: ${topics.map(t => t.name).join(', ')}
        
        REQUIREMENTS:
        1. Create questions that test REAL understanding of the content
        2. Use specific details from the lecture content
        3. Make questions relevant to the actual material
        4. Vary difficulty levels appropriately
        5. Ensure questions are clear and unambiguous
        
        CRITICAL: Return ONLY valid JSON array, no markdown, no code blocks, no explanations outside the JSON.
        
        JSON FORMAT (CRITICAL - Follow this exactly):
        [
          {
            "questionId": "q1",
            "text": "Based on the lecture content, what is [specific concept]?",
            "type": "multiple-choice",
            "options": [
              {"text": "Option A", "isCorrect": false},
              {"text": "Option B", "isCorrect": true},
              {"text": "Option C", "isCorrect": false},
              {"text": "Option D", "isCorrect": false}
            ],
            "correctAnswer": "Option B",
            "topic": "Specific Topic from Content",
            "difficulty": "easy",
            "explanation": "Detailed explanation referencing the lecture content",
            "points": 10
          }
        ]
        
        CRITICAL REQUIREMENTS:
        - difficulty MUST be one of: "easy", "medium", "hard" (not numbers!)
        - type MUST be one of: "multiple-choice", "true-false", "short-answer"
        - points should be: 5 for easy, 10 for medium, 15 for hard
        
        Make sure each question references actual content from the lecture, not generic concepts.
      `;

      // Add timeout to the AI service call itself
      const result = await Promise.race([
        this.gemini.generateContent(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API timeout')), 35000))
      ]);
      
      const response = await result.response;
      const responseText = response.text();
      
      console.log('🤖 AI Response length:', responseText.length);
      console.log('🤖 AI Response preview:', responseText.substring(0, 200) + '...');
      
      // Clean up the response text
      let cleanText = responseText;
      
      // Remove markdown code blocks if present
      if (cleanText.includes('```json')) {
        cleanText = cleanText.replace(/```json\s*/, '').replace(/```\s*$/, '');
      } else if (cleanText.includes('```')) {
        cleanText = cleanText.replace(/```\s*/, '').replace(/```\s*$/, '');
      }
      
      // Try to extract JSON array
      const jsonMatch = cleanText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const questions = JSON.parse(jsonMatch[0]);
          console.log('✅ Successfully parsed', questions.length, 'questions from AI response');
          
          // Validate and fix questions
          const validatedQuestions = questions.map((q, index) => {
            // Fix difficulty if it's a number or invalid
            if (typeof q.difficulty === 'number' || !['easy', 'medium', 'hard', 'expert', 'master'].includes(q.difficulty)) {
              console.log(`⚠️ Fixing invalid difficulty "${q.difficulty}" for question ${index + 1}`);
              // Map numeric difficulties to string equivalents
              if (typeof q.difficulty === 'number') {
                if (q.difficulty === 1 || q.difficulty === '1') q.difficulty = 'easy';
                else if (q.difficulty === 2 || q.difficulty === '2') q.difficulty = 'medium';
                else if (q.difficulty === 3 || q.difficulty === '3') q.difficulty = 'hard';
                else if (q.difficulty === 4 || q.difficulty === '4') q.difficulty = 'expert';
                else if (q.difficulty === 5 || q.difficulty === '5') q.difficulty = 'master';
                else q.difficulty = 'medium'; // Default fallback
              } else {
                q.difficulty = ['easy', 'medium', 'hard', 'expert', 'master'][index % 5]; // Cycle through valid difficulties
              }
            }
            
            // Fix type if invalid
            if (!['multiple-choice', 'true-false', 'short-answer'].includes(q.type)) {
              console.log(`⚠️ Fixing invalid type "${q.type}" for question ${index + 1}`);
              q.type = 'multiple-choice';
            }
            
            // Fix options format if needed
            if (q.options && Array.isArray(q.options) && q.options.length > 0) {
              if (typeof q.options[0] === 'string') {
                console.log(`⚠️ Converting string options to object format for question ${index + 1}`);
                q.options = q.options.map((opt, optIndex) => ({
                  text: opt,
                  isCorrect: optIndex === 0 // Default first option as correct
                }));
              }
            }
            
            // Set points based on difficulty
            q.points = q.difficulty === 'easy' ? 5 : q.difficulty === 'medium' ? 10 : q.difficulty === 'hard' ? 15 : q.difficulty === 'expert' ? 20 : 25;
            
            return q;
          });
          
          return validatedQuestions;
        } catch (parseError) {
          console.error('❌ JSON parse error:', parseError.message);
          console.log('❌ Failed JSON text:', jsonMatch[0].substring(0, 500));
        }
      }
      
      // Fallback if no JSON found
      console.log('❌ No JSON array found in response, using fallback questions');
      console.log('❌ Clean text preview:', cleanText.substring(0, 300));
      return this.getFallbackQuestions(numQuestions);
    } catch (error) {
      console.error('❌ Gemini question generation error:', error);
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

  async generateAdaptiveQuestions(content, topics, totalQuestions, difficultyLevels, retakeThreshold) {
    try {
      const questionsPerDifficulty = Math.ceil(totalQuestions / difficultyLevels.length);
      const allQuestions = [];

      for (const difficulty of difficultyLevels) {
        const prompt = `
Generate ${questionsPerDifficulty} ${difficulty} difficulty quiz questions based on the following content:

Content: ${content.substring(0, 4000)}

Topics: ${topics.map(t => t.name).join(', ')}

CRITICAL REQUIREMENTS:
- difficulty MUST be exactly: "${difficulty}" (string, not number!)
- type MUST be: "multiple-choice"
- Use the exact JSON format below
- Make questions test REAL understanding of the content

IMPORTANT: Return ONLY valid JSON array, no markdown, no code blocks, no extra text.

JSON FORMAT:
[
  {
    "questionId": "q1",
    "text": "Question text here",
    "type": "multiple-choice",
    "options": [
      {"text": "Option A", "isCorrect": false},
      {"text": "Option B", "isCorrect": true},
      {"text": "Option C", "isCorrect": false},
      {"text": "Option D", "isCorrect": false}
    ],
    "correctAnswer": "Option B",
    "topic": "Topic name",
    "difficulty": "${difficulty}",
    "explanation": "Explanation of why this answer is correct",
    "points": ${difficulty === 'easy' ? 5 : difficulty === 'medium' ? 10 : 15}
  }
]
`;

        // Add timeout to the AI service call itself
        const result = await Promise.race([
          this.gemini.generateContent(prompt),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini API timeout')), 35000))
        ]);
        
        const response = await result.response;
        const responseText = response.text();
        
        // Clean up the response text
        let cleanText = responseText;
        
        // Remove markdown code blocks if present
        if (cleanText.includes('```json')) {
          cleanText = cleanText.replace(/```json\s*/, '').replace(/```\s*$/, '');
        } else if (cleanText.includes('```')) {
          cleanText = cleanText.replace(/```\s*/, '').replace(/```\s*$/, '');
        }
        
        // Extract JSON from the response
        const jsonMatch = cleanText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const questions = JSON.parse(jsonMatch[0]);
            
            // Validate and fix questions
            const validatedQuestions = questions.map((q, index) => {
              // Fix difficulty if it's a number or invalid
              if (typeof q.difficulty === 'number' || !['easy', 'medium', 'hard', 'expert', 'master'].includes(q.difficulty)) {
                console.log(`⚠️ Fixing invalid difficulty "${q.difficulty}" for adaptive question ${index + 1}`);
                // Map numeric difficulties to string equivalents
                if (typeof q.difficulty === 'number') {
                  if (q.difficulty === 1 || q.difficulty === '1') q.difficulty = 'easy';
                  else if (q.difficulty === 2 || q.difficulty === '2') q.difficulty = 'medium';
                  else if (q.difficulty === 3 || q.difficulty === '3') q.difficulty = 'hard';
                  else if (q.difficulty === 4 || q.difficulty === '4') q.difficulty = 'expert';
                  else if (q.difficulty === 5 || q.difficulty === '5') q.difficulty = 'master';
                  else q.difficulty = difficulty; // Use the current difficulty level
                } else {
                  q.difficulty = difficulty; // Use the current difficulty level
                }
              }
              
              // Fix type if invalid
              if (!['multiple-choice', 'true-false', 'short-answer'].includes(q.type)) {
                console.log(`⚠️ Fixing invalid type "${q.type}" for adaptive question ${index + 1}`);
                q.type = 'multiple-choice';
              }
              
              // Fix options format if needed
              if (q.options && Array.isArray(q.options) && q.options.length > 0) {
                if (typeof q.options[0] === 'string') {
                  console.log(`⚠️ Converting string options to object format for adaptive question ${index + 1}`);
                  q.options = q.options.map((opt, optIndex) => ({
                    text: opt,
                    isCorrect: optIndex === 0 // Default first option as correct
                  }));
                }
              }
              
              // Set points based on difficulty
              q.points = q.difficulty === 'easy' ? 5 : q.difficulty === 'medium' ? 10 : q.difficulty === 'hard' ? 15 : q.difficulty === 'expert' ? 20 : 25;
              
              return q;
            });
            
            allQuestions.push(...validatedQuestions);
          } catch (parseError) {
            console.error('❌ Adaptive JSON parse error:', parseError.message);
          }
        }
      }

      // Shuffle questions and limit to totalQuestions
      const shuffledQuestions = allQuestions.sort(() => Math.random() - 0.5);
      return shuffledQuestions.slice(0, totalQuestions);

    } catch (error) {
      console.error('Adaptive question generation error:', error);
      
      // Fallback to standard questions if adaptive generation fails
      return await this.generateQuestions(content, topics, totalQuestions);
    }
  }
}

module.exports = new AIService();
