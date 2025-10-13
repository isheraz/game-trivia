/**
 * PM2 Ecosystem Configuration for QRush Trivia
 * Optimized for 1000+ concurrent users with cluster mode
 */

module.exports = {
  apps: [{
    name: 'qrush-trivia',
    script: './backend/app.js',
    instances: 1, // Single instance to prevent message ordering issues
    exec_mode: 'fork', // Use fork mode instead of cluster for message consistency
    
    // Environment variables
    env: {
      NODE_ENV: 'development',
      PORT: 3000,
      UV_THREADPOOL_SIZE: 16, // Increase libuv threads for I/O operations
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
      DATABASE_URL: process.env.DATABASE_URL,
      WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN
    },
    
    env_production: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      UV_THREADPOOL_SIZE: 32, // More threads for production
      REDIS_URL: process.env.REDIS_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
      ANSWER_GRACE_MS: process.env.ANSWER_GRACE_MS || 3000
    },
    
    // Memory and restart settings
    max_memory_restart: '1G',
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    
    // Logging configuration
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Monitoring and health checks
    pmx: true,
    monitoring: true,
    
    // Advanced settings for high load
    kill_timeout: 5000,
    listen_timeout: 3000,
    shutdown_with_message: true,
    
    // Auto-scaling based on CPU/Memory
    max_instances: 8, // Maximum instances
    min_instances: 2, // Minimum instances
    
    // Health check
    health_check_grace_period: 3000,
    health_check_fatal_exceptions: true
  }],
  
  // Deployment configuration for Railway
  deploy: {
    production: {
      user: 'railway',
      host: process.env.RAILWAY_HOST || 'localhost',
      ref: 'origin/main',
      repo: process.env.RAILWAY_REPO || 'git@github.com:your-repo/qrush-trivia.git',
      path: '/app',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'apt-get update && apt-get install git -y'
    }
  }
};
