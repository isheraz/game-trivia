const Queue = require('bull');
const Redis = require('ioredis');
const MessageBatcher = require('./messageBatcher');
const logger = require('../utils/logger');

console.log('🔧 Initializing Queue Service...');

class QueueService {
  constructor() {
    this.redisConnected = false;
    this.redis = null;
    this.messageQueue = null;
    this.gameQueue = null;
    this.messageBatcher = new MessageBatcher();
    this.activeJobs = new Map(); // Track active jobs by gameId

    // Initialize Redis connection
    this.initializeRedis();
  }

  initializeRedis() {
    if (!process.env.REDIS_URL) {
      console.log("RAW REDIS_URL:", JSON.stringify(process.env.REDIS_URL));
      console.log('⚠️  REDIS_URL not found, running without Redis queues');
      return;
    }

    try {
      console.log('🔄 Creating Redis connection...');
      console.log('🔍 Redis URL:', process.env.REDIS_URL);

      // Auto-detect TLS based on rediss:// scheme
      const needsTLS = process.env.REDIS_URL.startsWith("rediss://");
      console.log('🔍 TLS required:', needsTLS);

      this.redis = new Redis(process.env.REDIS_URL, {
        tls: needsTLS ? {} : undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 10000,
        family: 4, // IPv4
        keepAlive: 30000,
      });

      this.redis.on("connect", () => {
        console.log("✅ Connected to Redis");
        this.redisConnected = true;
        this.initializeQueues();
      });

      this.redis.on("error", (err) => {
        if (!this.redisConnected) {
          console.log("❌ Redis connection error details:");
          console.log("   Error message:", err.message);
          console.log("   Error code:", err.code);
          console.log("   Error errno:", err.errno);
          console.log("   Error syscall:", err.syscall);
          console.log("   Error address:", err.address);
          console.log("   Error port:", err.port);
          console.log("⚠️  Continuing without Redis - app will work with reduced functionality");
          this.redisConnected = false;
          this.redis = null;
        }
      });

      this.redis.on("close", () => {
        this.redisConnected = false;
      });

      // Fallback timeout
      setTimeout(() => {
        if (!this.redisConnected) {
          console.log("⚠️  Redis connection timeout - continuing without Redis");
          this.redis = null;
        }
      }, 10000);

    } catch (error) {
      console.log("❌ Redis initialization error details:");
      console.log("   Error message:", error.message);
      console.log("   Error code:", error.code);
      console.log("   Error errno:", error.errno);
      console.log("   Error syscall:", error.syscall);
      console.log("   Error address:", error.address);
      console.log("   Error port:", error.port);
      console.log("⚠️  Continuing without Redis - app will work with reduced functionality");
      this.redis = null;
    }
  }

  async testRedisConnection() {
    if (!this.redis) {
      console.log('⚠️  Redis not available for testing');
      return;
    }

    try {
      console.log('🧪 Testing basic Redis operations...');
      await this.redis.set('test_key', 'test_value');
      const value = await this.redis.get('test_key');
      console.log('✅ Redis set/get test successful:', value);
      await this.redis.del('test_key');
      console.log('✅ Redis test completed successfully');
    } catch (error) {
      console.error('❌ Redis test failed:', error.message);
    }
  }

  initializeQueues() {
    if (!this.redis) {
      console.log('⚠️  Redis not available, skipping queue initialization');
      return;
    }
  
    try {
      console.log('🔄 Initializing Bull queues...');
      console.log('🔍 Redis URL for queues:', process.env.REDIS_URL);
  
      // Just pass the URL (Bull handles redis:// vs rediss:// automatically)
      this.messageQueue = new Queue('whatsapp-messages', process.env.REDIS_URL);
      this.gameQueue = new Queue('game-timers', process.env.REDIS_URL);
  
      // Add error handlers for queues
      this.messageQueue.on('error', (error) => {
        console.error('❌ Message queue error:', error);
      });
      
      this.gameQueue.on('error', (error) => {
        console.error('❌ Game queue error:', error);
      });
  
      this.setupQueueHandlers();
      this.setupQueueEvents();
  
      console.log('✅ Queues initialized successfully');
      console.log('📊 Message queue ready:', !!this.messageQueue);
      console.log('📊 Game queue ready:', !!this.gameQueue);
    } catch (error) {
      console.error('❌ Failed to initialize queues:', error.message);
      console.error('❌ Queue initialization error details:', error);
      this.messageQueue = null;
      this.gameQueue = null;
    }
  }
  

  setupQueueHandlers() {
    if (!this.messageQueue || !this.gameQueue) {
      console.log('⚠️  Queues not available, skipping queue handlers setup');
      return;
    }

    console.log('🔧 Setting up queue handlers...');
    console.log('⚡ Message queue concurrency: 5 workers (optimized for message ordering)');
    console.log('⚡ Game queue concurrency: 20 workers (optimized for 100+ users)');

    this.messageQueue.process('send_message', 5, async (job) => {
      try {
        console.log('📤 Processing send_message job:', job.id);
        return await this.processMessage(job.data);
      } catch (error) {
        console.error('❌ Message queue processing error:', error);
        throw error;
      }
    });

    this.messageQueue.process('send_template', 5, async (job) => {
      try {
        console.log('📤 Processing send_template job:', job.id);
        return await this.processTemplate(job.data);
      } catch (error) {
        console.error('❌ Template queue processing error:', error);
        throw error;
      }
    });

    this.messageQueue.process('send_question', 5, async (job) => {
      try {
        console.log('📤 Processing send_question job:', job.id);
        return await this.processQuestion(job.data);
      } catch (error) {
        console.error('❌ Question queue processing error:', error);
        throw error;
      }
    });

    this.messageQueue.process('send_elimination', 5, async (job) => {
      try {
        console.log('📤 Processing send_elimination job:', job.id);
        return await this.processElimination(job.data);
      } catch (error) {
        console.error('❌ Elimination queue processing error:', error);
        throw error;
      }
    });

    this.gameQueue.process('game_timer', 20, async (job) => {
      try {
        console.log('⏰ Processing game_timer job:', job.id);
        return await this.processGameTimer(job.data);
      } catch (error) {
        console.error('❌ Game timer processing error:', error);
        throw error;
      }
    });

    this.gameQueue.process('question_timer', 20, async (job) => {
      try {
        console.log('❓ Processing question_timer job:', job.id);
        return await this.processQuestionTimer(job.data);
      } catch (error) {
        console.error('❌ Question timer processing error:', error);
        throw error;
      }
    });
  }

  setupQueueEvents() {
    if (!this.messageQueue || !this.gameQueue) return;

    this.messageQueue.on('completed', (job) => {
      console.log(`✅ Message job ${job.id} completed`);
    });

    this.messageQueue.on('failed', (job, err) => {
      console.error(`❌ Message job ${job.id} failed:`, err.message);
    });

    this.gameQueue.on('completed', (job) => {
      console.log(`✅ Game timer job ${job.id} completed`);
    });

    this.gameQueue.on('failed', (job, err) => {
      console.error(`❌ Game timer job ${job.id} failed:`, err.message);
    });
  }

  async testConnection() {
    if (!this.redis) {
      console.log('⚠️  Redis not initialized');
      return false;
    }
    try {
      const pong = await this.redis.ping();
      console.log('✅ Redis ping successful:', pong);
      return true;
    } catch (error) {
      console.error('❌ Redis ping failed:', error.message);
      return false;
    }
  }

  async addMessage(type, data, options = {}) {
    // Silent queue operations - only log errors
    
    if (!this.messageQueue) {
      console.log('⚠️  Message queue not available, skipping message');
      console.log('🔍 Queue status:', {
        messageQueue: !!this.messageQueue,
        gameQueue: !!this.gameQueue,
        redis: !!this.redis,
        redisConnected: this.redisConnected
      });
      return null;
    }

    // Use batching for send_message type to handle 200+ users efficiently
    if (type === 'send_message') {
      // For high priority messages (like JOIN responses), send immediately
      if (data.priority === 'high' || data.messageType === 'join_response') {
        console.log('⚡ Sending high priority message immediately');
        try {
          const whatsappService = require('./whatsappService');
          const result = await whatsappService.sendTextMessage(data.to, data.message);
          return { success: true, result };
        } catch (error) {
          console.error('❌ Failed to send immediate message:', error.message);
          return null;
        }
      }
      
      // For normal messages, use batching
      try {
        return await this.addBatchedMessage(data.to, data.message, data.priority || 'normal');
      } catch (error) {
        logger.error('❌ Failed to add batched message:', error.message);
        return null;
      }
    }

    try {
      const job = await this.messageQueue.add(type, data, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 50,
        ...options
      });
      console.log(`📤 Added message job ${job.id} to queue`);
      
      // Track job if it's game-related
      if (data.gameId) {
        this.trackJob(data.gameId, job.id, type);
      }
      
      return job;
    } catch (error) {
      console.error('❌ Failed to add message to queue:', error.message);
      return null;
    }
  }

  /**
   * Add a message using the message batcher for high-volume scenarios
   * @param {string} to - Recipient phone number
   * @param {string} message - Message content
   * @param {string} priority - Message priority (high, normal, low)
   * @returns {Promise} - Resolves when message is processed
   */
  async addBatchedMessage(to, message, priority = 'normal') {
    try {
      return await this.messageBatcher.addMessage(to, message, priority);
    } catch (error) {
      console.error('❌ Failed to add batched message:', error.message);
      throw error;
    }
  }

  /**
   * Get message batcher statistics
   * @returns {Object} - Batcher statistics
   */
  getBatcherStats() {
    return this.messageBatcher.getStats();
  }

  /**
   * Flush all pending batched messages
   */
  async flushBatchedMessages() {
    await this.messageBatcher.flush();
  }

  async addGameTimer(type, data, delay = 0) {
    if (!this.gameQueue) {
      console.log('⚠️  Game queue not available, skipping timer');
      return null;
    }
    try {
      const job = await this.gameQueue.add(type, data, {
        delay: delay * 1000,
        attempts: 1,
        removeOnComplete: 50,
        removeOnFail: 25
      });
      console.log(`⏰ Added game timer job ${job.id} with ${delay}s delay`);
      return job;
    } catch (error) {
      console.error('❌ Failed to add game timer to queue:', error.message);
      return null;
    }
  }

  async processMessage(data) {
    const { to, message, gameId, messageType, questionIndex } = data;
    
    console.log(`📤 [QUEUE_SERVICE] Processing message:`);
    console.log(`📤 [QUEUE_SERVICE] - To: ${to}`);
    console.log(`📤 [QUEUE_SERVICE] - Message: "${message}"`);
    console.log(`📤 [QUEUE_SERVICE] - GameId: ${gameId}`);
    console.log(`📤 [QUEUE_SERVICE] - MessageType: ${messageType}`);
    console.log(`📤 [QUEUE_SERVICE] - QuestionIndex: ${questionIndex}`);
    
    // CRITICAL FIX: Per-user message serialization to prevent ordering issues
    const userLockKey = `user_message_lock:${to}`;
    const lockAcquired = await this.acquireLock(userLockKey, 10);
    
    if (!lockAcquired) {
      console.log(`⚠️ [QUEUE_SERVICE] Could not acquire user lock for ${to}, retrying...`);
      // Wait a bit and retry
      await new Promise(resolve => setTimeout(resolve, 100));
      const retryLock = await this.acquireLock(userLockKey, 10);
      if (!retryLock) {
        console.log(`❌ [QUEUE_SERVICE] Failed to acquire user lock after retry for ${to}`);
        return { message: 'user_lock_failed' };
      }
    }
    
    try {
      // Create deduplication key for critical game messages
      if (gameId && messageType && ['game_start', 'elimination', 'late_elimination', 'timeout_elimination', 'game_end', 'emergency_end', 'question_sent', 'countdown_reminder', 'correct_answer'].includes(messageType)) {
        // Include question index for elimination messages to prevent cross-question duplicates
        const dedupeKey = questionIndex !== undefined ? 
          `message_sent:${gameId}:${messageType}:${questionIndex}:${to}` :
          `message_sent:${gameId}:${messageType}:${to}`;
        
        console.log(`🔑 [QUEUE_SERVICE] Deduplication key: ${dedupeKey}`);
        
        if (this.redis) {
          try {
            const alreadySent = await this.redis.get(dedupeKey);
            if (alreadySent) {
              console.log(`🔄 [QUEUE_SERVICE] Skipping duplicate ${messageType} message to ${to} (already sent)`);
              return { message: 'duplicate_skipped' };
            }
            
            // Mark as sent with appropriate expiration
            const expiration = ['elimination', 'late_elimination', 'timeout_elimination'].includes(messageType) ? 60 : 
                             messageType === 'countdown_reminder' ? 15 : 30;
            await this.redis.setex(dedupeKey, expiration, 'sent');
            console.log(`✅ [QUEUE_SERVICE] ${messageType} message marked as sent to ${to}`);
          } catch (error) {
            console.error('❌ [QUEUE_SERVICE] Redis message deduplication error:', error);
            // Continue with sending if Redis fails
          }
        }
      }
      
      console.log(`📤 [QUEUE_SERVICE] Sending message to WhatsApp API...`);
      const whatsappService = require('./whatsappService');
      const result = await whatsappService.sendTextMessage(to, message);
      console.log(`📤 [QUEUE_SERVICE] WhatsApp API result:`, result);
      
      // Add small delay to respect Meta's rate limits and ensure message ordering
      await new Promise(resolve => setTimeout(resolve, 200));
      
      return result;
    } finally {
      // Always release the user lock
      await this.releaseLock(userLockKey);
    }
  }

  async processTemplate(data) {
    const { to, templateName, parameters } = data;
    const whatsappService = require('./whatsappService');
    return await whatsappService.sendTemplateMessage(to, templateName, parameters);
  }

  async processQuestion(data) {
    const { to, questionText, options, questionNumber, correctAnswer, gameId } = data;
    
    console.log(`🎯 Processing question ${questionNumber} for ${to} in game ${gameId}`);
    
    // Create deduplication key for this question to this user (but be less aggressive)
    const dedupeKey = `question_sent:${gameId}:${questionNumber}:${to}`;
    
    // Check if this question was already sent to this user (only for same question number)
    if (this.redis) {
      try {
        const alreadySent = await this.redis.get(dedupeKey);
        if (alreadySent) {
          console.log(`🔄 Skipping duplicate question ${questionNumber} to ${to} (already sent)`);
          return { message: 'duplicate_skipped' };
        }
        
        // Mark as sent with 2 minute expiration (shorter for better responsiveness)
        await this.redis.setex(dedupeKey, 120, 'sent');
        console.log(`✅ Question ${questionNumber} marked as sent to ${to}`);
      } catch (error) {
        console.error('❌ Redis deduplication error:', error);
        // Continue with sending if Redis fails
      }
    }
    
    console.log(`📤 Sending question ${questionNumber} to ${to} via WhatsApp service`);
    const whatsappService = require('./whatsappService');
    const result = await whatsappService.sendQuestion(to, questionText, options, questionNumber, correctAnswer);
    console.log(`✅ Question ${questionNumber} sent to ${to}, result:`, result);
    
    // Mark question completion for timing synchronization
    if (gameId && this.redis) {
      try {
        const completionKey = `question_completed:${gameId}:${questionNumber}`;
        await this.redis.incr(completionKey);
        await this.redis.expire(completionKey, 300); // 5 minute TTL
        console.log(`✅ Marked question ${questionNumber} completion for game ${gameId}`);
      } catch (error) {
        console.error('❌ Error marking question completion:', error);
      }
    }
    
    return result;
  }

  async processElimination(data) {
    const { to, correctAnswer, isCorrect } = data;
    const whatsappService = require('./whatsappService');
    return await whatsappService.sendEliminationMessage(to, correctAnswer, isCorrect);
  }

  async processGameTimer(data) {
    const { gameId, action } = data;
    const gameService = require('./gameService');
    switch (action) {
      case 'start_game': return await gameService.startGame(gameId);
      case 'end_game': return await gameService.endGame(gameId);
      case 'next_question': return await gameService.nextQuestion(gameId);
      default: console.log('⚠️  Unknown game timer action:', action);
    }
  }

  async processQuestionTimer(data) {
    const { gameId, questionId } = data;
    const gameService = require('./gameService');
    return await gameService.timeoutQuestion(gameId, questionId);
  }

  async getQueueStats() {
    if (!this.messageQueue || !this.gameQueue) {
      return {
        messageQueue: { available: false },
        gameQueue: { available: false }
      };
    }
    try {
      return {
        messageQueue: {
          available: true,
          waiting: await this.messageQueue.getWaiting(),
          active: await this.messageQueue.getActive(),
          completed: await this.messageQueue.getCompleted(),
          failed: await this.messageQueue.getFailed()
        },
        gameQueue: {
          available: true,
          waiting: await this.gameQueue.getWaiting(),
          active: await this.gameQueue.getActive(),
          completed: await this.gameQueue.getCompleted(),
          failed: await this.gameQueue.getFailed()
        }
      };
    } catch (error) {
      console.error('❌ Failed to get queue stats:', error.message);
      return {
        messageQueue: { available: false, error: error.message },
        gameQueue: { available: false, error: error.message }
      };
    }
  }

  // Session management methods
  async getSession(userId) {
    if (!this.redis) {
      console.log('⚠️  Redis not available for session management');
      return null;
    }
    try {
      const sessionData = await this.redis.get(`session:${userId}`);
      return sessionData ? JSON.parse(sessionData) : null;
    } catch (error) {
      console.error('❌ Error getting session:', error.message);
      return null;
    }
  }

  async setSession(userId, sessionData) {
    if (!this.redis) {
      console.log('⚠️  Redis not available for session management');
      return false;
    }
    try {
      await this.redis.setex(`session:${userId}`, 3600, JSON.stringify(sessionData)); // 1 hour expiry
      return true;
    } catch (error) {
      console.error('❌ Error setting session:', error.message);
      return false;
    }
  }

  async deleteSession(userId) {
    if (!this.redis) {
      console.log('⚠️  Redis not available for session management');
      return false;
    }
    try {
      await this.redis.del(`session:${userId}`);
      return true;
    } catch (error) {
      console.error('❌ Error deleting session:', error.message);
      return false;
    }
  }

  // Redis-based locking mechanism for race condition prevention
  async acquireLock(lockKey, ttlSeconds = 30) {
    if (!this.redis) {
      console.log('⚠️  Redis not available for locking');
      return false;
    }

    try {
      const lockValue = Date.now().toString();
      const result = await this.redis.set(lockKey, lockValue, 'PX', ttlSeconds * 1000, 'NX');
      return result === 'OK';
    } catch (error) {
      console.error('❌ Error acquiring lock:', error);
      return false;
    }
  }

  async releaseLock(lockKey) {
    if (!this.redis) return;

    try {
      await this.redis.del(lockKey);
    } catch (error) {
      console.error('❌ Error releasing lock:', error);
    }
  }

  async isLocked(lockKey) {
    if (!this.redis) return false;

    try {
      const result = await this.redis.exists(lockKey);
      return result === 1;
    } catch (error) {
      console.error('❌ Error checking lock:', error);
      return false;
    }
  }

  // Track job for a specific game
  trackJob(gameId, jobId, jobType) {
    if (!this.activeJobs.has(gameId)) {
      this.activeJobs.set(gameId, []);
    }
    this.activeJobs.get(gameId).push({ jobId, jobType });
    console.log(`📝 [QUEUE] Tracking ${jobType} job ${jobId} for game ${gameId} (total tracked: ${this.activeJobs.get(gameId).length})`);
  }

  // Cancel all jobs for a specific game
  async cancelGameJobs(gameId) {
    if (!this.messageQueue || !this.gameQueue) {
      console.log(`⚠️ [QUEUE] Queues not available for job cancellation: gameId=${gameId}`);
      return;
    }
    
    try {
      const jobs = this.activeJobs.get(gameId) || [];
      console.log(`🧹 [QUEUE] Cancelling ${jobs.length} jobs for game ${gameId}`);
      
      let cancelledCount = 0;
      let notFoundCount = 0;
      let errorCount = 0;
      
      for (const { jobId, jobType } of jobs) {
        try {
          if (jobType.includes('message') || jobType.includes('question') || jobType.includes('elimination')) {
            const job = await this.messageQueue.getJob(jobId);
            if (job) {
              await job.remove();
              cancelledCount++;
              console.log(`✅ [QUEUE] Cancelled message job ${jobId} (${jobType}) for game ${gameId}`);
            } else {
              notFoundCount++;
              console.log(`⚠️ [QUEUE] Message job ${jobId} not found for game ${gameId}`);
            }
          } else if (jobType.includes('timer') || jobType.includes('game')) {
            const job = await this.gameQueue.getJob(jobId);
            if (job) {
              await job.remove();
              cancelledCount++;
              console.log(`✅ [QUEUE] Cancelled game job ${jobId} (${jobType}) for game ${gameId}`);
            } else {
              notFoundCount++;
              console.log(`⚠️ [QUEUE] Game job ${jobId} not found for game ${gameId}`);
            }
          }
        } catch (error) {
          errorCount++;
          console.error(`❌ [QUEUE] Error cancelling job ${jobId} (${jobType}):`, error.message);
        }
      }
      
      // Clear tracked jobs
      this.activeJobs.delete(gameId);
      console.log(`✅ [QUEUE] Job cancellation summary for game ${gameId}: ${cancelledCount} cancelled, ${notFoundCount} not found, ${errorCount} errors`);
    } catch (error) {
      console.error('❌ [QUEUE] Error cancelling game jobs:', error);
    }
  }

  // Clear deduplication keys for a game (call when game ends)
  async clearGameDeduplication(gameId) {
    if (!this.redis) return;
    
    try {
      console.log(`🧹 Clearing deduplication keys for game ${gameId}`);
      
      // Get all keys matching the game pattern (using safe scan)
      const questionKeys = await this.safeRedisScan(`question_sent:${gameId}:*`);
      const messageKeys = await this.safeRedisScan(`message_sent:${gameId}:*`);
      const reminderKeys = await this.safeRedisScan(`reminder_sent:${gameId}:*`);
      const resultKeys = await this.safeRedisScan(`result_decided:${gameId}:*`);
      
      const allKeys = [...questionKeys, ...messageKeys, ...reminderKeys, ...resultKeys];
      
      if (allKeys.length > 0) {
        await this.redis.del(...allKeys);
        console.log(`✅ Cleared ${allKeys.length} deduplication keys for game ${gameId}`);
      } else {
        console.log(`ℹ️  No deduplication keys found for game ${gameId}`);
      }
    } catch (error) {
      console.error('❌ Error clearing deduplication keys:', error);
    }
  }

  // Safe Redis scan to replace dangerous keys() command
  async safeRedisScan(pattern) {
    try {
      const keys = [];
      let cursor = '0';
      
      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== '0');
      
      return keys;
    } catch (error) {
      console.error('❌ Error scanning Redis keys:', error);
      return [];
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up queues...');
    if (this.messageQueue) await this.messageQueue.close();
    if (this.gameQueue) await this.gameQueue.close();
    if (this.redis) await this.redis.quit();
    console.log('✅ Queue cleanup completed');
  }
}

const queueService = new QueueService();
module.exports = queueService;
