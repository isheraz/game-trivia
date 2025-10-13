const { whatsappConfig } = require('../config/whatsapp');
const { User } = require('../models');
const devConfig = require('../config/development');
const logger = require('../utils/logger');

class WhatsAppService {
  constructor() {
    this.client = whatsappConfig.client;
    this.phoneNumberId = whatsappConfig.phoneNumberId;
    this.isDevelopment = process.env.NODE_ENV === 'development';
    this.testPhoneNumbers = devConfig.development.testPhoneNumbers || [];
  }

  // Send text message with rate limiting
  async sendTextMessage(to, text) {
    try {
      // Development mode safety check
      if (this.isDevelopment) {
        if (devConfig.development.disableWhatsAppMessaging) {
          console.log(`🔒 [DEV MODE] Message blocked to ${to}: ${text}`);
          return { message: 'blocked_in_development' };
        }
        
        if (devConfig.development.logMessagesOnly) {
          console.log(`📝 [DEV MODE] Would send to ${to}: ${text}`);
          return { message: 'logged_in_development' };
        }
        
        // Only allow test phone numbers in development - DISABLED
        // if (!this.testPhoneNumbers.includes(to)) {
        //   console.log(`🚫 [DEV MODE] Phone number ${to} not in test list. Message blocked.`);
        //   return { message: 'blocked_not_test_number' };
        // }
      }

      // CRITICAL FIX: Rate limiting to prevent Meta API throttling
      await this.rateLimitForUser(to);

      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      });
      
      // Only log message ID for successful sends
      logger.info(`✅ Message sent: ${response.data.messages?.[0]?.id || 'unknown'}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error sending text message:', error.response?.data || error.message);
      
      // Handle rate limiting errors specifically
      if (error.response?.status === 429) {
        console.log(`⏰ Rate limited for ${to}, waiting before retry...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Retry once after rate limit
        return this.sendTextMessage(to, text);
      }
      
      throw error;
    }
  }

  // Rate limiting per user to prevent API throttling
  async rateLimitForUser(to) {
    if (!this.userLastMessage) {
      this.userLastMessage = new Map();
    }

    const lastMessageTime = this.userLastMessage.get(to);
    const now = Date.now();
    
    if (lastMessageTime) {
      const timeSinceLastMessage = now - lastMessageTime;
      const minInterval = 500; // 500ms minimum between messages to same user
      
      if (timeSinceLastMessage < minInterval) {
        const waitTime = minInterval - timeSinceLastMessage;
        console.log(`⏰ Rate limiting: waiting ${waitTime}ms before sending to ${to}`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    this.userLastMessage.set(to, now);
  }


  // Send interactive message with buttons
  async sendInteractiveMessage(to, body, buttons) {
    try {
      console.log(`🎯 sendInteractiveMessage called: to=${to}, body="${body}", buttons:`, buttons);
      
      // Development mode safety check
      if (this.isDevelopment) {
        if (devConfig.development.disableWhatsAppMessaging) {
          console.log(`🔒 [DEV MODE] Interactive message blocked to ${to}: ${body}`);
          return { message: 'blocked_in_development' };
        }
        
        if (devConfig.development.logMessagesOnly) {
          console.log(`📝 [DEV MODE] Would send interactive to ${to}: ${body} with buttons:`, buttons);
          return { message: 'logged_in_development' };
        }
        
        // Only allow test phone numbers in development - DISABLED
        // if (!this.testPhoneNumbers.includes(to)) {
        //   console.log(`🚫 [DEV MODE] Phone number ${to} not in test list. Interactive message blocked.`);
        //   return { message: 'blocked_not_test_number' };
        // }
      }

      console.log(`📤 Making WhatsApp API call to ${to} with body: "${body}"`);
      
      const response = await this.client.post(`/${this.phoneNumberId}/messages`, {
        messaging_product: 'whatsapp',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.map((button, index) => ({
              type: 'reply',
              reply: {
                id: `btn_${index + 1}`,
                title: button
              }
            }))
          }
        }
      });
      
      console.log('✅ Interactive message sent successfully:', response.data);
      return response.data;
    } catch (error) {
      console.error('❌ Error sending interactive message:', error.response?.data || error.message);
      throw error;
    }
  }

  // Send question with randomized answer buttons
  async sendQuestion(to, questionText, options, questionNumber, correctAnswer) {
    try {
      console.log(`🎯 sendQuestion called: to=${to}, questionNumber=${questionNumber}, questionText="${questionText}"`);
      console.log(`🎯 Options:`, options);
      console.log(`🎯 Correct answer:`, correctAnswer);
      
      // Ensure correct answer is always included in the 3 buttons
      const threeOptions = [correctAnswer];
      const otherOptions = options.filter(opt => opt !== correctAnswer);
      
      // Add 2 more random options from the remaining options
      for (let i = 0; i < 2 && otherOptions.length > 0; i++) {
        const randomIndex = Math.floor(Math.random() * otherOptions.length);
        threeOptions.push(otherOptions.splice(randomIndex, 1)[0]);
      }
      
      // Randomize the order of the 3 options
      const randomizedOptions = threeOptions.sort(() => Math.random() - 0.5);

        const body = `Q${questionNumber}: ${questionText}\n\n⏰ 10 seconds left to answer`;
      console.log(`📤 Sending interactive message to ${to}:`, body);
      console.log(`📤 Buttons:`, randomizedOptions);
      
      const result = await this.sendInteractiveMessage(to, body, randomizedOptions);
      console.log(`✅ Question sent successfully to ${to}:`, result);
      return result;
    } catch (error) {
      console.error('❌ Error sending question:', error);
      throw error;
    }
  }

  // Send welcome message for new users
  async sendWelcomeMessage(to, prizePool, nextGameTime) {
    const message = `🎉 Welcome to QRush Trivia!

It's sudden-death: get every question right to stay in. One wrong or no answer = you're out.
⏰ Next game: ${nextGameTime}

Reply "PLAY" to get a reminder when we start!`;

    return await this.sendTextMessage(to, message);
  }

  // Send game reminder
  async sendGameReminder(to, gameTime, prizePool) {
    const message = `🎮 QRush Trivia starts soon!

⏰ Game begins at ${gameTime}
💰 Prize pool: $${prizePool}

Tap "JOIN" to get the start ping!`;

    return await this.sendInteractiveMessage(to, message, ['JOIN']);
  }


  // Send elimination message
  async sendEliminationMessage(to, correctAnswer, isCorrect) {
    let message;
    
    if (isCorrect) {
      message = `✅ Correct Answer: ${correctAnswer}\n\n🎉 You're still in!`;
    } else {
      message = `❌ Correct Answer: ${correctAnswer}\n\n💀 You're out this game. Stick around to watch the finish!`;
    }

    return await this.sendTextMessage(to, message);
  }

  // Send winner announcement
  async sendWinnerAnnouncement(to, winnerCount, prizePool, individualPrize) {
    let message;
    
    if (winnerCount === 1) {
      message = `🏆 Game over — we have a winner!\n\n💰 Prize: $${prizePool}\n\nWinner will be contacted directly for prize delivery.\n\nThanks for playing QRush Trivia!`;
    } else {
      message = `🏆 Game over!\n\nMultiple winners this time — nice!\n👥 Winners: ${winnerCount}\n💰 Prize pool: $${prizePool}\n💵 Each winner receives: $${individualPrize}\n\nWinners will be DM'd directly for payout.`;
    }

    return await this.sendTextMessage(to, message);
  }

  // Send no game running message
  async sendNoGameMessage(to, nextGameTime, prizePool) {
    const message = `📱 There's no game running right now.\n\n⏰ Next QRush Trivia: ${nextGameTime}\n\nReply "PLAY" for a reminder.`;

    return await this.sendInteractiveMessage(to, message, ['PLAY']);
  }

  // Send mid-game join message
  async sendMidGameMessage(to, nextGameTime) {
    const message = `🚫 The game is in progress and you can't join mid-round.\n\n⏰ Next game: ${nextGameTime}\n\nReply "PLAY" to get a reminder before we start.`;

    return await this.sendInteractiveMessage(to, message, ['PLAY']);
  }

  // Send help message
  async sendHelpMessage(to, nextGameTime, prizePool) {
    const message = `❓ How QRush Trivia Works:

• Sudden-death: get every question right to stay in.
• 10s per question with countdown.
• Wrong or no answer = elimination.
• If multiple players survive the final question, the prize pool is split evenly.
• Winners are DM'd directly.

⏰ Next game: ${nextGameTime}

Reply "PLAY" for a reminder.`;

    return await this.sendInteractiveMessage(to, message, ['PLAY']);
  }

  // Send error message
  async sendErrorMessage(to, errorType) {
    let message;
    
    switch (errorType) {
      case 'timeout':
        message = '⏰ Sorry, time is up. Wait for the next question.';
        break;
      case 'multiple_taps':
        message = '🔒 Your first answer was locked in. Please wait until the next round.';
        break;
      case 'invalid_input':
        message = '❓ Please use these commands only:\n\n🎮 PLAY - Get reminder for next game\n📝 JOIN - Join current game\n❓ HELP - Show this message';
        break;
      default:
        message = '❌ Something went wrong. Please try again.';
    }

    return await this.sendTextMessage(to, message);
  }

  // Generate timer bar visualization
  // Timer bar function removed - no more timer notifications




  // Timer update function removed - no more timer notifications in chat



  // Send template message (for future use with approved templates)
  async sendTemplateMessage(to, templateName, parameters = {}) {
    try {
      console.log(`📤 Sending template message to ${to}: ${templateName}`);
      
      // For now, just send a text message since we don't have approved templates
      // In the future, this would use the WhatsApp Business API template message endpoint
      const message = `📱 Template: ${templateName}\n\nThis is a placeholder for template messages.`;
      return await this.sendTextMessage(to, message);
      
    } catch (error) {
      console.error('❌ Error sending template message:', error);
      throw error;
    }
  }

  // Verify webhook
  verifyWebhook(mode, token, challenge) {
    if (mode === 'subscribe' && token === whatsappConfig.verifyToken) {
      console.log('✅ Webhook verified');
      return challenge;
    }
    throw new Error('Webhook verification failed');
  }
}

module.exports = new WhatsAppService();
