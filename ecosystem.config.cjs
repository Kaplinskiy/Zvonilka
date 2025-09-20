// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'call-signal',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: '3000' // Nginx будет проксировать /signal и /ws сюда
      }
    }
  ]
};