import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import { MealPlanGenerator } from './meal-plan-generator.js';
import { BackgroundJob, MealPlanJobPayload, WorkerConfig } from './types.js';

export class JobProcessor {
  private supabase: SupabaseClient;
  private mealPlanGenerator: MealPlanGenerator;
  private config: WorkerConfig;
  private activeJobs: Map<string, Promise<void>> = new Map();
  private isShuttingDown = false;

  constructor(
    supabaseUrl: string,
    supabaseServiceKey: string,
    openaiApiKey: string,
    unsplashAccessKey: string | undefined,
    config: WorkerConfig
  ) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
    this.mealPlanGenerator = new MealPlanGenerator(
      openaiApiKey,
      supabaseUrl,
      supabaseServiceKey,
      unsplashAccessKey
    );
    this.config = config;

    // Setup graceful shutdown
    process.on('SIGINT', () => this.gracefulShutdown());
    process.on('SIGTERM', () => this.gracefulShutdown());
  }

  async start(): Promise<void> {
    logger.info('🚀 Job processor starting', { 
      workerId: this.config.workerId,
      maxConcurrentJobs: this.config.maxConcurrentJobs,
      pollIntervalMs: this.config.pollIntervalMs
    });

    while (!this.isShuttingDown) {
      try {
        // Check if we can take more jobs
        if (this.activeJobs.size < this.config.maxConcurrentJobs) {
          const job = await this.getNextJob();
          
          if (job) {
            logger.info('📋 Processing new job', { 
              jobId: job.job_id,
              jobType: job.job_type,
              attempts: job.attempts,
              activeJobs: this.activeJobs.size 
            });

            // Process job asynchronously
            const jobPromise = this.processJob(job)
              .catch(error => {
                logger.error('Job processing failed', { 
                  jobId: job.job_id, 
                  error: error.message 
                });
              })
              .finally(() => {
                // Remove from active jobs when done
                this.activeJobs.delete(job.job_id);
              });

            this.activeJobs.set(job.job_id, jobPromise);
          }
        }

        // Clean up completed promises
        const completedJobs = Array.from(this.activeJobs.entries()).filter(
          ([_, promise]) => promise === undefined
        );
        completedJobs.forEach(([jobId]) => this.activeJobs.delete(jobId));

        // Wait before next poll
        await this.sleep(this.config.pollIntervalMs);

      } catch (error) {
        const err = error as Error;
        logger.error('Error in main polling loop', { error: err.message });
        await this.sleep(5000); // Wait 5 seconds on error
      }
    }

    logger.info('Job processor stopped');
  }

  private async getNextJob(): Promise<BackgroundJob | null> {
    try {
      const { data, error } = await this.supabase.rpc('get_next_background_job', {
        p_job_types: ['meal_plan_generation'],
        p_worker_id: this.config.workerId
      });

      if (error) {
        logger.error('Error getting next job', { error });
        return null;
      }

      if (!data || data.length === 0) {
        return null;
      }

      return data[0] as BackgroundJob;
    } catch (error) {
      const err = error as Error;
      logger.error('Exception getting next job', { error: err.message });
      return null;
    }
  }

  private async processJob(job: BackgroundJob): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Update heartbeat initially
      await this.updateHeartbeat(job.job_id);

      if (job.job_type === 'meal_plan_generation') {
        await this.processMealPlanJob(job);
      } else {
        throw new Error(`Unknown job type: ${job.job_type}`);
      }

      const duration = Date.now() - startTime;
      logger.info('✅ Job completed successfully', { 
        jobId: job.job_id,
        jobType: job.job_type,
        durationMs: duration 
      });

    } catch (error) {
      const err = error as Error;
      const duration = Date.now() - startTime;
      logger.error('❌ Job failed', { 
        jobId: job.job_id,
        jobType: job.job_type,
        error: err.message,
        durationMs: duration 
      });

      await this.markJobFailed(job.job_id, err.message);
    }
  }

  private async processMealPlanJob(job: BackgroundJob): Promise<void> {
    const payload = job.payload as MealPlanJobPayload;
    
    logger.info('🍽️ Processing meal plan generation', { 
      jobId: job.job_id,
      userId: payload.userId,
      planId: payload.planId,
      mealsPerDay: payload.userPreferences.mealsPerDay 
    });

    // Periodic heartbeat during long operation
    const heartbeatInterval = setInterval(async () => {
      await this.updateHeartbeat(job.job_id);
    }, 30000); // Every 30 seconds

    try {
      // Generate the meal plan
      const mealPlanResult = await this.mealPlanGenerator.generateMealPlan(
        payload.userId,
        payload.userPreferences,
        payload.planId
      );

      // Assemble final plan data
      const planData = {
        raw_ai_response: mealPlanResult,
        diet_plan_overview: mealPlanResult.overview || {},
        diet_plan_recommendations: mealPlanResult.recommendations || {},
        diet_plan_guidelines: mealPlanResult.guidelines || [],
        diet_cards: mealPlanResult.diet_cards || [],
        plan_type: 'diet_plan_v2',
        days: mealPlanResult.days || [],
        shopping_list: mealPlanResult.shopping_list || []
      };

      // Update meal plan in database
      const { error: saveError } = await this.supabase
        .from('meal_plans')
        .update({
          plan_data: planData,
          status: 'completed',
          updated_at: new Date().toISOString()
        })
        .eq('id', payload.planId)
        .eq('user_id', payload.userId);

      if (saveError) {
        throw new Error(`Failed to save meal plan: ${saveError.message}`);
      }

      // Send completion notification
      await this.sendMealPlanNotification(payload.userId, payload.planId);

      // Mark job as completed
      await this.markJobCompleted(job.job_id, { 
        planId: payload.planId,
        completedAt: new Date().toISOString() 
      });

      logger.info('✅ Meal plan generation completed and saved', { 
        jobId: job.job_id,
        planId: payload.planId 
      });

    } finally {
      clearInterval(heartbeatInterval);
    }
  }

  private async updateHeartbeat(jobId: string): Promise<void> {
    try {
      await this.supabase.rpc('update_job_heartbeat', {
        p_job_id: jobId,
        p_worker_id: this.config.workerId
      });
    } catch (error) {
      const err = error as Error;
      logger.warn('Failed to update heartbeat', { jobId, error: err.message });
    }
  }

  private async markJobCompleted(jobId: string, result: any): Promise<void> {
    try {
      await this.supabase.rpc('complete_background_job', {
        p_job_id: jobId,
        p_worker_id: this.config.workerId,
        p_result: result,
        p_status: 'completed'
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to mark job as completed', { jobId, error: err.message });
    }
  }

  private async markJobFailed(jobId: string, errorMessage: string): Promise<void> {
    try {
      await this.supabase.rpc('fail_background_job', {
        p_job_id: jobId,
        p_worker_id: this.config.workerId,
        p_error_message: errorMessage
      });
    } catch (error) {
      const err = error as Error;
      logger.error('Failed to mark job as failed', { jobId, error: err.message });
    }
  }

  private async sendMealPlanNotification(userId: string, planId: string): Promise<void> {
    try {
      const scheduledTime = new Date();
      const { error } = await this.supabase.rpc('schedule_notification', {
        user_id_param: userId,
        notification_type_param: 'immediate',
        title_param: '🍽️ Your meal plan is ready!',
        body_param: 'Your personalized nutrition plan has been generated. Check it out now!',
        scheduled_time_param: scheduledTime.toISOString(),
        timezone_param: 'GMT+00:00',
        data_param: {
          type: 'meal_plan_ready',
          planId: planId,
          timestamp: scheduledTime.toISOString()
        }
      });

      if (error) {
        logger.warn('Failed to schedule meal plan notification', { userId, planId, error });
      } else {
        logger.info('📱 Meal plan notification scheduled', { userId, planId });
      }
    } catch (error) {
      const err = error as Error;
      logger.warn('Exception sending meal plan notification', { userId, planId, error: err.message });
    }
  }

  private async gracefulShutdown(): Promise<void> {
    logger.info('🛑 Graceful shutdown initiated...');
    this.isShuttingDown = true;

    // Wait for active jobs to complete (with timeout)
    const shutdownTimeout = 300000; // 5 minutes
    const startTime = Date.now();

    while (this.activeJobs.size > 0 && (Date.now() - startTime) < shutdownTimeout) {
      logger.info(`⏳ Waiting for ${this.activeJobs.size} active jobs to complete...`);
      await this.sleep(5000);
    }

    if (this.activeJobs.size > 0) {
      logger.warn(`⚠️ Shutdown timeout reached. ${this.activeJobs.size} jobs may be interrupted.`);
    }

    logger.info('✅ Graceful shutdown completed');
    process.exit(0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}