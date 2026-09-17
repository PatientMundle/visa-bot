module.exports = {
  apps: [
    {
      name: "visa-sniper-bot",
      script: "server.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1500M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      error_file: "./logs/pm2-err.log",
      out_file: "./logs/pm2-out.log",
      time: true,
    },
  ],
};
