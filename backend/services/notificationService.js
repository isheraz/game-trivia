const { Game, GamePlayer, User } = require('../models');
const queueService = require('./queueService');

class NotificationService {
  constructor() {
    this.reminderIntervals = new Map(); // Track reminder intervals
  }

  // Schedule game reminders
  async scheduleGameReminders(gameId) {
    try {
      const game = await Game.findByPk(gameId);
      if (!game) {
        throw new Error('Game not found');
      }

      const startTime = new Date(game.start_time);
      const now = new Date();
      const timeUntilStart = startTime.getTime() - now.getTime();

      // Clear any existing reminders for this game
      this.clearGameReminders(gameId);

      // Schedule 5-minute reminder
      const fiveMinReminder = timeUntilStart - (5 * 60 * 1000);
      if (fiveMinReminder > 0) {
        setTimeout(() => {
          this.sendFiveMinuteReminder(gameId);
        }, fiveMinReminder);
      }

      // Schedule 30-minute reminder
      const thirtyMinReminder = timeUntilStart - (30 * 60 * 1000);
      if (thirtyMinReminder > 0) {
        setTimeout(() => {
          this.sendThirtyMinuteReminder(gameId);
        }, thirtyMinReminder);
      }

      console.log(`⏰ Scheduled reminders for game ${gameId}`);

    } catch (error) {
      console.error('❌ Error scheduling game reminders:', error);
    }
  }

  // Send 30-minute reminder
//   async sendThirtyMinuteReminder(gameId) {
//     try {
//       const game = await Game.findByPk(gameId);
//       const players = await GamePlayer.findAll({
//         where: { game_id: gameId },
//         include: [{ model: User, as: 'user' }]
//       });

//       for (const player of players) {
//         await queueService.addMessage('send_message', {
//           to: player.user.whatsapp_number,
//           message: `⏰ QRush Trivia Reminder!

// Game starts in 30 minutes!

// 💰 Prize pool: $${game.prize_pool}
// ⏰ Start time: ${new Date(game.start_time).toLocaleString()} EST

// Get ready for sudden-death questions!`
//         });
//       }

//       console.log(`📱 Sent 30-minute reminder to ${players.length} players for game ${gameId}`);

//     } catch (error) {
//       console.error('❌ Error sending 30-minute reminder:', error);
//     }
//   }

  // Send 5-minute reminder
//   async sendFiveMinuteReminder(gameId) {
//     try {
//       const game = await Game.findByPk(gameId);
//       const players = await GamePlayer.findAll({
//         where: { game_id: gameId },
//         include: [{ model: User, as: 'user' }]
//       });

//       for (const player of players) {
//         await queueService.addMessage('send_message', {
//           to: player.user.whatsapp_number,
//           message: `💰 Prize pool: $${game.prize_pool}
// ⏰ Start time: ${new Date(game.start_time).toLocaleString()} EST

// We will send you a reminder when the game starts.`
//         });
//       }

//       console.log(`📱 Sent 5-minute reminder to ${players.length} players for game ${gameId}`);

//     } catch (error) {
//       console.error('❌ Error sending 5-minute reminder:', error);
//     }
//   }

  // Send game announcement to all users
  async sendGameAnnouncement(gameId) {
    try {
      const game = await Game.findByPk(gameId);
      const users = await User.findAll({ where: { is_active: true } });

      for (const user of users) {
        await queueService.addMessage('send_message', {
          to: user.whatsapp_number,
          message: `🎮 QRush Trivia Game Alert!

A new game is starting in 30 minutes!

💰 Prize Pool: $${game.prize_pool}
⏰ Start Time: ${new Date(game.start_time).toLocaleString()}

Reply "JOIN" to register for this game!`
        });
      }

      console.log(`📢 Sent game announcement to ${users.length} users for game ${gameId}`);

    } catch (error) {
      console.error('❌ Error sending game announcement:', error);
    }
  }

  // Clear reminders for a game
  clearGameReminders(gameId) {
    if (this.reminderIntervals.has(gameId)) {
      const intervals = this.reminderIntervals.get(gameId);
      intervals.forEach(clearTimeout);
      this.reminderIntervals.delete(gameId);
    }
  }

  // Send game start notification
  async sendGameStartNotification(gameId) {
    try {
      const players = await GamePlayer.findAll({
        where: { game_id: gameId },
        include: [{ model: User, as: 'user' }]
      });

      for (const player of players) {
        await queueService.addMessage('send_message', {
          to: player.user.whatsapp_number,
          message: `🎮 QRush Trivia is starting NOW!

Get ready for the first question in 5 seconds...`
        });
      }

      console.log(`🎮 Sent game start notification to ${players.length} players for game ${gameId}`);

    } catch (error) {
      console.error('❌ Error sending game start notification:', error);
    }
  }

  // Send winner notifications
  async sendWinnerNotifications(gameId, winners, prizePool, individualPrize) {
    try {
      for (const winner of winners) {
        await queueService.addMessage('send_message', {
          to: winner.whatsapp_number,
          message: `🏆 CONGRATULATIONS! You won QRush Trivia!

💰 Your prize: $${individualPrize}
🎉 You survived all questions!

We'll contact you directly for prize delivery.`
        });
      }

      console.log(`🏆 Sent winner notifications to ${winners.length} players for game ${gameId}`);

    } catch (error) {
      console.error('❌ Error sending winner notifications:', error);
    }
  }

  // Send game cancellation notification
  async sendGameCancellationNotification(gameId, reason = 'Game has been cancelled') {
    try {
      const players = await GamePlayer.findAll({
        where: { game_id: gameId },
        include: [{ model: User, as: 'user' }]
      });

      for (const player of players) {
        await queueService.addMessage('send_message', {
          to: player.user.whatsapp_number,
          message: `❌ QRush Trivia Game Cancelled

${reason}

We'll announce the next game soon!`
        });
      }

      console.log(`❌ Sent cancellation notification to ${players.length} players for game ${gameId}`);

    } catch (error) {
      console.error('❌ Error sending cancellation notification:', error);
    }
  }
}

module.exports = new NotificationService();
