// Optimize libuv thread pool BEFORE requiring any modules
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || 16;

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Set log level for production to reduce log volume
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG');
const isProduction = process.env.NODE_ENV === 'production';

const app = express();
const PORT = process.env.PORT || 3002;
// Server instance (set when app.listen is called) - used for graceful shutdown
let server = null;

// Import database and models
const { sequelize, testConnection } = require('./config/database');
const { validateConfig } = require('./config/whatsapp');
require('./models'); // Initialize models

// Import and initialize services
const queueService = require('./services/queueService');
const gameService = require('./services/gameService');
const PerformanceMonitor = require('./services/performanceMonitor');
const workerManager = require('./services/workerManager');

// Initialize services
console.log('🔄 Initializing services...');
console.log(`🧵 libuv thread pool size: ${process.env.UV_THREADPOOL_SIZE}`);
console.log(`💻 CPU cores available: ${require('os').cpus().length}`);
const performanceMonitor = new PerformanceMonitor();

// Import routes
const webhookRoutes = require('./routes/webhook');
const adminRoutes = require('./routes/admin');

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://qrush-trivia.vercel.app',
      'https://qrush-trivia-git-main.vercel.app',
      'https://trivia-game-production-1674.up.railway.app',
      'https://trivia-game-production-5a11.up.railway.app',
      'https://qrushtrivia.com',
      'https://www.qrushtrivia.com',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002'
    ];
    
    // Check if origin is in allowed list
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    
    // Check for Vercel preview deployments (pattern matching)
    if (origin && origin.includes('qrush-trivia') && origin.includes('vercel.app')) {
      return callback(null, true);
    }
    
    // For development, allow localhost with any port
    if (origin && origin.startsWith('http://localhost:')) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'username', 'password'],
  optionsSuccessStatus: 200
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Performance monitoring middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    performanceMonitor.recordRequest(req.path, responseTime, res.statusCode < 400);
  });
  
  next();
});

// Serve static files
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

// Performance monitoring endpoint
app.get('/performance', (req, res) => {
  const summary = performanceMonitor.getSummary();
  const health = performanceMonitor.checkHealth();
  
  res.status(200).json({
    summary,
    health,
    timestamp: new Date().toISOString()
  });
});

// Routes
app.use('/webhook', webhookRoutes);
app.use('/admin', adminRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Initialize application
async function initializeApp() {
  try {
    // Test database connection
    await testConnection();
    
    // Validate WhatsApp configuration
    if (!validateConfig()) {
      console.error('❌ WhatsApp configuration validation failed');
      process.exit(1);
    }
    
    // Restore active games from database (with table creation)
    try {
      await gameService.restoreActiveGames();
      console.log('✅ Active games restored successfully');
    } catch (error) {
      console.warn('⚠️  Failed to restore active games:', error.message);
      console.log('⚠️  Continuing without restoring active games');
    }
    
    // Start server and capture instance so we can close it on shutdown
    server = app.listen(PORT, () => {
      console.log(`🚀 QRush Trivia server running on port ${PORT}`);
      console.log(`📱 Environment: ${process.env.NODE_ENV}`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
      console.log(`📊 Admin dashboard: http://localhost:${PORT}/admin`);
    });
    

    
  } catch (error) {
    console.error('❌ Application initialization failed:', error);
    process.exit(1);
  }
}

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  await gracefulShutdown();
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  await gracefulShutdown();
});

async function gracefulShutdown() {
  try {
    console.log('🧹 Cleaning up resources...');
    // Stop accepting new connections and wait for current requests to finish
    if (server) {
      console.log('⏳ Closing HTTP server and draining connections...');
      await new Promise((resolve) => {
        // If server.close doesn't call back in 10s, continue cleanup
        const timeout = setTimeout(() => {
          console.warn('⚠️ server.close() timed out after 10s, continuing shutdown');
          resolve();
        }, 10000);

        server.close(() => {
          clearTimeout(timeout);
          console.log('🔒 HTTP server closed');
          resolve();
        });
      });
    }

    // Cleanup worker threads
    await workerManager.cleanup();

    // Cleanup game service (timers)
    gameService.cleanupAllTimers();

    // Cleanup queue service
    await queueService.cleanup();

    // Close database connection
    await sequelize.close();

    console.log('✅ Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Start the application
initializeApp();

module.exports = app;
