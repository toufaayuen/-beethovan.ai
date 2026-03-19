/**
 * PM2 config for beethovan.ai
 * Run: pm2 start ecosystem.config.cjs
 * Or:  pm2 restart beethovan
 */
module.exports = {
  apps: [{
    name: 'beethovan',
    script: 'index.js',
    cwd: __dirname + '/server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '200M',
    env: { NODE_ENV: 'production' },
  }],
};
