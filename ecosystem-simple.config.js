module.exports = {
  apps: [
    {
      name: 'weather-migration',
      script: 'src/scripts/migrate-old-data.js',
      args: 'migrate weather_reports',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        NODE_NO_WARNINGS: '1'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true
    }
  ]
};
