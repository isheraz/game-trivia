/**
 * Worker Manager - simple reusable worker pool
 * Replaces spawn-per-task approach with a small pool per worker type.
 * Provides methods: processAnswers, processGameState, processMessageBatch, formatMessage, calculatePrizeDistribution, cleanup
 */

const { Worker } = require('worker_threads');
const path = require('path');

class WorkerPool {
  constructor(workerType, poolSize = 2) {
    this.workerType = workerType;
    this.poolSize = poolSize;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.nextWorkerId = 0;

    for (let i = 0; i < poolSize; i++) {
      this._createWorker();
    }
  }

  _createWorker() {
    const workerPath = path.join(__dirname, '..', 'workers', `${this.workerType}.js`);
    const worker = new Worker(workerPath);
    const id = `${this.workerType}_${++this.nextWorkerId}`;

    const entry = { id, worker, busy: false };
    this.workers.push(entry);
    this.idle.push(entry);

    // Ensure worker errors are handled and worker is replaced
    worker.on('error', (err) => {
      console.error(`Worker ${id} error:`, err);
      this._removeWorker(id);
      this._createWorker();
    });

    worker.on('exit', (code) => {
      if (code !== 0) console.error(`Worker ${id} exited with code ${code}`);
      this._removeWorker(id);
      // Replace worker to keep pool size
      this._createWorker();
    });
  }

  _removeWorker(id) {
    this.workers = this.workers.filter(w => w.id !== id);
    this.idle = this.idle.filter(w => w.id !== id);
  }

  async runTask(message) {
    return new Promise((resolve, reject) => {
      const task = { message, resolve, reject };
      const workerEntry = this.idle.shift();
      if (workerEntry) {
        this._runOnWorker(workerEntry, task);
      } else {
        // enqueue
        this.queue.push(task);
      }
    });
  }

  _runOnWorker(entry, task) {
    entry.busy = true;
    const { worker } = entry;
    const onMessage = (result) => {
      cleanup();
      if (result && result.success) task.resolve(result.result);
      else task.reject(result && result.error ? new Error(result.error.message) : new Error('Worker error'));
    };
    const onError = (err) => {
      cleanup();
      task.reject(err);
    };
    const onExit = (code) => {
      cleanup();
      if (code !== 0) task.reject(new Error(`Worker exited with code ${code}`));
    };

    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      entry.busy = false;
      // return to idle list
      this.idle.push(entry);
      // process next queued task if any
      const next = this.queue.shift();
      if (next) {
        const e = this.idle.shift();
        if (e) this._runOnWorker(e, next);
        else this.queue.unshift(next); // requeue
      }
    };

    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);

    try {
      worker.postMessage(task.message);
    } catch (err) {
      cleanup();
      task.reject(err);
    }
  }

  // Terminate all workers
  async destroy() {
    const promises = this.workers.map(e => e.worker.terminate().catch(() => {}));
    await Promise.all(promises);
    this.workers = [];
    this.idle = [];
    this.queue = [];
  }
}

class WorkerManager {
  constructor() {
    // pool sizes can be tuned via env vars
    this.pools = {
      'answer-processor': new WorkerPool('answer-processor', parseInt(process.env.ANSWER_WORKER_POOL || '2', 10)),
      'message-processor': new WorkerPool('message-processor', parseInt(process.env.MESSAGE_WORKER_POOL || '1', 10)),
      'game-state-processor': new WorkerPool('game-state-processor', parseInt(process.env.GAMESTATE_WORKER_POOL || '1', 10))
    };
    console.log('\u2705 Worker Manager pool initialized');
  }

  async processAnswers(gameId, questionIndex, answers, correctAnswer, timeLimit = 10000) {
    const message = { type: 'process_answers', data: { gameId, questionIndex, answers, correctAnswer, timeLimit } };
    return this.pools['answer-processor'].runTask(message);
  }

  async processGameState(gameState, answerResults) {
    const message = { type: 'process_game_state', data: { gameState, answerResults } };
    return this.pools['game-state-processor'].runTask(message);
  }

  async processMessageBatch(messages) {
    const message = { type: 'process_message_batch', data: { messages } };
    return this.pools['message-processor'].runTask(message);
  }

  async formatMessage(messageObj) {
    const message = { type: 'format_message', data: { message: messageObj } };
    return this.pools['message-processor'].runTask(message);
  }

  async calculatePrizeDistribution(winners, totalPrize) {
    const message = { type: 'calculate_prizes', data: { winners, totalPrize } };
    return this.pools['answer-processor'].runTask(message);
  }

  getStats() {
    return Object.fromEntries(Object.entries(this.pools).map(([k, p]) => [k, { workers: p.workers.length, idle: p.idle.length, queue: p.queue.length }]));
  }

  async cleanup() {
    const destroys = Object.values(this.pools).map(p => p.destroy());
    await Promise.all(destroys);
    console.log('\u2705 Worker Manager pools destroyed');
  }
}

module.exports = new WorkerManager();
