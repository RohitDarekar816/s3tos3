// PM2 process manager configuration.
// Usage:
//   pm2 start ecosystem.config.cjs --env production
//   pm2 save && pm2 startup   (auto-start on reboot)
//   pm2 logs s3-backup-studio
//   pm2 monit

module.exports = {
  apps: [
    {
      name: 's3-backup-studio',
      script: './server.js',
      instances: 1,          // Must be 1 — the sync engine is stateful (in-memory)
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 30000,   // Match shutdown() timeout in server.js

      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },

      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // PM2 log files (in addition to the app's own logs/ directory)
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/pm2-error.log',
      out_file:   './logs/pm2-out.log',
      merge_logs: true,
    },
  ],
};
