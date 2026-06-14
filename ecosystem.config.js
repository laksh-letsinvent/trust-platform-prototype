module.exports = {
  apps: [
    {
      name: 'trust-platform',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
    },
    {
      name: 'trust-traffic',
      script: 'scripts/traffic-daemon.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      // Not auto-started — operator runs: pm2 start ecosystem.config.js --only trust-traffic
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
        ENABLE_ATTACKS: 'true',
        TRAFFIC_DAEMON_API_KEY: 'sk-trust-daemon-internal',
      },
    },
  ],
};
