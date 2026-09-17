import { startBot } from './src/lib/bot';
startBot();
const port = process.env.PORT || 3000;
Bun.serve({
  port: Number(port),
  fetch() { return new Response('Bot running'); }
});
console.log('Server running on port ' + port);
