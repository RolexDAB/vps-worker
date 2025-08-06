import dotenv from 'dotenv';
import { logger } from './logger.js';
import { JobProcessor } from './job-processor.js';
import { WorkerConfig } from './types.js';

// Load environment variables
dotenv.config();

function validateEnvironment(): void {
  const required = [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY', 
    'OPENAI_API_KEY'
  ];

  const missing = required.filter(env => !process.env[env]);
  
  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    process.exit(1);
  }

  if (!process.env.UNSPLASH_ACCESS_KEY) {
    logger.warn('UNSPLASH_ACCESS_KEY not set. Meal images will use fallbacks.');
  }
}

function getWorkerConfig(): WorkerConfig {
  return {
    workerId: process.env.WORKER_ID || `meal-plan-worker-${Date.now()}`,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '1000'),
    maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '3'),
    logLevel: process.env.LOG_LEVEL || 'info'
  };
}

async function main(): Promise<void> {
  try {
    logger.info('🚀 Starting Meal Plan Worker');
    
    validateEnvironment();
    const config = getWorkerConfig();
    
    logger.info('⚙️ Worker configuration', config);

    const processor = new JobProcessor(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      process.env.OPENAI_API_KEY!,
      process.env.UNSPLASH_ACCESS_KEY,
      config
    );

    await processor.start();

  } catch (error) {
    const err = error as Error;
    logger.error('💥 Worker failed to start', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// Handle unhandled errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at Promise', { reason, promise });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Start the worker
main().catch(error => {
  const err = error as Error;
  logger.error('Main function failed', { error: err.message });
  process.exit(1);
});