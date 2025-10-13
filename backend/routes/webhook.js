const express = require('express');
const router = express.Router();
const Joi = require('joi');

const whatsappService = require('../services/whatsappService');
const queueService = require('../services/queueService');
const logger = require('../utils/logger');
const { User, Game, GamePlayer } = require('../models');

// Normalize phone number to E.164 format
function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return phoneNumber;
  
  // Remove any non-digit characters
  let cleaned = phoneNumber.replace(/\D/g, '');
  
  // Handle Pakistani numbers (starting with 0)
  if (cleaned.startsWith('0')) {
    cleaned = '92' + cleaned.substring(1);
  }
  
  // Handle Pakistani numbers without country code
  if (cleaned.length === 10 && cleaned.startsWith('3')) {
    cleaned = '92' + cleaned;
  }
  
  return cleaned;
}

// Webhook verification
router.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  
  try {
    const response = whatsappService.verifyWebhook(mode, token, challenge);
    res.status(200).send(response);
  } catch (error) {
    console.error('❌ Webhook verification failed:', error);
    res.status(403).send('Forbidden');
  }
});

// Message webhook - respond immediately to avoid Meta timeout
router.post('/', (req, res) => {
  console.log('📬 Incoming webhook at', new Date());
  
  // Respond immediately to avoid Meta timeout
  res.sendStatus(200);
  
  // Process webhook asynchronously
  setImmediate(async () => {
    try {
      await processWebhook(req.body);
    } catch (err) {
      console.error('❌ Webhook async error:', err);
    }
  });
});

// Process webhook asynchronously
async function processWebhook(body) {
  try {
    // Log webhook to monitoring system
    try {
      const adminModule = require('./admin');
      if (adminModule.addWebhookLog) {
        adminModule.addWebhookLog(body);
      }
    } catch (error) {
      console.error('❌ Error logging webhook:', error);
    }
    
    // Validate webhook structure
    const webhookSchema = Joi.object({
      object: Joi.string().valid('whatsapp_business_account').required(),
      entry: Joi.array().items(
        Joi.object({
          id: Joi.string().required(),
          changes: Joi.array().items(
            Joi.object({
              value: Joi.object({
                messaging_product: Joi.string().valid('whatsapp').required(),
                metadata: Joi.object({
                  display_phone_number: Joi.string().required(),
                  phone_number_id: Joi.string().required()
                }).required(),
                contacts: Joi.array().items(
                  Joi.object({
                    profile: Joi.object({
                      name: Joi.string().required()
                    }).required(),
                    wa_id: Joi.string().required()
                  })
                ).optional(),
                messages: Joi.array().items(
                  Joi.object({
                    from: Joi.string().required(),
                    id: Joi.string().required(),
                    timestamp: Joi.string().required(),
                    type: Joi.string().valid('text', 'interactive').required(),
                    context: Joi.object({
                      from: Joi.string().required(),
                      id: Joi.string().required()
                    }).optional(),
                    text: Joi.object({
                      body: Joi.string().required()
                    }).when('type', {
                      is: 'text',
                      then: Joi.required(),
                      otherwise: Joi.forbidden()
                    }),
                    interactive: Joi.object({
                      type: Joi.string().valid('button_reply').required(),
                      button_reply: Joi.object({
                        id: Joi.string().required(),
                        title: Joi.string().required()
                      }).required()
                    }).when('type', {
                      is: 'interactive',
                      then: Joi.required(),
                      otherwise: Joi.forbidden()
                    })
                  })
                ).optional(),
                statuses: Joi.array().items(
                  Joi.object({
                    id: Joi.string().required(),
                    status: Joi.string().valid('sent', 'delivered', 'read', 'failed').required(),
                    timestamp: Joi.string().required(),
                    recipient_id: Joi.string().required(),
                    conversation: Joi.object({
                      id: Joi.string().required(),
                      expiration_timestamp: Joi.string().optional(),
                      origin: Joi.object({
                        type: Joi.string().required()
                      }).required()
                    }).optional(),
                    pricing: Joi.object({
                      billable: Joi.boolean().required(),
                      pricing_model: Joi.string().required(),
                      category: Joi.string().required(),
                      type: Joi.string().required()
                    }).optional(),
                    errors: Joi.array().items(
                      Joi.object({
                        code: Joi.number().required(),
                        title: Joi.string().required(),
                        message: Joi.string().required(),
                        error_data: Joi.object({
                          details: Joi.string().required()
                        }).optional(),
                        href: Joi.string().optional()
                      })
                    ).optional()
                  })
                ).optional()
              }).required(),
              field: Joi.string().valid('messages', 'message_statuses').required()
            })
          ).required()
        })
      ).required()
    });

    const { error } = webhookSchema.validate(body);
    if (error) {
      console.error('❌ Webhook validation error:', error.details);
      return;
    }

    // Process each message
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (change.field === 'messages') {
          const value = change.value;
          
          // Handle messages
          if (value.messages && Array.isArray(value.messages)) {
            for (const message of value.messages) {
              await processMessage(message, value.contacts?.[0]);
            }
          }
          
          // Handle status updates (message read/delivered status) - silent processing
          if (value.statuses && Array.isArray(value.statuses)) {
            for (const status of value.statuses) {
              await handleMessageStatus(status);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
}

// Process individual message
async function processMessage(message, contact) {
  try {
    // Use wa_id from contact info (E.164 format) and normalize it
    const phoneNumber = normalizePhoneNumber(contact?.wa_id || message.from);
    const messageText = message.text?.body || '';
    const buttonResponse = message.interactive?.button_reply?.title || '';
    const finalMessage = messageText || buttonResponse;

    // Silent message processing - only log errors

    // Get or create user
    let user = await User.findByWhatsAppNumber(phoneNumber);
    
    if (!user) {
      // New user - start registration flow
      await handleNewUser(phoneNumber, messageText || buttonResponse, contact);
      return;
    }

    // Existing user - handle their message
    await handleExistingUser(user, messageText || buttonResponse, buttonResponse, phoneNumber);
    
  } catch (error) {
    console.error('❌ Error processing message:', error);
  }
}

// Handle new user registration
async function handleNewUser(phoneNumber, messageText, contact) {
  try {
    console.log('🆕 Creating new user for phone number:', phoneNumber);
    
    // Use WhatsApp display name if available, otherwise use phone number
    const displayName = contact?.profile?.name || `Player_${phoneNumber.slice(-4)}`;
    
    // Create user with WhatsApp display name and complete registration
    const user = await User.create({
      whatsapp_number: phoneNumber, // This is already normalized
      nickname: displayName,
      registration_completed: true // Registration complete with WhatsApp name
    });
    
    console.log('✅ User created:', user.id, 'with nickname:', displayName);

    // Send welcome message
    const nextGameTime = await getNextGameTime();
    const prizePool = process.env.DEFAULT_PRIZE_POOL || 100;
    
    // Send welcome message via queue system (same as existing users)
    try {
      console.log('📤 Attempting to queue welcome message for:', phoneNumber);
      const result = await queueService.addMessage('send_message', {
        to: phoneNumber, // Use normalized phone number
        message: `🎉 Welcome to QRush Trivia, ${displayName}!

It's sudden-death: get every question right to stay in. One wrong or no answer = you're out.
⏰ Next game: ${nextGameTime}

Reply "PLAY" to get a reminder when we start!`
      });
      console.log('✅ Welcome message queued for new user, result:', result);
    } catch (error) {
      console.error('❌ Error queuing welcome message:', error);
    }

  } catch (error) {
    console.error('❌ Error handling new user:', error);
  }
}

// Handle existing user messages
async function handleExistingUser(user, messageText, buttonResponse, wa_id) {
  try {
    // Check if user is in registration flow (legacy - no longer used)
    const session = await queueService.getSession(user.id);
    
    if (session && session.state === 'awaiting_nickname') {
      // Clear the session and continue with normal flow
      await queueService.deleteSession(user.id);
    }

    // Check if registration is not completed
    if (!user.registration_completed) {
      // User exists but registration is incomplete, complete it with default name
      user.registration_completed = true;
      await user.save();
      
      // Send welcome message
      const nextGameTime = await getNextGameTime();
      const prizePool = process.env.DEFAULT_PRIZE_POOL || 100;
      
      // Send welcome message via queue system
      try {
        await queueService.addMessage('send_message', {
          to: user.whatsapp_number, // Use stored phone number
          message: `🎉 Welcome to QRush Trivia, ${user.nickname}!

It's sudden-death: get every question right to stay in. One wrong or no answer = you're out.

⏰ Next game: ${nextGameTime} EST

Reply "PLAY" to get a reminder when we start!`
        });
        console.log('✅ Welcome message queued for existing user');
      } catch (error) {
        console.error('❌ Error queuing welcome message:', error);
      }
      return;
    }

    // Check if this is a new user's first message (they might have been created but not completed registration)
    if (user.nickname === `Player_${user.whatsapp_number.slice(-4)}`) {
      // This is a user with default nickname - check if they're sending a command
      const command = (messageText || buttonResponse || '').toUpperCase().trim();
      
      if (command && ['PLAY', 'JOIN', 'HELP'].includes(command)) {
        // User is sending a command, process it normally
        console.log(`📱 User with default nickname sending command: ${command}`);
        // Continue to command processing below
      } else {
        // This is a new user with default nickname, send welcome message
        const nextGameTime = await getNextGameTime();
        const prizePool = process.env.DEFAULT_PRIZE_POOL || 100;
        
        // Send welcome message via queue system
        try {
          await queueService.addMessage('send_message', {
            to: user.whatsapp_number, // Use stored phone number
            message: `🎉 Welcome to QRush Trivia, ${user.nickname}!

It's sudden-death: get every question right to stay in. One wrong or no answer = you're out.


⏰ Next game: ${nextGameTime}

Reply "PLAY" to get a reminder when we start!`
          });
          console.log('✅ Welcome message queued for new user with default nickname');
        } catch (error) {
          console.error('❌ Error queuing welcome message:', error);
        }
        return;
      }
    }

    // Handle regular game commands
    const command = (messageText || buttonResponse || '').toUpperCase().trim();
    
    switch (command) {
      case 'PLAY':
        await handlePlayCommand(user, wa_id);
        break;
      case 'JOIN':
        await handleJoinCommand(user);
        break;
      case 'HELP':
        await handleHelpCommand(user, wa_id);
        break;
      default:
        // Check if there's an active game before treating as answer
        const activeGame = await Game.getActiveGame();
        if (activeGame && activeGame.status === 'in_progress') {
          await handleGameAnswer(user, command);
        } else {
          // No active game, show command help message
          await queueService.addMessage('send_message', {
            to: user.whatsapp_number,
            message: '❓ Please use these commands only:\n\n🎮 PLAY - Get reminder for next game\n📝 JOIN - Join current game\n❓ HELP - Show this message'
          });
        }
        break;
    }

  } catch (error) {
    console.error('❌ Error handling existing user:', error);
  }
}

// Handle nickname registration (legacy - no longer used)
// async function handleNicknameRegistration(user, nickname) {
//   try {
//     // Clear registration session and continue with normal flow
//     await queueService.deleteSession(user.id);
    
//     // Send welcome message
//     const nextGameTime = await getNextGameTime();
//     const prizePool = process.env.DEFAULT_PRIZE_POOL || 100;
    
//     // Send welcome message via queue system
//     try {
//       await queueService.addMessage('send_message', {
//         to: user.whatsapp_number, // Use stored phone number
//         message: `🎉 Welcome to QRush Trivia, ${user.nickname}!

// It's sudden-death: get every question right to stay in. One wrong or no answer = you're out.


// ⏰ Next game: ${nextGameTime}

// Reply "PLAY" to get a reminder when we start!`
//       });
//       console.log('✅ Welcome message queued from legacy function');
//     } catch (error) {
//       console.error('❌ Error queuing welcome message:', error);
//     }

//   } catch (error) {
//     console.error('❌ Error handling nickname registration:', error);
//   }
// }

// Handle PLAY command
async function handlePlayCommand(user, wa_id) {
  try {
    const activeGame = await Game.getActiveGame();
    
    if (!activeGame) {
      // No game scheduled
      const nextGameTime = await getNextGameTime();
      const prizePool = process.env.DEFAULT_PRIZE_POOL || 100;
      
      await queueService.addMessage('send_message', {
        to: wa_id, // Use wa_id from webhook instead of stored phone number
        message: `📱 There's no game running right now.

⏰ Next QRush Trivia: ${nextGameTime} EST

Reply "PLAY" for a reminder.`
      });
      return;
    }

    if (activeGame.status === 'in_progress') {
      // Game in progress - can't join
      const nextGameTime = await getNextGameTime();
      
      await queueService.addMessage('send_message', {
        to: wa_id, // Use wa_id from webhook instead of stored phone number
        message: `🚫 The game is in progress and you can't join mid-round.

⏰ Next game: ${nextGameTime} EST

Reply "PLAY" to get a reminder before we start.`
      });
      return;
    }

    // Game scheduled - send reminder
    const gameTime = new Date(activeGame.start_time).toLocaleString();
    const prizePool = activeGame.prize_pool;
    
    await queueService.addMessage('send_message', {
      to: wa_id, // Use wa_id from webhook instead of stored phone number
      message: `🎮 QRush Trivia starts soon!

⏰ Game begins at ${gameTime} EST
💰 Prize pool: $${prizePool}

Tap "JOIN" to get the start ping!`
    });

  } catch (error) {
    console.error('❌ Error handling PLAY command:', error);
  }
}

// Handle JOIN command with race condition protection
async function handleJoinCommand(user) {
  try {
    const activeGame = await Game.getActiveGame();
    
    if (!activeGame) {
      await queueService.addMessage('send_message', {
        to: user.whatsapp_number,
        message: '❌ No game is currently accepting registrations. Stay tuned for the next game announcement!',
        priority: 'high',
        messageType: 'join_response'
      });
      return;
    }
    
    // Note: Expiration validation moved to frontend
    
    // Suppress JOIN confirmations during in-progress or just-ended games
    if (activeGame.status === 'in_progress') {
      console.log(`🚫 Suppressing JOIN confirmation for ${user.whatsapp_number} - game in progress`);
      return; // Silent suppression during active games
    }
    
    if (activeGame.status === 'finished') {
      console.log(`🚫 Suppressing JOIN confirmation for ${user.whatsapp_number} - game just ended`);
      return; // Silent suppression for recently ended games
    }
    
    if (activeGame.status !== 'pre_game') {
      await queueService.addMessage('send_message', {
        to: user.whatsapp_number,
        message: '❌ No game is currently accepting registrations. Stay tuned for the next game announcement!',
        priority: 'high',
        messageType: 'join_response'
      });
      return;
    }

    // Create registration lock key
    const registrationLockKey = `user_registration:${activeGame.id}:${user.id}`;
    
    // Acquire lock to prevent race condition
    const lockAcquired = await queueService.acquireLock(registrationLockKey, 10);
    if (!lockAcquired) {
      console.log(`🔒 Registration lock not acquired for user ${user.id}, skipping`);
      return;
    }

    try {
      // Check if user is already registered (double-check with lock)
      const existingPlayer = await GamePlayer.findOne({
        where: {
          game_id: activeGame.id,
          user_id: user.id
        }
      });

      if (existingPlayer) {
        await queueService.addMessage('send_message', {
          to: user.whatsapp_number,
          message: '✅ You\'re already registered for this game! We\'ll send you a reminder when it starts.'
        });
        return;
      }

      // Register user for the game (atomic operation)
      await GamePlayer.create({
        game_id: activeGame.id,
        user_id: user.id,
        status: 'registered'
      });
    } finally {
      // Always release the lock
      await queueService.releaseLock(registrationLockKey);
    }

    // Send confirmation
    const gameTime = new Date(activeGame.start_time).toLocaleString();
    const prizePool = activeGame.prize_pool;
    
    await queueService.addMessage('send_message', {
      to: user.whatsapp_number,
      message: `🎉 You're registered for QRush Trivia!

⏰ Game starts at: ${gameTime} EST
💰 Prize pool: $${prizePool}

We will send you a reminder when the game starts.`,
      priority: 'high',
      messageType: 'join_response'
    });

    console.log(`✅ User ${user.nickname} registered for game ${activeGame.id}`);

  } catch (error) {
    console.error('❌ Error handling JOIN command:', error);
    await queueService.addMessage('send_message', {
      to: user.whatsapp_number,
      message: '❌ Something went wrong. Please try again.',
      priority: 'high',
      messageType: 'join_response'
    });
  }
}

// Handle HELP command
async function handleHelpCommand(user, wa_id) {
  try {
    const nextGameTime = await getNextGameTime();
    const prizePool = process.env.DEFAULT_PRIZE_POOL || 100;
    
    await queueService.addMessage('send_message', {
      to: wa_id, // Use wa_id from webhook instead of stored phone number
      message: `❓ How QRush Trivia Works:

•⁠  ⁠Sudden-death: get every question right to stay in.
•⁠  ⁠10s per question with countdown.
•⁠  ⁠Wrong or no answer = elimination.
•⁠  ⁠If multiple players survive the final question, the prize pool is split evenly.
•⁠  ⁠Winners are DM'd directly.

📱 Commands:
•⁠  ⁠PLAY - Join next game
•⁠  ⁠HELP - Show this message

⏰ Next game: ${nextGameTime}

Reply "PLAY" for a reminder.`
    });

  } catch (error) {
    console.error('❌ Error handling HELP command:', error);
  }
}

// Handle game answer
async function handleGameAnswer(user, answer) {
  try {
    const gameService = require('../services/gameService');
    
    // Check if user is in an active game
    const activeGame = await gameService.getActiveGameForPlayer(user.whatsapp_number);
    
    if (!activeGame) {
      await queueService.addMessage('send_message', {
        to: user.whatsapp_number,
        message: '❓ No active game found. Use these commands:\n\n🎮 PLAY - Get reminder for next game\n📝 JOIN - Join current game\n❓ HELP - Show this message'
      });
      return;
    }

    // Handle the answer
    const result = await gameService.handlePlayerAnswer(activeGame.gameId, user.whatsapp_number, answer);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error handling game answer:', error);
    console.error('❌ [WEBHOOK] Error stack:', error.stack);
    await queueService.addMessage('send_message', {
      to: user.whatsapp_number,
      message: '❌ Something went wrong. Please try again.'
    });
  }
}

// Handle message status updates
async function handleMessageStatus(status) {
  try {
    // Only log failed messages, ignore sent/delivered/read
    if (status.status === 'failed' && status.errors) {
      for (const error of status.errors) {
        logger.error(`❌ Message failed: ${status.recipient_id} - ${error.message}`);
        
        // Handle 24-hour window restriction (error code 131047)
        if (error.code === 131047) {
          await handle24HourWindowExpired(status.recipient_id);
        }
        // Handle other message failures
        else {
          await handleMessageFailure(status.recipient_id, error);
        }
      }
    }
  } catch (error) {
    logger.error('❌ Error handling message status:', error);
  }
}

// Handle 24-hour window expiration
async function handle24HourWindowExpired(phoneNumber) {
  try {
    console.log(`⏰ Handling 24-hour window expiration for ${phoneNumber}`);
    
    // Get user
    const user = await User.findByWhatsAppNumber(phoneNumber);
    if (!user) {
      console.log(`❌ User not found for ${phoneNumber}`);
      return;
    }
    
    // Check if user is in an active game
    const gameService = require('../services/gameService');
    const activeGame = await gameService.getActiveGameForPlayer(phoneNumber);
    
    if (activeGame) {
      console.log(`🎮 User ${phoneNumber} is in active game ${activeGame.gameId}, handling 24h window expiration`);
      
      // Mark user as eliminated due to 24-hour window
      await gameService.handlePlayerElimination(activeGame.gameId, phoneNumber, '24h_window_expired');
      
      // Send re-engagement message when possible
      await sendReEngagementMessage(phoneNumber);
    } else {
      console.log(`📱 User ${phoneNumber} not in active game, sending re-engagement message`);
      await sendReEngagementMessage(phoneNumber);
    }
    
  } catch (error) {
    console.error('❌ Error handling 24-hour window expiration:', error);
  }
}

// Handle general message failures
async function handleMessageFailure(phoneNumber, error) {
  try {
    console.log(`❌ Handling message failure for ${phoneNumber}:`, error);
    
    // Log the failure for monitoring
    console.log(`📊 Message failure logged for ${phoneNumber} - Code: ${error.code}, Message: ${error.message}`);
    
    // For now, just log. In the future, you might want to implement retry logic
    // or notify administrators about message delivery issues
    
  } catch (error) {
    console.error('❌ Error handling message failure:', error);
  }
}

// Send re-engagement message
async function sendReEngagementMessage(phoneNumber) {
  try {
    console.log(`📱 Sending re-engagement message to ${phoneNumber}`);
    
    // Use WhatsApp Business API to send a template message
    // This requires a pre-approved template for re-engagement
    const whatsappService = require('../services/whatsappService');
    
    // For now, we'll use a simple message since we don't have a pre-approved template
    // In production, you should use a pre-approved template message
    const message = `Hi! It's been a while since we last chatted. 

🎮 QRush Trivia is back with exciting games!

Reply with "PLAY" to join our next trivia game and win cash prizes! 💰

We'll send you a reminder when the next game starts.`;

    // Note: This will fail due to 24-hour window, but it's good to have the logic ready
    // In production, you need to use a pre-approved template message
    console.log(`📱 Attempting to send re-engagement message to ${phoneNumber}`);
    console.log(`📱 Message: ${message}`);
    
    // TODO: Implement template message sending when you have a pre-approved template
    // await whatsappService.sendTemplateMessage(phoneNumber, 're_engagement_template', {});
    
  } catch (error) {
    console.error('❌ Error sending re-engagement message:', error);
  }
}


// Helper function to get next game time
async function getNextGameTime() {
  try {
    const scheduledGames = await Game.getScheduledGames();
    if (scheduledGames.length > 0) {
      return new Date(scheduledGames[0].start_time).toLocaleString();
    }
    return 'TBD - Stay tuned!';
  } catch (error) {
    console.error('❌ Error getting next game time:', error);
    return 'TBD - Stay tuned!';
  }
}

module.exports = router;



