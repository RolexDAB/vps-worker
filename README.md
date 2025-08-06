# Meal Plan Worker

A background job processor for generating meal plans outside of Supabase Edge Function time limits.

## Architecture

- **Edge Function**: Creates background jobs and meal plan records
- **VPS Worker**: Processes jobs and updates meal plan data
- **Database**: Stores jobs and final meal plans

## Setup on Ubuntu 24.04 VPS

### 1. Initial Setup

```bash
# Run the setup script as root
sudo bash setup-vps.sh
```

### 2. Deploy Worker Code

```bash
# Switch to worker user
sudo su - mealworker

# Navigate to app directory
cd /opt/meal-plan-worker

# Copy your worker files here or clone from git
# git clone <your-repo> .

# Install dependencies
npm install

# Build the project
npm run build
```

### 3. Environment Configuration

Create `.env` file:

```bash
cp env.example .env
nano .env
```

Fill in your environment variables:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
OPENAI_API_KEY=your-openai-api-key
UNSPLASH_ACCESS_KEY=your-unsplash-access-key
WORKER_ID=meal-plan-worker-1
POLL_INTERVAL_MS=1000
MAX_CONCURRENT_JOBS=3
LOG_LEVEL=info
```

### 4. Start the Worker

```bash
# Start with PM2
pm2 start ecosystem.config.js --env production

# Check status
pm2 status

# View logs
pm2 logs meal-plan-worker

# Monitor
pm2 monit
```

### 5. Setup Auto-start

```bash
# Generate PM2 startup script
pm2 startup

# Save current PM2 processes
pm2 save
```

## Database Migration

Run the migration to create the background_jobs table:

```sql
-- Run this in your Supabase SQL editor
-- File: supabase/migrations/20240101000000_create_background_jobs.sql
```

## Monitoring

### Logs
- Application logs: `logs/combined.log`, `logs/error.log`
- PM2 logs: `logs/pm2-*.log`

### Health Checks
```bash
# Check if worker is running
pm2 status

# Check recent logs
pm2 logs --lines 50

# Check database for job status
# Query background_jobs table
```

### Key Metrics to Monitor
- Job processing time
- Error rates
- Memory usage
- Active job count

## Scaling

To increase capacity:

1. **Vertical Scaling**: Increase `MAX_CONCURRENT_JOBS`
2. **Horizontal Scaling**: Run multiple workers with different `WORKER_ID`s

## Troubleshooting

### Worker Not Processing Jobs
1. Check PM2 status: `pm2 status`
2. Check logs: `pm2 logs meal-plan-worker`
3. Verify database connectivity
4. Check environment variables

### High Memory Usage
1. Monitor with: `pm2 monit`
2. Restart worker: `pm2 restart meal-plan-worker`
3. Check for memory leaks in logs

### Job Failures
1. Check `background_jobs` table for error messages
2. Review application logs
3. Verify OpenAI API key and credits
4. Check Unsplash API limits

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build
npm run build

# Run built version
npm start
```

## Architecture Flow

1. **Client Request** → Edge Function
2. **Edge Function** → Creates meal_plan record + background_job
3. **VPS Worker** → Polls for jobs every second
4. **Worker** → Processes job (generates meal plan)
5. **Worker** → Updates meal_plan record with results
6. **Worker** → Marks job as completed
7. **Client** → Polls meal_plan record for completion

## Security Notes

- Use service role key only on VPS (not in client code)
- Restrict database access with RLS policies
- Keep API keys secure
- Use firewall to restrict VPS access
- Regular security updates