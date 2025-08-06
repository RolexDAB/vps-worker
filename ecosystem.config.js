module.exports = {
  apps: [
    {
      name: 'meal-plan-worker',
      script: './dist/index.js',
      instances: 1, // Single instance to avoid job conflicts
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true,
      // Restart policy
      min_uptime: '10s',
      max_restarts: 10,
      // Cron restart (optional - restart every day at 2 AM)
      cron_restart: '0 2 * * *',
      // Health check
      health_check_http: false,
      // Advanced PM2 features
      listen_timeout: 3000,
      kill_timeout: 5000,
      // Environment-specific settings
      env_production: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        MAX_CONCURRENT_JOBS: '3',
        POLL_INTERVAL_MS: '1000'
      },
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
        MAX_CONCURRENT_JOBS: '1',
        POLL_INTERVAL_MS: '2000'
      }
    }
  ],

  deploy: {
    production: {
      user: 'mealworker',
      host: ['your-vps-ip-here'],
      ref: 'origin/main',
      repo: 'your-repo-here',
      path: '/opt/meal-plan-worker',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production'
    }
  }
};