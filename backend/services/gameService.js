const { Game, User, Question, GamePlayer, PlayerAnswer } = require('../models');
const queueService = require('./queueService');
const logger = require('../utils/logger');
const rewardService = require('./rewardService');
const whatsappService = require('./whatsappService');
const CircuitBreaker = require('./circuitBreaker');
const RedisGameState = require('./redisGameState');

class GameService {
  constructor() {
    this.activeGames = new Map(); // In-memory game state (fallback)
    this.redisGameState = new RedisGameState(); // Redis game state (primary)
    this.circuitBreaker = new CircuitBreaker();
    this.activeTimers = new Map(); // Store timer objects in memory (not in Redis)
    console.log('✅ Circuit Breaker initialized for GameService');
    console.log('✅ Redis Game State initialized for GameService');
    console.log('✅ Active Timers Map initialized for GameService');
    console.log('✅ No grace period - strict 10 second timer');
  }

  /**
   * Get game state (Redis first, then in-memory fallback)
   * @param {string} gameId - Game ID
   * @returns {Promise<Object|null>} Game state
   */
  async getGameState(gameId) {
    // Try Redis first
    if (this.redisGameState.isAvailable()) {
      const redisState = await this.redisGameState.getGameState(gameId);
      if (redisState) {
        return redisState;
      }
    }
    
    // Fallback to in-memory
    return this.activeGames.get(gameId) || null;
  }

  /**
   * Set game state (Redis first, then in-memory fallback)
   * @param {string} gameId - Game ID
   * @param {Object} gameState - Game state
   * @returns {Promise<boolean>} Success status
   */
  async setGameState(gameId, gameState) {
    // Try Redis first
    if (this.redisGameState.isAvailable()) {
      const success = await this.redisGameState.setGameState(gameId, gameState);
      if (success) {
        return true;
      }
    }
    
    // Fallback to in-memory
    this.activeGames.set(gameId, gameState);
    return true;
  }

  // Restore active games from database on server startup
  async restoreActiveGames() {
    try {
      console.log('🔄 Restoring active games from database...');
      
      // First, ensure database tables exist
      const { sequelize } = require('../config/database');
      await sequelize.sync({ force: false }); // Create tables if they don't exist
      console.log('✅ Database tables synchronized');
      
      const activeGames = await Game.findAll({
        where: { status: 'in_progress' },
        include: [
          { model: Question, as: 'questions', order: [['question_order', 'ASC']] },
          { 
            model: GamePlayer, 
            as: 'players',
            include: [{ model: User, as: 'user' }]
          }
        ]
      });

      for (const game of activeGames) {
        console.log(`🔄 Restoring game: ${game.id}`);
        
        // Convert database models to in-memory format
        const gameState = {
          id: game.id,
          status: game.status,
          currentQuestion: game.current_question || 0,
          questions: game.questions.map(q => ({
            id: q.id,
            question_text: q.question_text,
            correct_answer: q.correct_answer,
            option_a: q.option_a,
            option_b: q.option_b,
            option_c: q.option_c,
            option_d: q.option_d,
            time_limit: q.time_limit || 14
          })),
          players: game.players.map(p => ({
            user: {
              id: p.user.id,
              nickname: p.user.nickname,
              whatsapp_number: p.user.whatsapp_number
            },
            status: p.status,
            answer: null, // Reset answers since we can't restore them
            answerTime: null
          })),
          startTime: game.start_time || new Date(),
          questionTimer: null
        };

        // Store in Redis as primary, in-memory as fallback
        await this.setGameState(game.id, gameState);
        console.log(`✅ Restored game ${game.id} with ${gameState.players.length} players`);
        
        // If game was in progress, restart the question timer
        if (gameState.status === 'in_progress' && gameState.currentQuestion < gameState.questions.length) {
          console.log(`🔄 Restarting question timer for restored game ${game.id}`);
          // Don't restart timer immediately, let the game continue from where it left off
          // The next question will be started when the current one times out or all players answer
        }
      }

      console.log(`✅ Restored ${activeGames.length} active games`);
      
    } catch (error) {
      console.log("game  restoreee errorrrr  1");
      console.error('❌ Error restoring active games:', error);
    }
  }

  // Generate timer bar visualization
  // Timer bar function removed - no more timer notifications

  // Clear terminal for easier debugging
  clearTerminal() {
    // Clear terminal using ANSI escape codes
    process.stdout.write('\x1B[2J\x1B[0f');
    console.log('🧹 Terminal cleared for new game debugging');
    console.log('='.repeat(80));
    console.log('🎮 NEW GAME STARTING - CLEAN LOGS');
    console.log('='.repeat(80));
  }

  // Clear stale Redis keys that might cause games to get stuck
  async clearStaleGameKeys(gameId) {
    try {
      const queueService = require('./queueService');
      if (!queueService.redis) {
        console.log('⚠️ Redis not available for clearing stale keys');
        return;
      }

      console.log(`🧹 Clearing stale Redis keys for game ${gameId}...`);
      
      // Clear result_decided keys for this game (using safe scan)
      const resultKeys = await this.safeRedisScan(`result_decided:${gameId}:*`);
      if (resultKeys.length > 0) {
        await queueService.redis.del(...resultKeys);
        console.log(`🗑️ Cleared ${resultKeys.length} stale result_decided keys`);
      }

      // Clear any other game-specific keys that might cause issues (using safe scan)
      const gameKeys = await this.safeRedisScan(`*:${gameId}:*`);
      if (gameKeys.length > 0) {
        console.log(`🔍 Found ${gameKeys.length} game-specific keys, clearing potentially stale ones...`);
        for (const key of gameKeys) {
          // Only clear keys that might cause processing issues
          if (key.includes('result_decided') || key.includes('question_sent')) {
            await queueService.redis.del(key);
            console.log(`🗑️ Cleared stale key: ${key}`);
          }
        }
      }

      console.log(`✅ Stale Redis keys cleared for game ${gameId}`);
    } catch (error) {
      console.error('❌ Error clearing stale Redis keys:', error);
    }
  }

  // Start a new game
  async startGame(gameId) {
    try {
      // Clear terminal for easier debugging
      this.clearTerminal();
      
      // Clear any stale Redis keys from previous games
      await this.clearStaleGameKeys(gameId);
      
      // Circuit breaker protection for game start
      if (!this.circuitBreaker.canExecute('startGame')) {
        throw new Error('Game service is temporarily unavailable due to high error rate');
      }
      const game = await Game.findByPk(gameId, {
        include: [
          { 
            model: Question, 
            as: 'questions',
            order: [['question_order', 'ASC']]
          },
          { model: GamePlayer, as: 'players', include: [{ model: User, as: 'user' }] }
        ]
      });

      if (!game) {
        throw new Error('Game not found');
      }

      // Update game status
      game.status = 'in_progress';
      game.start_time = new Date();
      await game.save();

      // Only include players who have actively joined (status: 'registered' or 'alive')
      const activePlayers = game.players.filter(player => 
        player.status === 'registered' || player.status === 'alive'
      );

      if (activePlayers.length === 0) {
        throw new Error('No players have joined this game. Game cannot start.');
      }

      // Update all joined players to 'alive' status in database
      await GamePlayer.update(
        { status: 'alive' },
        { 
          where: { 
            game_id: gameId,
            status: 'registered'
          } 
        }
      );

      // Initialize game state with proper structure
      const sortedQuestions = game.questions
        .sort((a, b) => a.question_order - b.question_order) // Ensure proper ordering
        .map(question => question.toJSON()); // Convert to plain objects
      
      // Debug: Log the questions to verify correct order
      console.log(`🔍 Questions loaded for game ${gameId}:`);
      sortedQuestions.forEach((q, index) => {
        console.log(`  Q${index + 1}: "${q.question_text}" -> Answer: "${q.correct_answer}"`);
      });
      
      const gameState = {
        id: gameId,
        gameId,
        status: 'in_progress',
        currentQuestion: 0,
        questions: sortedQuestions,
        players: activePlayers.map(player => ({
          ...player.toJSON(),
          status: 'alive',
          answer: null,
          answerTime: null,
          eliminatedAt: null,
          eliminatedOnQuestion: null,
          eliminationReason: null
        })),
        startTime: new Date(),
        questionTimer: null,
        activeTimers: new Set()
      };

      await this.setGameState(gameId, gameState);
      console.log(`✅ Game state initialized and saved to Redis for game ${gameId}`);

      // Send game start message to all players
      await this.sendGameStartMessage(gameId);

      // Start first question after 30 seconds
      setTimeout(() => {
        console.log(`🚀 Starting first question for game ${gameId} after 30 second delay`);
        this.startQuestion(gameId, 0);
      }, 30000);

      console.log(`🎮 Game ${gameId} started with ${gameState.players.length} players`);
      
      // Record success in circuit breaker
      this.circuitBreaker.recordSuccess('startGame');
      return gameState;

    } catch (error) {
      console.error('❌ Error starting game:', error);
      // Record failure in circuit breaker
      this.circuitBreaker.recordFailure('startGame');
      throw error;
    }
  }

  // Start a specific question
  async startQuestion(gameId, questionIndex) {
    // Declare lockKey outside try block to fix scope issue
    let lockKey = null;
    
    try {
      console.log(`🎯 startQuestion called: gameId=${gameId}, questionIndex=${questionIndex}`);
      
      // Use Redis lock to prevent race conditions (reduced timeout for better concurrency)
      lockKey = `game_lock:${gameId}:question:${questionIndex}`;
      const lockAcquired = await this.acquireLock(lockKey, 10); // Reduced to 10 seconds for better concurrency
      
      if (!lockAcquired) {
        console.log(`⚠️ Could not acquire lock for game ${gameId} question ${questionIndex}, skipping`);
        return;
      }

      // Check if this question is already being processed to prevent duplication
      const processingKey = `question_processing:${gameId}:${questionIndex}`;
      const isProcessing = await queueService.redis?.get(processingKey);
      if (isProcessing) {
        console.log(`⚠️ Question ${questionIndex + 1} already being processed, skipping duplicate`);
        await this.releaseLock(lockKey);
        return;
      }
      
      // Mark as processing to prevent duplicates
      await queueService.redis?.setex(processingKey, 30, 'processing');
      
      // Get current game state (single call)
      const gameState = await this.getGameState(gameId);
      
      // Additional check: ensure we're not starting a question that's already passed
      if (gameState && gameState.currentQuestion > questionIndex) {
        console.log(`⚠️ Question ${questionIndex + 1} already passed (current: ${gameState.currentQuestion + 1}), skipping`);
        await this.releaseLock(lockKey);
        return;
      }
      if (!gameState) {
        console.log(`❌ Game state not found for ${gameId}`);
        await this.releaseLock(lockKey);
        return;
      }

      console.log(`🔍 Game state found: currentQuestion=${gameState.currentQuestion}, questionIndex=${questionIndex}, players=${gameState.players?.length || 0}`);

      // Check if a question is already running
      if (gameState.questionTimer) {
        console.log(`⚠️ Question timer already running for game ${gameId}, stopping previous timer`);
        clearInterval(gameState.questionTimer);
        gameState.questionTimer = null;
      }

      // Check if we're already on this question (but allow the first question to start)
      if (gameState.currentQuestion > questionIndex) {
        console.log(`⚠️ Question ${questionIndex + 1} already processed or passed, skipping`);
        await this.releaseLock(lockKey);
        return;
      }

      console.log(`✅ Question ${questionIndex + 1} is valid to start, proceeding...`);

      const { questions, players } = gameState;

      if (questionIndex >= questions.length) {
        // Game finished
        console.log(`🏁 All questions completed for game ${gameId}`);
        await this.endGame(gameId);
        return;
      }

      const question = questions[questionIndex];
      gameState.currentQuestion = questionIndex;
      
      // Debug: Log the question being sent
      console.log(`🎯 Sending Question ${questionIndex + 1}:`);
      console.log(`  Text: "${question.question_text}"`);
      console.log(`  Correct Answer: "${question.correct_answer}"`);
      console.log(`  Options: ${question.option_a}, ${question.option_b}, ${question.option_c}, ${question.option_d}`);
      
      // Reset player answer states for new question
      for (const player of players) {
        if (player.status === 'alive') {
          player.answer = null;
          player.answerTime = null;
          player.resultProcessed = false; // Reset result processing flag for new question
        }
      }

      // Update game in database with null check
      const game = await Game.findByPk(gameId);
      if (!game) {
        console.error(`❌ Game not found in database: ${gameId}`);
        throw new Error(`Game ${gameId} not found in database`);
      }
      
      game.current_question = questionIndex;
      await game.save();

      // Send question to all alive players FIRST
      console.log(`📤 Sending question ${questionIndex + 1} to ${players.filter(p => p.status === 'alive').length} alive players`);
      
      // Optimized question sending for scalability
      const alivePlayers = players.filter(p => p.status === 'alive');
      const playerCount = alivePlayers.length;
      
      console.log(`📤 Sending question to ${playerCount} players using optimized batching`);
      
      // Hybrid approach: Use queue for scalability but wait for completion
      console.log(`📤 Sending questions to ${playerCount} players using hybrid approach...`);
      
      // Use queue system for scalability
      const questionPromises = alivePlayers.map(player => 
        queueService.addMessage('send_question', {
          to: player.user.whatsapp_number,
          gameId,
          questionNumber: questionIndex + 1,
          questionText: question.question_text,
          options: [question.option_a, question.option_b, question.option_c, question.option_d],
          correctAnswer: question.correct_answer,
          timeLimit: question.time_limit || 14,
          priority: 'high' // High priority for questions
        })
      );
      
      // Wait for all questions to be queued
      const results = await Promise.all(questionPromises);
      const successCount = results.filter(r => r !== null).length;
      console.log(`📤 Question queuing completed: ${successCount}/${playerCount} queued successfully`);
      
      // Wait for queue processing to complete (with timeout)
      console.log(`⏰ Waiting for queue processing to complete...`);
      await this.waitForQueueCompletion(gameId, questionIndex + 1, playerCount);
      
      console.log(`✅ Question delivery completed - timer will start now`);

      // Set question start time AFTER questions are delivered
      gameState.questionStartTime = new Date();
      console.log(`⏰ Question ${questionIndex + 1} start time set: ${gameState.questionStartTime.toISOString()}`);
      
      // Save updated game state to Redis
      await this.setGameState(gameId, gameState);

      // Start countdown timer AFTER questions are delivered
      const questionTimeLimit = question.time_limit || 14;
      // Use the actual time limit without additional buffer since we already waited for delivery
      await this.startQuestionTimer(gameId, questionIndex, questionTimeLimit);

      console.log(`❓ Question ${questionIndex + 1} started for game ${gameId}`);

      // Release lock after successful completion
      await this.releaseLock(lockKey);
      
      // Clean up processing key
      const cleanupKey = `question_processing:${gameId}:${questionIndex}`;
      await queueService.redis?.del(cleanupKey);

    } catch (error) {
      console.error('❌ Error starting question:', error);
      // Release lock on error if it was acquired
      if (lockKey) {
        await this.releaseLock(lockKey);
      }
      // Clean up processing key on error
      const errorCleanupKey = `question_processing:${gameId}:${questionIndex}`;
      await queueService.redis?.del(errorCleanupKey);
      throw error;
    }
  }

  // Start question timer with countdown reminders
  async startQuestionTimer(gameId, questionIndex, totalSeconds) {
    const gameState = await this.getGameState(gameId);
    if (!gameState) return;

    // Clear any existing timers for this question
    const timerKey = `${gameId}:${questionIndex}`;
    if (this.activeTimers && this.activeTimers.has(timerKey)) {
      console.log(`🔄 Clearing existing timers for question ${questionIndex + 1}`);
      const timers = this.activeTimers.get(timerKey);
      if (timers.questionTimer) clearTimeout(timers.questionTimer);
      if (timers.countdownTimers) {
        timers.countdownTimers.forEach(timer => clearTimeout(timer));
      }
      this.activeTimers.delete(timerKey);
    }

    const startTime = new Date();
    console.log(`⏰ Starting timer for question ${questionIndex + 1} (${totalSeconds}s) with countdown reminders at ${startTime.toISOString()}`);
    console.log(`⏰ [TIMER DEBUG] Question ${questionIndex + 1} timer started at: ${startTime.getTime()}`);

    // Schedule reminder at exactly 5 seconds after question starts
    const reminder5s = setTimeout(async () => {
      const reminderTime = new Date();
      console.log(`⏰ 5s reminder firing at ${reminderTime.toISOString()}`);
      console.log(`⏰ [TIMER DEBUG] 5s reminder at: ${reminderTime.getTime()}, elapsed: ${reminderTime.getTime() - startTime.getTime()}ms`);
      await this.sendCountdownReminder(gameId, questionIndex, 5);
    }, 5000); // Exactly 5 seconds after question starts (no change needed)

    // Main timeout (exactly the specified time)
    const mainTimer = setTimeout(async () => {
      const timeoutTime = new Date();
      console.log(`⏰ Question ${questionIndex + 1} time expired - processing timeout`);
      console.log(`⏰ [TIMER DEBUG] Timeout at: ${timeoutTime.getTime()}, elapsed: ${timeoutTime.getTime() - startTime.getTime()}ms`);
      await this.handleQuestionTimeout(gameId, questionIndex);
    }, totalSeconds * 1000); // Use the actual time limit

    // Store timer IDs instead of timer objects (to avoid circular structure)
    gameState.questionTimerId = mainTimer[Symbol.toPrimitive] ? mainTimer[Symbol.toPrimitive]() : mainTimer.toString();
    gameState.countdownTimerIds = [reminder5s].map(timer => 
      timer[Symbol.toPrimitive] ? timer[Symbol.toPrimitive]() : timer.toString()
    );
    
    // Store actual timer objects in memory (not in Redis)
    if (!this.activeTimers) this.activeTimers = new Map();
    this.activeTimers.set(`${gameId}:${questionIndex}`, {
      questionTimer: mainTimer,
      countdownTimers: [reminder5s]
    });
    
    // Save updated game state (without timer objects)
    await this.setGameState(gameId, gameState);
  }

  // Send countdown reminder to alive players who haven't answered
  async sendCountdownReminder(gameId, questionIndex, secondsLeft) {
    try {
      const gameState = await this.getGameState(gameId);
      if (!gameState) {
        console.log(`❌ Game state not found for countdown reminder: gameId=${gameId}, question=${questionIndex + 1}, secondsLeft=${secondsLeft}`);
        return;
      }

      // Check if question is still active (not already processed)
      if (gameState.currentQuestion > questionIndex) {
        console.log(`⏰ Skipping ${secondsLeft}s reminder - question ${questionIndex + 1} already processed (current: ${gameState.currentQuestion + 1})`);
        return;
      }

      // Get fresh game state to ensure we have latest player statuses
      const freshGameState = await this.getGameState(gameId);
      const alivePlayers = freshGameState.players.filter(p => p.status === 'alive');
      
      // Add small delay to ensure all recent answers are saved
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Get the most up-to-date game state after delay
      const updatedGameState = await this.getGameState(gameId);
      const updatedAlivePlayers = updatedGameState.players.filter(p => p.status === 'alive');
      const playersNeedingReminder = updatedAlivePlayers.filter(p => !p.answer || p.answer.trim() === '');

      console.log(`⏰ [COUNTDOWN] Game ${gameId} Q${questionIndex + 1}: Sending ${secondsLeft}s reminder to ${playersNeedingReminder.length}/${updatedAlivePlayers.length} players`);
      console.log(`⏰ [COUNTDOWN] Players needing reminder: ${playersNeedingReminder.map(p => p.user.nickname).join(', ')}`);
      console.log(`⏰ [COUNTDOWN] Players who already answered: ${updatedAlivePlayers.filter(p => p.answer && p.answer.trim() !== '').map(p => `${p.user.nickname}(${p.answer})`).join(', ')}`);

      let remindersSent = 0;
      let duplicatesSkipped = 0;
      let eliminatedSkipped = 0;

      // Send reminders in batches for better performance
      const batchSize = 15; // Send to 15 players at a time
      for (let i = 0; i < playersNeedingReminder.length; i += batchSize) {
        const batch = playersNeedingReminder.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (player) => {
          // Double-check player is still alive before sending
          const currentPlayer = freshGameState.players.find(p => p.user.whatsapp_number === player.user.whatsapp_number);
          if (!currentPlayer || currentPlayer.status !== 'alive') {
            eliminatedSkipped++;
            return;
          }

          // Use queueService deduplication instead of manual checking
          await queueService.addMessage('send_message', {
            to: player.user.whatsapp_number,
            message: `⏰ ${secondsLeft} seconds left to answer`,
            gameId: gameId,
            messageType: 'countdown_reminder',
            questionIndex: questionIndex
          });
          
          remindersSent++;
        });
        
        // Wait for batch to complete
        await Promise.all(batchPromises);
        
        // Small delay between batches
        if (i + batchSize < playersNeedingReminder.length) {
          await new Promise(resolve => setTimeout(resolve, 50)); // 50ms delay
        }
      }

      console.log(`⏰ [COUNTDOWN] Summary: ${remindersSent} sent, ${duplicatesSkipped} duplicates skipped, ${eliminatedSkipped} eliminated skipped for ${secondsLeft}s reminder`);
    } catch (error) {
      console.error(`❌ Error sending ${secondsLeft}s countdown reminder for game ${gameId} Q${questionIndex + 1}:`, error);
    }
  }

  // Handle late answer elimination
  async handleLateAnswerElimination(gameId, phoneNumber, timeSinceQuestionStart) {
    try {
      console.log(`⏰ Handling late answer elimination for ${phoneNumber} in game ${gameId}`);
      
      const gameState = await this.getGameState(gameId);
      if (!gameState) {
        console.log(`❌ Game ${gameId} not found for late answer elimination`);
        return;
      }

      const player = gameState.players.find(p => p.user.whatsapp_number === phoneNumber);
      if (!player || player.status !== 'alive') {
        console.log(`❌ Player ${phoneNumber} not found or not alive for late answer elimination`);
        return;
      }

      // Mark player as eliminated
      player.status = 'eliminated';
      player.eliminatedAt = new Date();
      player.eliminatedOnQuestion = gameState.currentQuestion + 1;
      player.eliminationReason = 'late_answer';
      
      // Update database
      await GamePlayer.update(
        { 
          status: 'eliminated',
          eliminated_at: new Date(),
          eliminated_by_question: gameState.currentQuestion + 1
        },
        { 
          where: { 
            game_id: gameId,
            user_id: player.user.id 
          } 
        }
      );

      console.log(`❌ Player ${player.user.nickname} eliminated due to late answer on Q${gameState.currentQuestion + 1}`);

      // Save updated game state
      await this.setGameState(gameId, gameState);

      // Check if elimination message was already sent
      const eliminationKey = `elimination_sent:${gameId}:${player.user.whatsapp_number}:${gameState.currentQuestion + 1}`;
      const alreadySent = await queueService.redis?.get(eliminationKey);
      
      if (!alreadySent) {
        // Mark as sent with 5-minute expiration
        await queueService.redis?.setex(eliminationKey, 300, 'sent');
        
        // Send elimination message with full details
        await queueService.addMessage('send_message', {
          to: player.user.whatsapp_number,
          message: `⏰ Too late! You answered after the question timer ended and have been eliminated.

❌ Eliminated on: Question ${gameState.currentQuestion + 1}
🎮 Game: ${gameId.slice(0, 8)}...
⏰ You responded after the timer ended.

Stick around to watch the finish! Reply "PLAY" for the next game.`,
          gameId: gameId,
          messageType: 'late_elimination',
          questionIndex: gameState.currentQuestion
        });
      } else {
        console.log(`🔄 Elimination message already sent to ${player.user.nickname}, skipping duplicate`);
      }

      // Check if game should end (all players eliminated)
      const alivePlayers = gameState.players.filter(p => p.status === 'alive');
      
      if (alivePlayers.length === 0) {
        console.log(`💀 All players eliminated due to late answers, ending game ${gameId}`);
        await this.endGame(gameId);
        return;
      }

    } catch (error) {
      console.error('❌ Error handling late answer elimination:', error);
    }
  }

    // Handle player answer
  async handlePlayerAnswer(gameId, phoneNumber, answer) {
    let lockKey = null; // Declare lockKey outside try block
    try {
      // Use Redis lock to prevent race conditions when multiple players answer simultaneously
      lockKey = `game_lock:${gameId}:answer:${phoneNumber}`;
      const lockAcquired = await this.acquireLock(lockKey, 10); // 10 second lock
      
      if (!lockAcquired) {
        console.log(`⚠️ Could not acquire lock for player ${phoneNumber} in game ${gameId}, skipping`);
        return;
      }

      const gameState = await this.getGameState(gameId);
      if (!gameState) {
        await this.releaseLock(lockKey);
        console.log(`❌ Game not found: ${gameId}`);
        throw new Error('Game not found or not active');
      }

      // Check if the question is still active
      const questionStartTime = gameState.questionStartTime instanceof Date ? gameState.questionStartTime : new Date(gameState.questionStartTime);
      const timeSinceQuestionStart = Date.now() - questionStartTime.getTime();
      const currentQuestion = gameState.questions[gameState.currentQuestion];
      const questionDuration = (currentQuestion?.time_limit || 14) * 1000; // Convert to milliseconds
      const maxAnswerTime = questionDuration;
      
      // Debug timing information (only log if answer is late)
      if (timeSinceQuestionStart > maxAnswerTime) {
        console.log(`⏰ [TIMING] Question start: ${questionStartTime.toISOString()}`);
        console.log(`⏰ [TIMING] Time since start: ${timeSinceQuestionStart}ms (max: ${maxAnswerTime}ms)`);
        console.log(`⏰ [TIMING] Current question: ${gameState.currentQuestion + 1}`);
      }
      
      // Additional check: Ensure we're not processing an answer for a question that has already ended
      if (timeSinceQuestionStart > maxAnswerTime) {
        console.log(`⏰ Answer too late for ${phoneNumber} - ${timeSinceQuestionStart}ms since question start (max: ${maxAnswerTime}ms)`);
        console.log(`⏰ [DEBUG] This answer is being processed for question ${gameState.currentQuestion + 1}, but the timer expired ${timeSinceQuestionStart - maxAnswerTime}ms ago`);
        
        // Check if player was already eliminated by timeout
        const player = gameState.players.find(p => p.user.whatsapp_number === phoneNumber);
        if (player && player.status === 'eliminated') {
          console.log(`🔄 Player ${phoneNumber} already eliminated, skipping late answer elimination`);
          await this.releaseLock(lockKey);
          return { message: 'already_eliminated' };
        }
        
        // Check if this is an answer for a question that has already moved on
        // If the time difference is very large (>30 seconds), it's likely an old answer
        if (timeSinceQuestionStart > 30000) {
          console.log(`⚠️ Answer from ${phoneNumber} is ${timeSinceQuestionStart}ms old - likely from a previous question, ignoring`);
          await this.releaseLock(lockKey);
          return { message: 'answer_from_previous_question' };
        }
        
        // Immediately eliminate player for late answer
        await this.handleLateAnswerElimination(gameId, phoneNumber, timeSinceQuestionStart);
        
        await this.releaseLock(lockKey);
        return { message: 'answer_too_late_eliminated' };
      }
      
      const player = gameState.players.find(p => p.user.whatsapp_number === phoneNumber);
      if (!player) {
        console.log(`❌ Player not found: ${phoneNumber}`);
        throw new Error('Player not found in game');
      }

      if (player.status !== 'alive') {
        console.log(`❌ Player not alive: ${player.status}`);
        throw new Error('Player not active in game');
      }

      // Use Redis for fast answer processing with Unix timestamp
      const answerManager = require('./answerManager');
      const questionStartTimestamp = gameState.questionStartTime instanceof Date ? 
        gameState.questionStartTime.getTime() : new Date(gameState.questionStartTime).getTime();
      
      // Record answer in Redis with timestamp validation
      const answerResult = await answerManager.recordAnswer(
        gameId, 
        gameState.currentQuestion, 
        player.user.id, 
        answer, 
        questionStartTimestamp, 
        maxAnswerTime
      );
      
      if (answerResult.status === 'duplicate') {
        console.log(`🔄 Player ${player.user.nickname} already answered, returning existing result`);
        await this.releaseLock(lockKey);
        return {
          correct: answerResult.existingAnswer === currentQuestion.correct_answer.toLowerCase().trim(),
          correctAnswer: currentQuestion.correct_answer,
          alreadyAnswered: true
        };
      }
      
      // Store answer in Redis but don't evaluate timing yet - wait for timer to expire
      // This ensures fair evaluation for all players regardless of when they answer
      
      // Update player state for consistency
      player.answer = answer;
      player.answerTime = answerResult.timestamp;
      player.resultProcessed = false;
      
      // Save immediately to prevent race conditions
      await this.setGameState(gameId, gameState);

      // Create answer lock key to prevent race conditions
      const answerLockKey = `player_answer:${gameId}:${phoneNumber}:${gameState.currentQuestion}`;
      
      // Acquire lock to prevent multiple answers
      const answerLockAcquired = await queueService.acquireLock(answerLockKey, 5);
      if (!answerLockAcquired) {
        console.log(`🔒 Answer lock not acquired for ${phoneNumber}, skipping duplicate answer`);
        // Clear processing flag if lock not acquired
        player.processingAnswer = false;
        await this.setGameState(gameId, gameState);
        return { message: 'duplicate_answer_skipped' };
      }

      try {
        // Get current question first
        const currentQuestion = gameState.questions[gameState.currentQuestion];
        if (!currentQuestion) {
          console.log(`❌ No current question found for game ${gameId}`);
          return { message: 'no_active_question' };
        }

        // Double-check if player already answered (with lock)
        if (player.answer) {
          // Player already answered - just return result, let timeout handle processing
          // Robust answer comparison for already answered players
          const normalizedPlayerAnswer = player.answer.toLowerCase().trim().replace(/[^\w\s]/g, '');
          const normalizedCorrectAnswer = currentQuestion.correct_answer.toLowerCase().trim().replace(/[^\w\s]/g, '');
          return {
            correct: normalizedPlayerAnswer === normalizedCorrectAnswer,
            correctAnswer: currentQuestion.correct_answer,
            alreadyAnswered: true
          };
        }

        // Answer already set above, just verify with robust comparison
        const normalizedPlayerAnswer = answer.toLowerCase().trim().replace(/[^\w\s]/g, '');
        const normalizedCorrectAnswer = currentQuestion.correct_answer.toLowerCase().trim().replace(/[^\w\s]/g, '');
        const isCorrect = normalizedPlayerAnswer === normalizedCorrectAnswer;
        
        // Database operations are now handled asynchronously after question ends
        // This eliminates the 5-6 second processing delay during answer submission

        // Don't send confirmation message immediately - let the evaluation handle all messaging
        // This prevents confusion and ensures consistent messaging
        console.log(`✅ Answer recorded for ${player.user.nickname}: "${answer}" (correct: ${isCorrect})`);

        // Save updated game state to Redis after processing
        await this.setGameState(gameId, gameState);

        return {
          correct: isCorrect,
          correctAnswer: currentQuestion.correct_answer
        };

      } finally {
        // Always release the answer lock
        await queueService.releaseLock(answerLockKey);
        // Always release the main game lock
        await this.releaseLock(lockKey);
      }

    } catch (error) {
      console.error('❌ Error handling player answer:', error);
      // Simple error handling - no complex cleanup needed
      // Release the main game lock on error
      if (lockKey) {
        await this.releaseLock(lockKey);
      }
      throw error;
    }
  }

  // Wait for queue processing to complete with intelligent timeout
  async waitForQueueCompletion(gameId, questionNumber, expectedCount) {
    const maxWaitTime = 10000; // 10 seconds max wait
        let checkInterval = 200; // start at 200ms
    const startTime = Date.now();
    
    console.log(`⏰ Waiting for ${expectedCount} questions to be processed...`);
    
    while (Date.now() - startTime < maxWaitTime) {
      // Check Redis for completion markers
      const completionKey = `question_completed:${gameId}:${questionNumber}`;
      const completedCount = await queueService.redis?.get(completionKey) || 0;
      
      if (parseInt(completedCount) >= expectedCount) {
        console.log(`✅ All ${expectedCount} questions processed successfully`);
        return;
      }
          
          // Wait before next check using exponential backoff (cap at 1000ms)
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          checkInterval = Math.min(1000, Math.floor(checkInterval * 1.8));
    }
    
    console.log(`⚠️ Queue processing timeout - proceeding with timer (${expectedCount} questions expected)`);
  }

  // Send question to all alive players
  async sendQuestionToPlayers(gameId, question) {
    try {
      const gameState = await this.getGameState(gameId);
      if (!gameState) return;

      const options = [question.option_a, question.option_b, question.option_c, question.option_d];
      const questionNumber = gameState.currentQuestion + 1;

      for (const player of gameState.players) {
        if (player.status === 'alive') {
          await queueService.addMessage('send_question', {
            to: player.user.whatsapp_number,
            questionText: question.question_text,
            options,
            questionNumber,
            correctAnswer: question.correct_answer,
            gameId: gameId // Add gameId for deduplication
          });
        } else {
          // Send spectator update to eliminated players
          await queueService.addMessage('send_message', {
            to: player.user.whatsapp_number,
            message: `👀 Q${questionNumber}: ${question.question_text}\n\nYou're watching as a spectator.`,
            gameId: gameId,
            messageType: 'spectator'
          });
        }
      }

    } catch (error) {
      console.error('❌ Error sending question to players:', error);
    }
  }

  // Timer update function removed - no more timer notifications in chat

  // Handle question timeout - eliminate players who didn't answer
  async handleQuestionTimeout(gameId, questionIndex) {
    try {
      // No delay needed - Redis timestamps handle race conditions
      const gameState = await this.getGameState(gameId);
      if (!gameState) return;

      // Check if question has already been processed (moved to next question)
      if (gameState.currentQuestion > questionIndex) {
        console.log(`⏰ Question ${questionIndex + 1} already processed, skipping timeout`);
        return;
      }

      const { players, questions } = gameState;
      const question = questions[questionIndex];
      
      console.log(`⏰ Question ${questionIndex + 1} timeout - processing eliminations at ${new Date().toISOString()}`);

      // Check if question has already been processed (moved to next question)
      if (gameState.currentQuestion > questionIndex) {
        console.log(`⏰ Question ${questionIndex + 1} already processed, skipping timeout`);
        return;
      }

      // Check if all alive players have been processed (either answered or eliminated)
      const alivePlayersForTimeout = players.filter(p => p.status === 'alive');
      const processedPlayers = alivePlayersForTimeout.filter(p => p.resultProcessed || p.status === 'eliminated');
      
      if (processedPlayers.length === alivePlayersForTimeout.length && alivePlayersForTimeout.length > 0) {
        console.log(`🔄 All ${alivePlayersForTimeout.length} alive players have been processed for Q${questionIndex + 1}, skipping timeout elimination`);
        return;
      }


      // Find players who didn't answer (these should be eliminated by timeout)
      const playersWithoutAnswers = players.filter(p => p.status === 'alive' && (!p.answer || p.answer.trim() === ''));
      const playersWithAnswers = players.filter(p => p.status === 'alive' && p.answer);
      
      // Always process timeout eliminations - no early exit
      console.log(`⏰ Processing timeout eliminations for Q${questionIndex + 1}`);

      console.log(`⏰ ${playersWithoutAnswers.length} players didn't answer Q${questionIndex + 1}, processing timeout eliminations`);

      // Eliminate players who didn't answer
      for (const player of players) {
        console.log(`🔍 Checking player ${player.user.nickname}: status=${player.status}, answer="${player.answer}"`);
        
        // Only eliminate if player is alive AND has NO answer (timeout)
        // Skip if player was already eliminated by late answer handler
        if (player.status === 'alive' && (!player.answer || player.answer.trim() === '')) {
          // Double-check player is still alive (prevent race condition with late answer handler)
          const freshGameState = await this.getGameState(gameId);
          const freshPlayer = freshGameState?.players?.find(p => p.user.whatsapp_number === player.user.whatsapp_number);
          
          if (!freshPlayer || freshPlayer.status !== 'alive') {
            console.log(`🔄 Player ${player.user.nickname} was already eliminated by another process, skipping timeout elimination`);
            continue;
          }
          
          // CRITICAL FIX: Double-check if player actually has an answer in the fresh state
          if (freshPlayer.answer && freshPlayer.answer.trim() !== '') {
            console.log(`🔄 Player ${player.user.nickname} has answer "${freshPlayer.answer}" in fresh state, skipping timeout elimination`);
            continue;
          }
          // Eliminate player for not answering
          player.status = 'eliminated';
          player.eliminatedAt = new Date();
          player.eliminatedOnQuestion = questionIndex + 1;
          player.eliminationReason = 'timeout';

          // Update database
          await GamePlayer.update(
            { 
              status: 'eliminated',
              eliminated_at: new Date(),
              eliminated_by_question: questionIndex + 1
            },
            { 
              where: { 
                game_id: gameId,
                user_id: player.user.id 
              } 
            }
          );

          console.log(`⏰ Player ${player.user.nickname} eliminated for timeout on Q${questionIndex + 1}`);

          // Check if elimination message was already sent
          const eliminationKey = `elimination_sent:${gameId}:${player.user.whatsapp_number}:${questionIndex + 1}`;
          const alreadySent = await queueService.redis?.get(eliminationKey);
          
          if (!alreadySent) {
            // Mark as sent with 5-minute expiration
            await queueService.redis?.setex(eliminationKey, 300, 'sent');
            
            // Send timeout elimination message
            await queueService.addMessage('send_message', {
              to: player.user.whatsapp_number,
              message: `⏰ Time's up! You didn't answer in time and have been eliminated.

❌ Eliminated on: Question ${questionIndex + 1}
🎮 Game: ${gameId.slice(0, 8)}...
⏰ You didn't respond within the time limit.

Stick around to watch the finish! Reply "PLAY" for the next game.`,
              gameId: gameId,
              messageType: 'timeout_elimination',
              questionIndex: questionIndex
            });
          } else {
            console.log(`🔄 Elimination message already sent to ${player.user.nickname}, skipping duplicate`);
          }
        }
      }

      // Save updated game state after timeout eliminations
      await this.setGameState(gameId, gameState);

      // Check if game should end after timeout eliminations
      const alivePlayersAfterTimeout = gameState.players.filter(p => p.status === 'alive');
      
      if (alivePlayersAfterTimeout.length === 0) {
        console.log(` All players eliminated on Q${questionIndex + 1} (timeout)`);
        await this.endGame(gameId);
        return;
      }

      if (questionIndex + 1 >= gameState.questions.length) {
        console.log(`🏁 Last question completed. ${alivePlayersAfterTimeout.length} survivors!`);
        await this.endGame(gameId);
        return;
      }

      // FIRST: Evaluate all answers after timer expires (timing validation)
      const answerManager = require('./answerManager');
      console.log(`🎯 [TIMER_EXPIRED] Evaluating all answers for Q${questionIndex + 1} after 14-second timer`);
      
      
      const evaluationResults = await answerManager.evaluateAnswersAfterTimer(
        gameId, 
        questionIndex, 
        question.correct_answer
      );
      
      console.log(`📊 [EVALUATION] Results: ${evaluationResults.onTimeAnswers} on-time, ${evaluationResults.lateAnswers} late, ${evaluationResults.correctAnswers} correct, ${evaluationResults.wrongAnswers} wrong`);
      
      // Process eliminations based on evaluation results
      await this.processEliminationsFromEvaluation(gameId, questionIndex, evaluationResults);
      
      // Batch save answers to database (async, non-blocking)
      answerManager.batchSaveAnswersToDatabase(gameId, questionIndex)
        .then(result => {
          console.log(`📊 Database batch save completed: ${result.successfulSaves}/${result.totalAnswers} answers saved`);
        })
        .catch(error => {
          console.error('❌ Error in batch database save:', error);
        });

      // Check if game should continue
      const alivePlayersAfterEvaluation = gameState.players.filter(p => p.status === 'alive');
      
      if (alivePlayersAfterEvaluation.length === 0) {
        console.log(` All players eliminated on Q${questionIndex + 1}`);
        await this.endGame(gameId);
        return;
      }

      if (questionIndex + 1 >= gameState.questions.length) {
        console.log(`🏁 Last question completed. ${alivePlayersAfterEvaluation.length} survivors!`);
        await this.endGame(gameId);
        return;
      }

      // Clear timer after evaluation is complete
      const timerKey = `${gameId}:${questionIndex}`;
      if (this.activeTimers && this.activeTimers.has(timerKey)) {
        const timers = this.activeTimers.get(timerKey);
        if (timers.questionTimer) clearTimeout(timers.questionTimer);
        if (timers.countdownTimers) {
          timers.countdownTimers.forEach(timer => clearTimeout(timer));
        }
        this.activeTimers.delete(timerKey);
        console.log(`✅ Cleared timers for Q${questionIndex + 1} after evaluation`);
      }

      // Wait for elimination messages to be sent before starting next question
      console.log(`⏭️  Continuing to next question. ${alivePlayersAfterEvaluation.length} players alive`);
      console.log(`⏰ Waiting 5 seconds for elimination messages to be delivered...`);
      setTimeout(() => {
        console.log(`🚀 Starting next question ${questionIndex + 2} for game ${gameId}`);
        this.startQuestion(gameId, questionIndex + 1);
      }, 5000); // Increased from 2 seconds to 5 seconds

    } catch (error) {
      console.error('❌ Error handling question timeout:', error);
    }
  }

  // Process eliminations based on evaluation results after timer expires
  async processEliminationsFromEvaluation(gameId, questionIndex, evaluationResults) {
    try {
      const gameState = await this.getGameState(gameId);
      if (!gameState) return;

      const { players } = gameState;
      
      // Collect all eliminations for batch processing
      const eliminationsToProcess = [];
      const messagesToSend = [];
      
      for (const [userId, result] of Object.entries(evaluationResults.playerResults)) {
        const player = players.find(p => p.user.id === userId);
        if (!player || player.status !== 'alive') continue;

        // Eliminate player if answer was late or wrong
        if (!result.isOnTime) {
          // Late answer elimination
          player.status = 'eliminated';
          player.eliminatedAt = new Date();
          player.eliminatedOnQuestion = questionIndex + 1;
          player.eliminationReason = 'late_answer';
          
          console.log(`⏰ Player ${player.user.nickname} eliminated for late answer (${result.timeSinceStart}ms > ${result.timeLimit}ms)`);
          
          // Collect for batch database update
          eliminationsToProcess.push({
            game_id: gameId,
            user_id: player.user.id,
            status: 'eliminated',
            eliminated_at: new Date(),
            eliminated_by_question: questionIndex + 1
          });
          
          // Collect message for batch sending
          messagesToSend.push({
            to: player.user.whatsapp_number,
            message: `⏰ Too late! You answered after the question timer ended and have been eliminated.

❌ Eliminated on: Question ${questionIndex + 1}
🎮 Game: ${gameId.slice(0, 8)}...
⏰ You responded after the timer ended.

Stick around to watch the finish! Reply "PLAY" for the next game.`,
            gameId: gameId,
            messageType: 'late_elimination',
            questionIndex: questionIndex
          });
          
        } else if (!result.isCorrect) {
          // Wrong answer elimination
          player.status = 'eliminated';
          player.eliminatedAt = new Date();
          player.eliminatedOnQuestion = questionIndex + 1;
          player.eliminationReason = 'wrong_answer';
          
          console.log(`❌ Player ${player.user.nickname} eliminated for wrong answer: "${result.answer}"`);
          
          // Collect for batch database update
          eliminationsToProcess.push({
            game_id: gameId,
            user_id: player.user.id,
            status: 'eliminated',
            eliminated_at: new Date(),
            eliminated_by_question: questionIndex + 1
          });
          
          // Collect message for batch sending
          messagesToSend.push({
            to: player.user.whatsapp_number,
            message: `❌ Wrong Answer: ${gameState.questions[questionIndex].correct_answer}

💀 You're out this game. Stick around to watch the finish!`,
            gameId: gameId,
            messageType: 'elimination',
            questionIndex: questionIndex
          });
          
        } else {
          // Correct answer - send success message
          console.log(`✅ Player ${player.user.nickname} answered correctly: "${result.answer}"`);
          
          // Collect message for batch sending
          messagesToSend.push({
            to: player.user.whatsapp_number,
            message: `✅ Correct Answer: ${gameState.questions[questionIndex].correct_answer}

🎉 You're still in!`,
            gameId: gameId,
            messageType: 'correct_answer',
            questionIndex: questionIndex
          });
        }
      }

      // Batch update database (single operation instead of 100+ individual updates)
      if (eliminationsToProcess.length > 0) {
        console.log(`📊 Batch updating ${eliminationsToProcess.length} eliminations in database`);
        await this.batchUpdateEliminations(eliminationsToProcess);
      }

      // Batch send messages (non-blocking)
      if (messagesToSend.length > 0) {
        console.log(`📤 Batch sending ${messagesToSend.length} messages`);
        this.batchSendMessages(messagesToSend);
      }

      // Save updated game state
      await this.setGameState(gameId, gameState);
      
    } catch (error) {
      console.error('❌ Error processing eliminations from evaluation:', error);
    }
  }

  // Handle player elimination due to 24-hour window expiration
  async handlePlayerElimination(gameId, phoneNumber, reason = '24h_window_expired') {
    try {
      console.log(`⏰ Handling player elimination for ${phoneNumber} in game ${gameId}, reason: ${reason}`);
      
      const gameState = await this.getGameState(gameId);
      if (!gameState) {
        console.log(`❌ Game ${gameId} not found in active games`);
        return;
      }

      const player = gameState.players.find(p => p.user.whatsapp_number === phoneNumber);
      if (!player || player.status !== 'alive') {
        console.log(`❌ Player ${phoneNumber} not found or not alive in game ${gameId}`);
        return;
      }

      // Mark player as eliminated
      player.status = 'eliminated';
      player.eliminatedAt = new Date();
      player.eliminatedOnQuestion = gameState.currentQuestion + 1;
      player.eliminationReason = reason;
      
      // Update database
      await GamePlayer.update(
        { 
          status: 'eliminated',
          eliminated_at: new Date(),
          eliminated_by_question: gameState.currentQuestion + 1
        },
        { 
          where: { 
            game_id: gameId,
            user_id: player.user.id 
          } 
        }
      );

      console.log(`❌ Player ${player.user.nickname} eliminated due to ${reason} on Q${gameState.currentQuestion + 1}`);

      // Save updated game state after elimination
      await this.setGameState(gameId, gameState);

      // Check if game should end (all players eliminated)
      const alivePlayers = gameState.players.filter(p => p.status === 'alive');
      
      if (alivePlayers.length === 0) {
        console.log(` All players eliminated, ending game ${gameId}`);
        await this.endGame(gameId);
        return;
      }

      // If this was during a question, check if all remaining players have answered
      if (gameState.currentQuestion < gameState.questions.length) {
        const currentQuestion = gameState.questions[gameState.currentQuestion];
        const answeredPlayers = alivePlayers.filter(p => p.answer);
        
        if (answeredPlayers.length === alivePlayers.length) {
          console.log(`🎯 All remaining players answered, processing results immediately`);
          setTimeout(() => {
            this.sendQuestionResults(gameId, gameState.currentQuestion, currentQuestion.correct_answer);
          }, 2000);
        }
      }

    } catch (error) {
      console.error('❌ Error handling player elimination:', error);
    }
  }

  // Process question results with Redis lock to prevent race conditions
  async processQuestionResultsWithLock(gameId, questionIndex, correctAnswer) {
    const lockKey = `result_processing:${gameId}:${questionIndex}`;
    
    try {
      console.log(`🔓 Processing question results for game ${gameId}, question ${questionIndex + 1}`);
      
      // Use Redis lock to prevent concurrent processing
      const lockAcquired = await this.acquireRedisLock(lockKey, 30);
      if (!lockAcquired) {
        console.log(`⚠️ [GAME_SERVICE] Could not acquire lock for result processing, another process is handling it`);
        return;
      }
      
      try {
        // Check if results already decided for this question
        const resultDecidedKey = `result_decided:${gameId}:${questionIndex}`;
        console.log(`🔑 [GAME_SERVICE] Checking result decided key: ${resultDecidedKey}`);
        
        const resultsAlreadyDecided = await queueService.redis?.get(resultDecidedKey);
        console.log(`🔍 [GAME_SERVICE] Results already decided: ${resultsAlreadyDecided}`);
        
        if (resultsAlreadyDecided) {
          console.log(`⚠️ [GAME_SERVICE] Results already decided for game ${gameId}, question ${questionIndex + 1}, skipping duplicate processing`);
          return;
        }
        
        // Mark results as decided with 5-minute expiration
        await queueService.redis?.setex(resultDecidedKey, 300, 'decided');
        console.log(`✅ [GAME_SERVICE] Marked results as decided for game ${gameId}, question ${questionIndex + 1}`);
        
        // Process the results
        console.log(`🚀 [GAME_SERVICE] Calling sendQuestionResults for Q${questionIndex + 1}`);
        await this.sendQuestionResults(gameId, questionIndex, correctAnswer);
        
      } finally {
        // Always release the lock
        await this.releaseRedisLock(lockKey);
      }
      
    } catch (error) {
      console.error('❌ Error in processQuestionResultsWithLock:', error);
      // Ensure lock is released even on error
      await this.releaseRedisLock(lockKey);
    }
  }

  // Send question results and handle eliminations
  async sendQuestionResults(gameId, questionIndex, correctAnswer) {
    try {
      const gameState = await this.getGameState(gameId);
      if (!gameState) {
        console.log(`❌ Game state not found for ${gameId} during results processing`);
        return;
      }

      const { players, questions } = gameState;
      
      // Check if results have already been processed for this specific question
      // Only check alive players for the current question to avoid false positives from previous questions
      const alivePlayersForCheck = players.filter(p => p.status === 'alive');
      const hasProcessedResults = alivePlayersForCheck.some(p => p.resultProcessed);
      
      if (hasProcessedResults) {
        console.log(`🔄 Question ${questionIndex + 1} results already processed for alive players, skipping duplicate processing`);
        console.log(`🔍 Alive players with resultProcessed: ${alivePlayersForCheck.filter(p => p.resultProcessed).map(p => p.user.nickname).join(', ')}`);
        return;
      }
      const question = questions[questionIndex];
      
      console.log(`📊 Processing results for Q${questionIndex + 1}: ${correctAnswer}`);

      // Process each player's answer
      for (const player of players) {
        if (player.status !== 'alive') continue;
        
        // Skip if result already processed for this player
        if (player.resultProcessed) {
          console.log(`🔄 Skipping result processing for ${player.user.nickname} - already processed`);
          continue;
        }

        // Only process players who have answers
        if (!player.answer || player.answer.trim() === '') {
          console.log(`⏳ Player ${player.user.nickname} has no answer, skipping result processing (will be handled by timeout)`);
          continue;
        }

        console.log(`🔍 Processing player ${player.user.nickname}: answer="${player.answer}", correctAnswer="${correctAnswer}"`);
        
        // Improved answer comparison with better normalization
        const normalizedPlayerAnswer = player.answer ? player.answer.toLowerCase().trim().replace(/[^\w\s]/g, '') : '';
        const normalizedCorrectAnswer = correctAnswer ? correctAnswer.toLowerCase().trim().replace(/[^\w\s]/g, '') : '';
        const isCorrect = normalizedPlayerAnswer === normalizedCorrectAnswer;
        
        console.log(`🔍 Player ${player.user.nickname} answer comparison: "${normalizedPlayerAnswer}" === "${normalizedCorrectAnswer}" = ${isCorrect}`);
        
        if (!isCorrect) {
          // Eliminate player
          player.status = 'eliminated';
          player.eliminatedAt = new Date();
          player.eliminatedOnQuestion = questionIndex + 1;
          player.eliminationReason = 'wrong_answer';
          
          // Update database
          await GamePlayer.update(
            { 
              status: 'eliminated',
              eliminated_at: new Date(),
              eliminated_by_question: questionIndex + 1
            },
            { 
              where: { 
                game_id: gameId,
                user_id: player.user.id 
              } 
            }
          );

          console.log(`❌ Player ${player.user.nickname} eliminated on Q${questionIndex + 1} (wrong answer)`);
        }

        // Mark result as processed ONLY for players who answered
        player.resultProcessed = true;

        // Send result message with consolidated deduplication
        const resultMessage = isCorrect ? 
          `✅ Correct Answer: ${correctAnswer}\n\n🎉 You're still in!` :
          `❌ Correct Answer: ${correctAnswer}\n\n💀 You're out this game. Stick around to watch the finish!`;
        
        console.log(`📤 [GAME_SERVICE] Sending result message to ${player.user.nickname}:`);
        console.log(`📤 [GAME_SERVICE] - Message: "${resultMessage}"`);
        console.log(`📤 [GAME_SERVICE] - GameId: ${gameId}`);
        console.log(`📤 [GAME_SERVICE] - QuestionIndex: ${questionIndex}`);
        console.log(`📤 [GAME_SERVICE] - MessageType: elimination`);
        
        await queueService.addMessage('send_message', {
          to: player.user.whatsapp_number,
          message: resultMessage,
          gameId: gameId,
          messageType: 'elimination',
          questionIndex: questionIndex // Add question index for better deduplication
        });
      }

      // Save updated game state after processing all players
      await this.setGameState(gameId, gameState);

      // Check if game should end (all players eliminated or last question)
      const alivePlayersAfterProcessing = players.filter(p => p.status === 'alive');
      
      if (alivePlayersAfterProcessing.length === 0) {
        console.log(` All players eliminated on Q${questionIndex + 1}`);
        await this.endGame(gameId);
        return;
      }

      if (questionIndex + 1 >= questions.length) {
        console.log(`🏁 Last question completed. ${alivePlayersAfterProcessing.length} survivors!`);
        await this.endGame(gameId);
        return;
      }

      // Continue to next question
      console.log(`⏭️  Continuing to next question. ${alivePlayersAfterProcessing.length} players alive`);
      setTimeout(() => {
        console.log(`🚀 Starting next question ${questionIndex + 2} for game ${gameId}`);
        this.startQuestion(gameId, questionIndex + 1);
      }, 2000); // Reduced delay to 2 seconds for faster progression

    } catch (error) {
      console.error('❌ Error sending question results:', error);
    }
  }

  // Force end game (admin emergency function)
  async forceEndGame(gameId) {
    try {
      console.log(`🚨 FORCE ENDING GAME: ${gameId} (Admin Emergency)`);
      
      const gameState = await this.getGameState(gameId);
      if (!gameState) {
        console.log(`⚠️ Game state not found for: ${gameId}, checking database...`);
        
        // If no active game state, just update database status
        const game = await Game.findByPk(gameId);
        if (game && game.status === 'in_progress') {
          await game.update({ status: 'finished' });
          console.log(`✅ Database updated: Game ${gameId} marked as finished`);
          return { 
            message: 'Game ended (no active state found)', 
            winners: [], 
            winnerCount: 0 
          };
        }
        
        throw new Error('Game not found or not in progress');
      }

      // Immediately stop all timers and clear game state
      if (gameState.questionTimer) {
        clearInterval(gameState.questionTimer);
        gameState.questionTimer = null;
        console.log(`⏰ Emergency: Cleared question timer for game ${gameId}`);
      }
      
      if (gameState.activeTimers) {
        if (gameState.activeTimers instanceof Set) {
          gameState.activeTimers.clear();
        } else if (typeof gameState.activeTimers === 'object') {
          gameState.activeTimers = new Set();
        }
        console.log(`⏰ Emergency: Cleared all active timers for game ${gameId}`);
      }

      // Send emergency game end message to all alive players first
      const queueService = require('./queueService');
      const alivePlayers = gameState.players.filter(p => p.status === 'alive');
      
      for (const player of alivePlayers) {
        await queueService.addMessage('send_message', {
          to: player.user.whatsapp_number,
          message: `🚨 GAME ENDED BY ADMIN\n\n❌ This game has been terminated by the administrator.\n\n💰 Prize pool: $${gameState.prizePool || 100}\n🎮 Game: ${gameId.slice(0, 8)}...\n\nReply "PLAY" for the next game.`,
          gameId: gameId,
          messageType: 'emergency_end'
        });
      }

      // Mark all players as eliminated to stop any further processing
      for (const player of gameState.players) {
        if (player.status === 'alive') {
          player.status = 'eliminated';
          player.eliminatedAt = new Date();
          player.eliminatedOnQuestion = gameState.currentQuestion + 1;
          player.eliminationReason = 'admin_emergency_end';
        }
      }

      // Clear deduplication keys and cancel pending jobs
      await queueService.cancelGameJobs(gameId);
      await queueService.clearGameDeduplication(gameId);
      
      // Remove from active games and Redis
      this.activeGames.delete(gameId);
      if (this.redisGameState.isAvailable()) {
        await this.redisGameState.deleteGameState(gameId);
        console.log(`🧹 Emergency: Game state removed from Redis for: ${gameId}`);
      }
      console.log(`🧹 Emergency: Game state removed for: ${gameId}`);

      // Update database status
      const game = await Game.findByPk(gameId);
      if (game) {
        await game.update({ status: 'finished' });
            console.log(`✅ Database updated: Game ${gameId} marked as finished`);
          }

          console.log(`🚨 FORCE END COMPLETE: Game ${gameId} terminated by admin`);
          
          return { 
            message: 'Game force ended by admin', 
            winners: alivePlayers.map(p => p.user.nickname), 
            winnerCount: alivePlayers.length 
          };

    } catch (error) {
      console.error('❌ Error force ending game:', error);
      throw error;
    }
  }


  // Sync player statuses from Redis to database
  async syncPlayerStatusesToDatabase(gameId, gameState) {
    try {
      const { GamePlayer } = require('../models');
      
      console.log(`🔄 Syncing ${gameState.players.length} player statuses to database...`);
      
      for (const player of gameState.players) {
        try {
          await GamePlayer.update(
            { 
              status: player.status,
              eliminated_at: player.eliminatedAt || null,
              eliminated_by_question: player.eliminatedOnQuestion || null
            },
            { 
              where: { 
                game_id: gameId, 
                user_id: player.user.id 
              } 
            }
          );
          console.log(`✅ Updated ${player.user.nickname}: ${player.status}`);
        } catch (error) {
          console.error(`❌ Error updating ${player.user.nickname}:`, error);
        }
      }
      
      console.log(`✅ Player statuses synced to database`);
    } catch (error) {
      console.error('❌ Error syncing player statuses to database:', error);
    }
  }

  // End game
  async endGame(gameId) {
    try {
      console.log(`🏁 Ending game: ${gameId}`);
      
      const gameState = await this.getGameState(gameId);
      if (!gameState) {
        console.error(`❌ Game state not found for: ${gameId}`);
        return;
      }

      // Clean up timers and game state
      console.log(`🧹 Cleaning up timers and game state for: ${gameId}`);
      
      // Clear any active timers
      if (gameState.questionTimer) {
        clearInterval(gameState.questionTimer);
        console.log(`⏰ Cleared question timer for game ${gameId}`);
      }
      
      // Clear active timers set (handle both Set and object from Redis)
      if (gameState.activeTimers) {
        if (gameState.activeTimers instanceof Set) {
          gameState.activeTimers.clear();
        } else if (typeof gameState.activeTimers === 'object') {
          // Convert back to Set if it was serialized from Redis
          gameState.activeTimers = new Set();
        }
        console.log(`⏰ Cleared active timers set for game ${gameId}`);
      }
      
      // Clear deduplication keys and cancel pending jobs for this game
      const queueService = require('./queueService');
      await queueService.cancelGameJobs(gameId);
      await queueService.clearGameDeduplication(gameId);
      
      // Remove from Redis
      if (this.redisGameState.isAvailable()) {
        await this.redisGameState.deleteGameState(gameId);
        console.log(`🧹 Game state removed from Redis for: ${gameId}`);
      }
      
      // Remove from in-memory
      this.activeGames.delete(gameId);
      console.log(`🧹 Game state cleaned up for: ${gameId}`);

      // Update database with final player statuses from Redis before processing rewards
      console.log(`🔄 Syncing final player statuses to database before processing rewards...`);
      await this.syncPlayerStatusesToDatabase(gameId, gameState);
      
      // Process rewards using reward service
      console.log(`🏆 About to process rewards for game: ${gameId}`);
      const gameResults = await rewardService.processGameRewards(gameId);
      
      console.log(`🏆 Game ${gameId} ended successfully:`, {
        winnerCount: gameResults.winnerCount,
        status: gameResults.gameStatus,
        prizeDistribution: gameResults.prizeDistribution
      });

      return gameResults;

    } catch (error) {
      console.error('❌ Error ending game:', error);
      throw error;
    }
  }

  // Send game start message
  async sendGameStartMessage(gameId) {
    try {
      const gameState = await this.getGameState(gameId);
      if (!gameState) return;

      for (const player of gameState.players) {
        await queueService.addMessage('send_message', {
          to: player.user.whatsapp_number,
          message: `🎮 QRush Trivia is starting!\n\nGet ready for sudden-death questions!\n\nFirst question in 30 seconds...`
        });
      }

    } catch (error) {
      console.error('❌ Error sending game start message:', error);
    }
  }

  // Get active game for a player
  async getActiveGameForPlayer(phoneNumber) {
    // First check Redis for active games
    if (this.redisGameState.isAvailable()) {
      try {
        const activeGameIds = await this.redisGameState.getActiveGameIds();
        
        for (const gameId of activeGameIds) {
          const gameState = await this.getGameState(gameId);
          if (gameState && gameState.players) {
            const player = gameState.players.find(p => p.user.whatsapp_number === phoneNumber);
            if (player) {
              return { gameId, gameState, player };
            }
          }
        }
      } catch (error) {
        console.error('❌ Error checking Redis for active games:', error);
      }
    }
    
    // Fallback to in-memory games
    for (const [gameId, gameState] of this.activeGames) {
      const player = gameState.players.find(p => p.user.whatsapp_number === phoneNumber);
      if (player) {
        return { gameId, gameState, player };
      }
    }
    
    return null;
  }




  // Note: Expired game notification logic removed - using frontend validation instead

  // Cleanup all timers (for graceful shutdown)
  cleanupAllTimers() {
    console.log('🧹 Cleaning up all game timers...');
    
    if (this.activeTimers) {
      this.activeTimers.forEach((timers, timerKey) => {
        if (timers.questionTimer) clearTimeout(timers.questionTimer);
        if (timers.countdownTimers) {
          timers.countdownTimers.forEach(timer => clearTimeout(timer));
        }
        console.log(`✅ Cleared timers for ${timerKey}`);
      });
      this.activeTimers.clear();
    }
    
    console.log('✅ All timers cleaned up');
  }

  // Redis lock helper methods
  async acquireLock(lockKey, ttl = 30) {
    if (!this.redisGameState.isAvailable()) {
      return true; // No Redis, allow operation
    }

    try {
      const result = await this.redisGameState.redis.set(lockKey, 'locked', 'EX', ttl, 'NX');
      return result === 'OK';
    } catch (error) {
      console.error('❌ Error acquiring Redis lock:', error);
      return false;
    }
  }

  async releaseLock(lockKey) {
    if (!this.redisGameState.isAvailable()) {
      return true; // No Redis, allow operation
    }

    try {
      await this.redisGameState.redis.del(lockKey);
      return true;
    } catch (error) {
      console.error('❌ Error releasing Redis lock:', error);
      return false;
    }
  }

  // Safe Redis scan to replace dangerous keys() command
  async safeRedisScan(pattern) {
    try {
      const keys = [];
      let cursor = '0';
      
      do {
        const result = await queueService.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = result[0];
        keys.push(...result[1]);
      } while (cursor !== '0');
      
      return keys;
    } catch (error) {
      console.error('❌ Error scanning Redis keys:', error);
      return [];
    }
  }

  async acquireRedisLock(lockKey, ttl = 30) {
    return this.acquireLock(lockKey, ttl);
  }

  // Batch update eliminations in database (single operation for 100+ users)
  async batchUpdateEliminations(eliminations) {
    try {
      if (eliminations.length === 0) return;
      
      console.log(`📊 Batch updating ${eliminations.length} eliminations in database`);
      
      // Use bulk update with CASE statements for better performance
      const userIds = eliminations.map(e => e.user_id);
      const gameIds = eliminations.map(e => e.game_id);
      
      // Update all eliminations in a single query
      await GamePlayer.update(
        { 
          status: 'eliminated',
          eliminated_at: new Date(),
          eliminated_by_question: eliminations[0].eliminated_by_question
        },
        { 
          where: { 
            game_id: eliminations[0].game_id,
            user_id: userIds
          } 
        }
      );
      
      console.log(`✅ Batch updated ${eliminations.length} eliminations in database`);
    } catch (error) {
      console.error('❌ Error in batch elimination update:', error);
    }
  }

  // Batch send messages (non-blocking for high concurrency)
  async batchSendMessages(messages) {
    try {
      if (messages.length === 0) return;
      
      console.log(`📤 Batch sending ${messages.length} messages`);
      
      // Send all messages in parallel (non-blocking)
      const messagePromises = messages.map(messageData => 
        queueService.addMessage('send_message', messageData)
      );
      
      // Don't wait for all to complete - let them process in background
      Promise.all(messagePromises).then(results => {
        const successCount = results.filter(r => r !== null).length;
        console.log(`📤 Batch message sending completed: ${successCount}/${messages.length} queued`);
      }).catch(error => {
        console.error('❌ Error in batch message sending:', error);
      });
      
    } catch (error) {
      console.error('❌ Error in batch message sending:', error);
    }
  }

  async releaseRedisLock(lockKey) {
    return this.releaseLock(lockKey);
  }


}

module.exports = new GameService();

