/**
 * Message Batcher for High-Volume WhatsApp Messages
 * Batches messages to reduce API calls and improve performance
 */

class MessageBatcher {
  constructor() {
    this.batches = new Map(); // batchId -> { messages: [], timer: null }
    this.batchSize = 100; // Maximum messages per batch
    this.batchTimeout = 1000; // 1 second timeout for faster processing
    this.pendingMessages = [];
    
    console.log('✅ Message Batcher initialized');
  }

  /**
   * Add a message to the batch queue with per-user ordering
   * @param {string} to - Recipient phone number
   * @param {string} message - Message content
   * @param {string} priority - Message priority (high, normal, low)
   * @param {Object} data - Additional data including sequence number
   * @returns {Promise} - Resolves when message is processed
   */
  async addMessage(to, message, priority = 'normal', data = {}) {
    return new Promise((resolve, reject) => {
      const messageData = {
        to,
        message,
        priority,
        timestamp: Date.now(),
        resolve,
        reject,
        _seq: data._seq, // Pass through sequence number for ordering
        gameId: data.gameId,
        messageType: data.messageType,
        questionIndex: data.questionIndex
      };

      // CRITICAL FIX: Maintain per-user message ordering
      // Instead of global batching, use per-user queues
      this.addToUserQueue(to, messageData);

      // Check if we should process a batch
      this.checkAndProcessBatch();
    });
  }

  /**
   * Add message to per-user queue to maintain ordering
   * @param {string} to - Recipient phone number
   * @param {Object} messageData - Message data
   */
  addToUserQueue(to, messageData) {
    if (!this.userQueues) {
      this.userQueues = new Map();
    }

    if (!this.userQueues.has(to)) {
      this.userQueues.set(to, []);
    }

    // Add to user's specific queue (maintains FIFO order)
    this.userQueues.get(to).push(messageData);

    // Also add to global pending for batch processing
    this.pendingMessages.push(messageData);
  }

  /**
   * Check if we should process a batch and do so if conditions are met
   */
  checkAndProcessBatch() {
    // Process batch if we have enough messages or high priority messages
    const highPriorityCount = this.pendingMessages.filter(m => m.priority === 'high').length;
    
    if (this.pendingMessages.length >= this.batchSize || highPriorityCount > 0) {
      this.processBatch();
    } else if (this.pendingMessages.length > 0) {
      // Set timeout for remaining messages
      this.setBatchTimeout();
    }
  }

  /**
   * Set a timeout to process remaining messages
   */
  setBatchTimeout() {
    // Clear existing timeout
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Set new timeout
    this.batchTimer = setTimeout(() => {
      if (this.pendingMessages.length > 0) {
        this.processBatch();
      }
    }, this.batchTimeout);
  }

  /**
   * Process a batch of messages
   */
  async processBatch() {
    if (this.pendingMessages.length === 0) return;

    // Clear timeout
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Take messages for this batch
    const batchMessages = this.pendingMessages.splice(0, this.batchSize);
    
    // Silent batch processing - only log errors

    try {
      // Group messages by recipient for efficiency
      const messagesByRecipient = this.groupMessagesByRecipient(batchMessages);
      
      // Process each recipient's messages
      for (const [recipient, messages] of messagesByRecipient) {
        await this.sendBatchedMessages(recipient, messages);
      }

      // Resolve all promises
      batchMessages.forEach(msg => msg.resolve());

    } catch (error) {
      console.error('❌ Error processing message batch:', error);
      
      // Reject all promises
      batchMessages.forEach(msg => msg.reject(error));
    }
  }

  /**
   * Group messages by recipient
   * @param {Array} messages - Array of message objects
   * @returns {Map} - Map of recipient -> messages array
   */
  groupMessagesByRecipient(messages) {
    const grouped = new Map();
    
    messages.forEach(msg => {
      if (!grouped.has(msg.to)) {
        grouped.set(msg.to, []);
      }
      grouped.get(msg.to).push(msg);
    });

    return grouped;
  }

  /**
   * Send batched messages to a single recipient
   * @param {string} recipient - Phone number
   * @param {Array} messages - Array of messages for this recipient
   */
  async sendBatchedMessages(recipient, messages) {
    try {
      // If only one message, send it directly with sequence data
      if (messages.length === 1) {
        await this.sendSingleMessage(recipient, messages[0].message, messages[0]);
        return;
      }

      // Combine multiple messages into one
      const combinedMessage = this.combineMessages(messages);
      // Use the first message's sequence data for the combined message
      await this.sendSingleMessage(recipient, combinedMessage, messages[0]);

    } catch (error) {
      console.error(`❌ Error sending batched messages to ${recipient}:`, error);
      throw error;
    }
  }

  /**
   * Combine multiple messages into one
   * @param {Array} messages - Array of message objects
   * @returns {string} - Combined message
   */
  combineMessages(messages) {
    // Sort by timestamp to maintain order
    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    
    // Combine with separators
    return sortedMessages.map(msg => msg.message).join('\n\n---\n\n');
  }

  /**
   * Send a single message directly to WhatsApp with sequence ordering
   * @param {string} to - Recipient
   * @param {string} message - Message content
   * @param {Object} messageData - Original message data with sequence info
   */
  async sendSingleMessage(to, message, messageData = {}) {
    try {
      console.log(`📤 [MESSAGE_BATCHER] Sending message to ${to}`);
      
      // Import WhatsApp service and send the message directly
      const whatsappService = require('./whatsappService');
      const result = await whatsappService.sendTextMessage(to, message);
      
      console.log(`✅ [MESSAGE_BATCHER] Message sent to ${to}, result:`, result);
      return result;
    } catch (error) {
      console.error(`❌ Failed to send message to ${to}:`, error.message);
      throw error;
    }
  }

  /**
   * Get current batch statistics
   * @returns {Object} - Batch statistics
   */
  getStats() {
    return {
      pendingMessages: this.pendingMessages.length,
      batchSize: this.batchSize,
      batchTimeout: this.batchTimeout,
      highPriorityMessages: this.pendingMessages.filter(m => m.priority === 'high').length
    };
  }

  /**
   * Force process all pending messages
   */
  async flush() {
    if (this.pendingMessages.length > 0) {
      console.log('🔄 Flushing all pending messages...');
      await this.processBatch();
    }
  }

  /**
   * Update batch configuration
   * @param {Object} config - New configuration
   */
  updateConfig(config) {
    if (config.batchSize) {
      this.batchSize = config.batchSize;
    }
    if (config.batchTimeout) {
      this.batchTimeout = config.batchTimeout;
    }
    console.log('⚙️ Message Batcher configuration updated:', config);
  }
}

module.exports = MessageBatcher;
