module.exports = {
  apps: [{
    name: "bot",
    cwd: "/root/bot",
    script: "src/index.js",
    interpreter: "node",
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000
  }]
};
