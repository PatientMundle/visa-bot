import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { VisaBot } from "./src/lib/bot.ts";
import { createServer } from "http";
import { Server } from "socket.io";
import { telegramService } from "./src/lib/telegram.ts";
import { getConfig, setConfig, saveVisaProfile, getActiveVisaProfiles, initializeDatabaseSchema } from "./src/db/configService.ts";
import { proxyService } from "./src/lib/proxyService.ts";
import { LockService } from "./src/lib/lockService.ts";
import { MaintenanceService } from "./src/lib/maintenanceService.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  const PORT = 3000;

  app.use(express.json());

  // Health check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Initialisation automatique des tables PostgreSQL & Scheduler de maintenance
  initializeDatabaseSchema().catch(err => {
    console.warn("[SERVER] Schema init non-bloquant:", err);
  });
  MaintenanceService.startScheduler();

  console.log("[SERVER] Initializing VisaBot...");
  const bot = new VisaBot(io);
  console.log("[SERVER] VisaBot initialized.");

  // API Routes
  app.get("/api/bot/status", (req, res) => {
    res.json(bot.getStatus());
  });

  app.post("/api/bot/start", async (req, res) => {
    const { 
      email, 
      password, 
      applicationIndex, 
      preferredDateStart, 
      preferredDateEnd, 
      checkInterval, 
      quality, 
      maxReloads,
      sniperMode 
    } = req.body;
    try {
      bot.start(
        email, 
        password, 
        applicationIndex, 
        preferredDateStart, 
        preferredDateEnd, 
        checkInterval, 
        quality, 
        maxReloads,
        sniperMode ?? true
      );
      res.json({ success: true, message: "Bot démarré en mode Sniper" });
    } catch (error: any) {
      res.status(500).json({ success: false, message: error.message });
    }
  });

  app.post("/api/bot/stop", async (req, res) => {
    await bot.stop();
    res.json({ success: true, message: "Bot stopped" });
  });

  app.get("/api/bot/logs", (req, res) => {
    res.json(bot.getLogs());
  });

  // Endpoints Human-in-the-Loop & Pilotage OTP
  app.get("/api/bot/intervention", (req, res) => {
    res.json({
      intervention: bot.getIntervention(),
      isAwaitingOtp: bot.isAwaitingOtp(),
    });
  });

  app.post("/api/bot/otp", async (req, res) => {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: "Code OTP manquant" });
    }
    const result = await bot.submitOtp(code);
    res.json(result);
  });

  app.post("/api/bot/resume", async (req, res) => {
    const result = await bot.resumeIntervention();
    res.json(result);
  });

  // Telegram test endpoint
  app.post("/api/telegram/test", async (req, res) => {
    try {
      const result = await telegramService.sendTestMessage();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // System Configuration endpoints (AES-256 in PostgreSQL)
  app.get("/api/config/:key", async (req, res) => {
    const value = await getConfig(req.params.key);
    // Mask sensitive tokens for security in UI responses
    const isMasked = req.query.masked === "true";
    if (isMasked && value && value.length > 8) {
      return res.json({ key: req.params.key, value: `${value.substring(0, 4)}...${value.slice(-4)}` });
    }
    res.json({ key: req.params.key, value });
  });

  app.post("/api/config", async (req, res) => {
    const { key, value, description } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: "Clé et valeur requises" });
    }
    const saved = await setConfig(key, value, description);
    res.json({ success: saved });
  });

  // Profiles endpoints
  app.get("/api/profiles", async (req, res) => {
    try {
      const profiles = await getActiveVisaProfiles();
      res.json({ success: true, profiles });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post("/api/profiles", async (req, res) => {
    try {
      const profile = await saveVisaProfile(req.body);
      res.json({ success: true, profile });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Proxies management & Free Proxy Health Check endpoints
  app.get("/api/proxy/status", (req, res) => {
    const stats = proxyService.getStats();
    res.json({
      success: true,
      stats,
    });
  });

  app.post("/api/proxy/refresh-free", async (req, res) => {
    try {
      const count = await proxyService.fetchFreeProxies();
      const testProxy = await proxyService.getNextHealthyProxy(4);
      res.json({
        success: true,
        downloadedCount: count,
        healthySample: testProxy ? `${testProxy.host}:${testProxy.port} (${testProxy.latencyMs}ms)` : "Bascule mode direct",
        stats: proxyService.getStats(),
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Distributed lock status endpoint
  app.get("/api/lock/status", async (req, res) => {
    const resource = (req.query.resource as string) || "sniper:global";
    const status = await LockService.checkLockStatus(resource);
    res.json(status);
  });

  // Maintenance & Purge endpoint (Manuel ou via Cron VPS)
  app.post("/api/maintenance/purge", async (req, res) => {
    try {
      const result = await MaintenanceService.runPurgeRoutine();
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  console.log(`[SERVER] Attempting to listen on port ${PORT}...`);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] VisaBot Automation Server started successfully.`);
    console.log(`[SERVER] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);

    // Démarrage du polling interactif Telegram (Human-in-the-Loop)
    telegramService.startPolling({
      onOtp: async (code: string) => {
        return await bot.submitOtp(code);
      },
      onResume: async () => {
        return await bot.resumeIntervention();
      },
      onStatus: async () => {
        const s = bot.getStatus();
        const intervention = s.intervention;
        return [
          `🤖 <b>État du Bot Visa on Web</b>`,
          `• Statut : <code>${s.status}</code>`,
          `• En cours : <b>${s.isRunning ? "OUI" : "NON"}</b>`,
          intervention ? `\n🚨 <b>Intervention en attente :</b>\n<b>${intervention.diagnosis}</b>\n${intervention.recommendedAction}` : `\n✅ Aucune intervention requise pour le moment.`
        ].join("\n");
      },
      isAwaitingOtp: () => {
        return bot.isAwaitingOtp();
      }
    });
  });

  process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  // Interception des signaux SIGINT/SIGTERM pour tuer les sous-processus Chromium orphelins (SIGKILL)
  const shutdown = async (signal: string) => {
    console.log(`[SERVER] Reçu signal ${signal}. Arrêt propre et élimination des sous-processus Chromium orphelins (SIGKILL)...`);
    try {
      await bot.stop();
    } catch (e: any) {
      console.error("[SERVER] Erreur lors de l'arrêt du bot:", e.message);
    }

    try {
      const { execSync } = await import("child_process");
      execSync("pkill -9 -f 'chrome|chromium' || true", { stdio: "ignore" });
      console.log("[SERVER] Nettoyage forcé SIGKILL des processus Chromium terminé.");
    } catch {}

    httpServer.close(() => {
      console.log("[SERVER] Serveur HTTP fermé proprement.");
      process.exit(0);
    });

    setTimeout(() => {
      console.error("[SERVER] Arrêt forcé après expiration du délai.");
      process.exit(0);
    }, 4000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startServer().catch(err => {
  console.error("FATAL ERROR DURING SERVER STARTUP:", err);
  process.exit(1);
});
