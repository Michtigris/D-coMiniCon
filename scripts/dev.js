const { spawn } = require('child_process');
const http = require('http');

const server = spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' });

function waitForServer() {
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get('http://127.0.0.1:3847/health', (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else setTimeout(tick, 200);
      });
      req.on('error', () => setTimeout(tick, 200));
    };
    tick();
  });
}

function shutdown(code) {
  server.kill();
  process.exit(code);
}

waitForServer().then(() => {
  const electron = require('electron');
  const child = spawn(electron, ['.'], { stdio: 'inherit' });
  child.on('exit', (code) => shutdown(code || 0));
});

process.on('SIGINT', () => shutdown(0));
server.on('exit', (code) => {
  if (code) process.exit(code);
});
