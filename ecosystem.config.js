module.exports = {
  apps: [
    {
      name: 'fieldcast-backend',
      cwd: '/root/FeildCast/backend/',
      script: 'dist/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
      error_file: '/var/log/fieldcast/backend-error.log',
      out_file:   '/var/log/fieldcast/backend-out.log',
    },
    {
      // Add this block
      name: 'mediamtx',
      script: '/usr/local/bin/mediamtx',
      args: '/etc/mediamtx.yml',
      interpreter: 'none',
      restart_delay: 3000,
      max_restarts: 10,
      error_file: '/var/log/fieldcast/mediamtx-error.log',
      out_file:   '/var/log/fieldcast/mediamtx-out.log',
    },
    {
      name: 'livekit-server',
      script: 'livekit-server',
      args: '--config /etc/livekit.yaml',
      interpreter: 'none',
      restart_delay: 3000,
      error_file: '/var/log/fieldcast/livekit-error.log',
      out_file:   '/var/log/fieldcast/livekit-out.log',
    },
  ],
};
