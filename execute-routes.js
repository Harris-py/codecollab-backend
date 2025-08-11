// execute-routes.js - Updated with rate limiting and retry logic
const express = require('express');
const axios = require('axios');
const Session = require('./Session');
const User = require('./User');
const { authMiddleware } = require('./auth-middleware');

const router = express.Router();

// ⭐ PISTON API RATE LIMITER CLASS
class PistonRateLimiter {
  constructor() {
    this.lastRequestTime = 0;
    this.requestQueue = [];
    this.minInterval = 300; // 300ms between requests (safer than 200ms)
    this.processing = false;
  }

  async executeWithRateLimit(requestFunc) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ requestFunc, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.requestQueue.length > 0) {
      const { requestFunc, resolve, reject } = this.requestQueue.shift();
      
      try {
        // Ensure minimum interval between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minInterval) {
          const waitTime = this.minInterval - timeSinceLastRequest;
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // Execute the request
        this.lastRequestTime = Date.now();
        const result = await requestFunc();
        resolve(result);

      } catch (error) {
        reject(error);
      }
    }

    this.processing = false;
  }
}

// Create global rate limiter instance
const pistonLimiter = new PistonRateLimiter();

// ⭐ RETRY LOGIC FOR FAILED REQUESTS
const executeWithRetry = async (requestFunc, maxRetries = 3, baseDelay = 1000) => {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await pistonLimiter.executeWithRateLimit(requestFunc);
    } catch (error) {
      lastError = error;
      
      // If it's a rate limit error (429), wait longer
      if (error.response && error.response.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || Math.pow(2, attempt) * baseDelay;
        console.log(`Rate limited, retrying after ${retryAfter}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          continue;
        }
      }
      
      // For other errors, use exponential backoff
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.log(`Request failed, retrying after ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
};

// Language mapping for Piston API
const languageMapping = {
  'javascript': 'javascript',
  'python': 'python',
  'cpp': 'c++',
  'c': 'c',
  'java': 'java',
  'go': 'go',
  'rust': 'rust'
};

// Get available language versions from Piston API
const getLanguageVersions = async () => {
  try {
    const response = await executeWithRetry(() => 
      axios.get(`${process.env.PISTON_API_URL}/runtimes`, {
        timeout: 10000
      })
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching language versions:', error);
    return null;
  }
};

// Helper function to prepare code for execution
const prepareCodeForExecution = (code, language) => {
  let cleanCode = code.trim();
  
  switch (language) {
    case 'javascript':
      // Ensure Node.js compatible code
      break;
      
    case 'python':
      // Ensure Python 3 compatibility
      cleanCode = cleanCode.replace(/print\s+([^(])/g, 'print($1)');
      break;
      
    case 'java':
      // Ensure class name is Main for Piston API
      cleanCode = cleanCode.replace(/public\s+class\s+\w+/g, 'public class Main');
      break;
      
    default:
      break;
  }
  
  return cleanCode;
};

// Helper function to format execution output
const formatExecutionOutput = (output, error, language) => {
  let formattedOutput = '';
  let hasError = false;
  
  if (error) {
    hasError = true;
    formattedOutput = `❌ Error:\n${error}`;
    
    switch (language) {
      case 'javascript':
        formattedOutput = formattedOutput.replace(/at Object\.<anonymous>.*\n?/g, '');
        formattedOutput = formattedOutput.replace(/at Module\._compile.*\n?/g, '');
        break;
        
      case 'python':
        formattedOutput = formattedOutput.replace(/File "<stdin>", line \d+, in <module>\n?/g, '');
        break;
        
      default:
        break;
    }
  } else if (output) {
    formattedOutput = output;
  } else {
    formattedOutput = '✅ Code executed successfully (no output)';
  }
  
  return { output: formattedOutput.trim(), hasError };
};

// Get file extension for language
const getFileExtension = (language) => {
  const extensions = {
    'javascript': 'js',
    'python': 'py',
    'cpp': 'cpp',
    'c': 'c',
    'java': 'java',
    'go': 'go',
    'rust': 'rs'
  };
  return extensions[language] || 'txt';
};

// Get language display name
const getLanguageDisplayName = (language) => {
  const displayNames = {
    'javascript': 'JavaScript',
    'python': 'Python',
    'cpp': 'C++',
    'c': 'C',
    'java': 'Java',
    'go': 'Go',
    'rust': 'Rust'
  };
  return displayNames[language] || language;
};

// Get code templates
const getCodeTemplate = (language) => {
  const templates = {
    javascript: 'console.log("Hello, World!");',
    python: 'print("Hello, World!")',
    cpp: '#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}',
    c: '#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}',
    java: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}',
    go: 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}',
    rust: 'fn main() {\n    println!("Hello, World!");\n}'
  };
  return templates[language] || '';
};

// @route   POST /api/execute/run
// @desc    Execute code using Piston API with rate limiting
// @access  Private
router.post('/run', authMiddleware, async (req, res) => {
  try {
    const { code, language, input, sessionId } = req.body;

    // Validation
    if (!code || !language) {
      return res.status(400).json({
        error: 'Code and language are required'
      });
    }

    if (!languageMapping[language]) {
      return res.status(400).json({
        error: 'Unsupported programming language'
      });
    }

    // Get user info
    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Verify session access if sessionId provided
    let session = null;
    if (sessionId) {
      session = await Session.findById(sessionId);
      
      if (!session) {
        return res.status(404).json({
          error: 'Session not found'
        });
      }

      const hasAccess = session.creator.toString() === req.userId ||
                       session.activeParticipants.some(p => 
                         p.user.toString() === req.userId && p.isActive
                       );

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to execute code in this session'
        });
      }

      if (!session.settings.executionEnabled) {
        return res.status(403).json({
          error: 'Code execution is disabled for this session'
        });
      }
    }

    // Prepare code for execution
    const preparedCode = prepareCodeForExecution(code, language);
    const executionStartTime = Date.now();

    try {
      // ⭐ Execute code using Piston API with rate limiting and retry
      const pistonResponse = await executeWithRetry(() => 
        axios.post(`${process.env.PISTON_API_URL}/execute`, {
          language: languageMapping[language],
          version: '*',
          files: [
            {
              name: language === 'java' ? 'Main.java' : `main.${getFileExtension(language)}`,
              content: preparedCode
            }
          ],
          stdin: input || '',
          args: [],
          compile_timeout: 10000,
          run_timeout: 5000,
          compile_memory_limit: 128000000,
          run_memory_limit: 64000000
        }, {
          timeout: 20000, // Increased timeout
          headers: {
            'Content-Type': 'application/json'
          }
        })
      );

      const executionEndTime = Date.now();
      const executionTime = executionEndTime - executionStartTime;

      const result = pistonResponse.data;
      
      // Format the output
      const output = result.run.stdout || '';
      const error = result.run.stderr || result.compile?.stderr || '';
      const { output: formattedOutput, hasError } = formatExecutionOutput(output, error, language);

      // Prepare execution result
      const executionResult = {
        success: !hasError,
        output: formattedOutput,
        rawOutput: output,
        error: error,
        executionTime: executionTime,
        memoryUsed: result.run.memory || 0,
        exitCode: result.run.code || 0,
        language: language,
        timestamp: new Date(),
        compiledSuccessfully: !result.compile?.stderr
      };

      // Save execution to session history if sessionId provided
      if (session) {
        await session.addExecution({
          code: preparedCode,
          language: language,
          input: input || '',
          output: output,
          error: error,
          executionTime: executionTime,
          memoryUsed: result.run.memory || 0,
          executedBy: req.userId
        });
      }

      // Update user execution count
      await user.incrementExecutionCount();

      // Send response
      res.json({
        success: true,
        result: executionResult,
        pistonInfo: {
          language: result.language,
          version: result.version
        }
      });

      console.log(`⚡ Code executed by ${user.username} (${language}): ${executionTime}ms`);

    } catch (pistonError) {
      console.error('Piston API error:', pistonError.response?.data || pistonError.message);
      
      // Handle specific Piston API errors
      let errorMessage = 'Code execution failed';
      let statusCode = 500;
      
      if (pistonError.code === 'ECONNABORTED') {
        errorMessage = 'Code execution timed out';
        statusCode = 408;
      } else if (pistonError.response) {
        const status = pistonError.response.status;
        if (status === 400) {
          errorMessage = 'Invalid code or language configuration';
          statusCode = 400;
        } else if (status === 429) {
          errorMessage = 'Too many execution requests. Please wait a moment and try again.';
          statusCode = 429;
        } else if (status >= 500) {
          errorMessage = 'Code execution service temporarily unavailable';
          statusCode = 503;
        }
      }

      res.status(statusCode).json({
        success: false,
        error: errorMessage,
        result: {
          success: false,
          output: `❌ ${errorMessage}`,
          executionTime: Date.now() - executionStartTime,
          hasError: true
        }
      });
    }

  } catch (error) {
    console.error('Execute code error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during code execution'
    });
  }
});

// @route   GET /api/execute/languages
// @desc    Get supported languages and their versions
// @access  Private
router.get('/languages', authMiddleware, async (req, res) => {
  try {
    const runtimes = await getLanguageVersions();
    
    if (!runtimes) {
      return res.status(503).json({
        error: 'Unable to fetch supported languages'
      });
    }

    const supportedLanguages = Object.keys(languageMapping).map(lang => {
      const pistonLang = languageMapping[lang];
      const runtime = runtimes.find(r => r.language === pistonLang);
      
      return {
        name: lang,
        displayName: getLanguageDisplayName(lang),
        pistonName: pistonLang,
        version: runtime ? runtime.version : 'Unknown',
        available: !!runtime,
        template: getCodeTemplate(lang)
      };
    });

    res.json({
      success: true,
      languages: supportedLanguages,
      totalAvailable: supportedLanguages.filter(l => l.available).length
    });

  } catch (error) {
    console.error('Get languages error:', error);
    res.status(500).json({
      error: 'Failed to fetch supported languages'
    });
  }
});

// @route   POST /api/execute/validate
// @desc    Validate code syntax (basic validation)
// @access  Private
router.post('/validate', authMiddleware, async (req, res) => {
  try {
    const { code, language } = req.body;

    if (!code || !language) {
      return res.status(400).json({
        error: 'Code and language are required'
      });
    }

    // Basic validation logic
    let isValid = true;
    let errors = [];

    // Language-specific basic validation
    switch (language) {
      case 'javascript':
        try {
          // Basic syntax check (this is very basic)
          new Function(code);
        } catch (error) {
          isValid = false;
          errors.push(error.message);
        }
        break;
        
      case 'python':
        // Basic Python syntax validation (simplified)
        if (code.includes('print ') && !code.includes('print(')) {
          errors.push('Consider using print() function for Python 3 compatibility');
        }
        break;
        
      default:
        // For other languages, just check if code is not empty
        if (!code.trim()) {
          isValid = false;
          errors.push('Code cannot be empty');
        }
        break;
    }

    res.json({
      success: true,
      isValid,
      errors,
      suggestions: errors.length > 0 ? ['Check syntax and try again'] : []
    });

  } catch (error) {
    console.error('Validate code error:', error);
    res.status(500).json({
      error: 'Failed to validate code'
    });
  }
});

// @route   GET /api/execute/stats
// @desc    Get execution statistics
// @access  Private
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    res.json({
      success: true,
      stats: {
        totalExecutions: user.totalCodeExecutions || 0,
        favoriteLanguage: 'javascript', // This could be calculated from execution history
        lastExecution: user.lastActive || new Date()
      }
    });

  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      error: 'Failed to fetch execution statistics'
    });
  }
});

module.exports = router;
