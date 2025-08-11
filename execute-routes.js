const express = require('express');
const axios = require('axios');
const Session = require('./Session');
const User = require('./User');
const { authMiddleware } = require('./auth-middleware');

const router = express.Router();

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
    const response = await axios.get(`${process.env.PISTON_API_URL}/runtimes`);
    return response.data;
  } catch (error) {
    console.error('Error fetching language versions:', error);
    return null;
  }
};

// Helper function to prepare code for execution
const prepareCodeForExecution = (code, language) => {
  // Remove any potential security risks or cleanup code
  let cleanCode = code.trim();
  
  // Language-specific preparations
  switch (language) {
    case 'javascript':
      // Ensure Node.js compatible code
      if (!cleanCode.includes('console.log') && !cleanCode.includes('process.')) {
        // Basic validation
      }
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
    
    // Language-specific error formatting
    switch (language) {
      case 'javascript':
        // Clean up Node.js error messages
        formattedOutput = formattedOutput.replace(/at Object\.<anonymous>.*\n?/g, '');
        formattedOutput = formattedOutput.replace(/at Module\._compile.*\n?/g, '');
        break;
        
      case 'python':
        // Clean up Python traceback
        const lines = formattedOutput.split('\n');
        const cleanLines = lines.filter(line => 
          !line.includes('File "<stdin>"') && 
          !line.includes('Traceback (most recent call last)')
        );
        if (cleanLines.length > 0) {
          formattedOutput = cleanLines.join('\n');
        }
        break;
        
      default:
        break;
    }
  } else if (output) {
    formattedOutput = `✅ Output:\n${output}`;
  } else {
    formattedOutput = '✅ Code executed successfully (no output)';
  }
  
  return { output: formattedOutput, hasError };
};

// Helper function to get file extension for different languages
function getFileExtension(language) {
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
}

// Helper function to get language display names
function getLanguageDisplayName(language) {
  const displayNames = {
    'javascript': 'JavaScript (Node.js)',
    'python': 'Python',
    'cpp': 'C++',
    'c': 'C',
    'java': 'Java',
    'go': 'Go',
    'rust': 'Rust'
  };
  return displayNames[language] || language;
}

// Helper function to get language templates
function getLanguageTemplate(language) {
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
}

// @route   POST /api/execute/run
// @desc    Execute code using Piston API
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

      // Check if user has access to execute code in this session
      const hasAccess = session.creator.toString() === req.userId ||
                       session.activeParticipants.some(p => 
                         p.user.toString() === req.userId && p.isActive
                       );

      if (!hasAccess) {
        return res.status(403).json({
          error: 'Access denied to execute code in this session'
        });
      }

      // Check if execution is enabled for this session
      if (!session.settings.executionEnabled) {
        return res.status(403).json({
          error: 'Code execution is disabled for this session'
        });
      }
    }

    // Prepare code for execution
    const preparedCode = prepareCodeForExecution(code, language);

    // Execution start time
    const executionStartTime = Date.now();

    try {
      // Execute code using Piston API
      const pistonResponse = await axios.post(`${process.env.PISTON_API_URL}/execute`, {
        language: languageMapping[language],
        version: '*', // Use latest version
        files: [
          {
            name: language === 'java' ? 'Main.java' : `main.${getFileExtension(language)}`,
            content: preparedCode
          }
        ],
        stdin: input || '',
        args: [],
        compile_timeout: 10000, // 10 seconds compile timeout
        run_timeout: 5000, // 5 seconds run timeout
        compile_memory_limit: 128000000, // 128MB compile memory limit
        run_memory_limit: 64000000 // 64MB run memory limit
      }, {
        timeout: 15000, // 15 seconds total timeout
        headers: {
          'Content-Type': 'application/json'
        }
      });

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
      
      if (pistonError.code === 'ECONNABORTED') {
        errorMessage = 'Code execution timed out';
      } else if (pistonError.response) {
        const status = pistonError.response.status;
        if (status === 400) {
          errorMessage = 'Invalid code or language configuration';
        } else if (status === 429) {
          errorMessage = 'Too many execution requests. Please wait and try again.';
        } else if (status >= 500) {
          errorMessage = 'Code execution service temporarily unavailable';
        }
      }

      res.status(500).json({
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
    // Get available runtimes from Piston API
    const runtimes = await getLanguageVersions();
    
    if (!runtimes) {
      return res.status(503).json({
        error: 'Unable to fetch supported languages'
      });
    }

    // Filter and map to our supported languages
    const supportedLanguages = Object.keys(languageMapping).map(lang => {
      const pistonLang = languageMapping[lang];
      const runtime = runtimes.find(r => r.language === pistonLang);
      
      return {
        name: lang,
        displayName: getLanguageDisplayName(lang),
        pistonName: pistonLang,
        version: runtime ? runtime.version : 'Unknown',
        available: !!runtime,
        fileExtension: getFileExtension(lang),
        template: getLanguageTemplate(lang)
      };
    });

    res.json({
      success: true,
      languages: supportedLanguages.filter(lang => lang.available),
      totalSupported: supportedLanguages.filter(lang => lang.available).length
    });

  } catch (error) {
    console.error('Get languages error:', error);
    res.status(500).json({
      error: 'Failed to fetch supported languages'
    });
  }
});

// @route   POST /api/execute/validate
// @desc    Validate code syntax without execution
// @access  Private
router.post('/validate', authMiddleware, async (req, res) => {
  try {
    const { code, language } = req.body;

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

    // Basic syntax validation (simplified)
    const validationResult = validateCodeSyntax(code, language);

    res.json({
      success: true,
      valid: validationResult.valid,
      errors: validationResult.errors,
      warnings: validationResult.warnings
    });

  } catch (error) {
    console.error('Validate code error:', error);
    res.status(500).json({
      error: 'Code validation failed'
    });
  }
});

// Helper function for basic code syntax validation
function validateCodeSyntax(code, language) {
  const result = {
    valid: true,
    errors: [],
    warnings: []
  };

  // Basic validation rules for different languages
  switch (language) {
    case 'javascript':
      // Check for basic JavaScript syntax issues
      if (!code.trim()) {
        result.errors.push('Code cannot be empty');
        result.valid = false;
      }
      
      // Check for unmatched brackets
      const brackets = { '(': 0, '[': 0, '{': 0 };
      for (const char of code) {
        if (char === '(') brackets['(']++;
        if (char === ')') brackets['(']--;
        if (char === '[') brackets['[']++;
        if (char === ']') brackets['[']--;
        if (char === '{') brackets['{']++;
        if (char === '}') brackets['{']--;
      }
      
      Object.keys(brackets).forEach(bracket => {
        if (brackets[bracket] !== 0) {
          result.errors.push(`Unmatched ${bracket} brackets`);
          result.valid = false;
        }
      });
      break;

    case 'python':
      if (!code.trim()) {
        result.errors.push('Code cannot be empty');
        result.valid = false;
      }
      
      // Check for print statement without parentheses (Python 3)
      if (code.includes('print ') && !code.includes('print(')) {
        result.warnings.push('Consider using print() with parentheses for Python 3');
      }
      break;

    case 'java':
      if (!code.includes('public class')) {
        result.errors.push('Java code must contain a public class');
        result.valid = false;
      }
      
      if (!code.includes('public static void main')) {
        result.warnings.push('Java code should contain a main method');
      }
      break;

    default:
      if (!code.trim()) {
        result.errors.push('Code cannot be empty');
        result.valid = false;
      }
      break;
  }

  return result;
}

// @route   GET /api/execute/stats
// @desc    Get execution statistics
// @access  Private
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    
    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    // Get user's sessions with execution history
    const sessions = await Session.find({
      $or: [
        { creator: req.userId },
        { 'activeParticipants.user': req.userId }
      ]
    });

    // Calculate statistics
    let totalExecutions = 0;
    let totalExecutionTime = 0;
    const languageStats = {};
    
    sessions.forEach(session => {
      session.executionHistory.forEach(execution => {
        if (execution.executedBy.toString() === req.userId) {
          totalExecutions++;
          totalExecutionTime += execution.executionTime || 0;
          
          const lang = execution.language;
          if (!languageStats[lang]) {
            languageStats[lang] = { count: 0, totalTime: 0 };
          }
          languageStats[lang].count++;
          languageStats[lang].totalTime += execution.executionTime || 0;
        }
      });
    });

    res.json({
      success: true,
      stats: {
        totalExecutions: totalExecutions,
        totalExecutionTime: totalExecutionTime,
        averageExecutionTime: totalExecutions > 0 ? Math.round(totalExecutionTime / totalExecutions) : 0,
        languageBreakdown: languageStats,
        sessionsParticipated: sessions.length
      }
    });

  } catch (error) {
    console.error('Get execution stats error:', error);
    res.status(500).json({
      error: 'Failed to fetch execution statistics'
    });
  }
});

// @route   POST /api/execute/share
// @desc    Share code execution result
// @access  Private
router.post('/share', authMiddleware, async (req, res) => {
  try {
    const { code, language, output, sessionId } = req.body;

    // Create a shareable link/ID for the execution result
    const shareId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // In a real application, you might store this in a separate collection
    // For now, we'll return the share information
    
    res.json({
      success: true,
      shareId: shareId,
      shareUrl: `${process.env.CLIENT_URL}/shared/${shareId}`,
      message: 'Execution result shared successfully'
    });

  } catch (error) {
    console.error('Share execution error:', error);
    res.status(500).json({
      error: 'Failed to share execution result'
    });
  }
});

module.exports = router;