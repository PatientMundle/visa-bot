import { startBot } from './src/lib/bot';`nstartBot();`nconst port = process.env.PORT || 3000;`nBun.serve({ port: Number(port), fetch() { return new Response('Bot running'); } });
