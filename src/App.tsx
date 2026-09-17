import React, { useState, useEffect, useRef } from "react";
console.log("Schengen Automator App Loading...");
import { motion, AnimatePresence } from "motion/react";
import { 
  Play, 
  Square, 
  Terminal, 
  Shield, 
  Globe, 
  User, 
  Lock, 
  Settings, 
  RefreshCw, 
  CheckCircle, 
  AlertCircle, 
  History,
  ExternalLink,
  Bot,
  Activity,
  Eye,
  Maximize2,
  Minimize2,
  Monitor,
  Copy,
  Calendar,
  Sun,
  Moon,
  Pause,
  ArrowDown,
  X
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { io, Socket } from "socket.io-client";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface BotStatus {
  isRunning: boolean;
  status: string;
}

interface RecoveryAction {
  timestamp: string;
  action: string;
  reason: string;
}

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("theme");
    return (saved === "light" || saved === "dark") ? saved : "dark";
  });
  const [email, setEmail] = useState("patientmundele17@gmail.com");
  const [password, setPassword] = useState("Ordinateur@27");
  const [applicationIndex, setApplicationIndex] = useState("1");
  const [checkInterval, setCheckInterval] = useState("15"); // minutes
  const [screenshotQuality, setScreenshotQuality] = useState("80");
  const [maxReloads, setMaxReloads] = useState("5");
  const [preferredDateStart, setPreferredDateStart] = useState(new Date().toISOString().split('T')[0]);
  const [preferredDateEnd, setPreferredDateEnd] = useState(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  const [sniperMode, setSniperMode] = useState(true);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [proxyStats, setProxyStats] = useState<{
    manualCount: number;
    freeCount: number;
    healthyCount: number;
    activeMode: string;
    lastRefreshTime: string | null;
    lastTestedProxy: string | null;
  } | null>(null);
  const [refreshingProxies, setRefreshingProxies] = useState(false);
  const [status, setStatus] = useState<BotStatus>({ isRunning: false, status: "idle" });
  const [logs, setLogs] = useState<string[]>([]);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [successDetails, setSuccessDetails] = useState<any>(null);
  const [apiError, setApiError] = useState<{ type: string; message: string; resolution: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [recoveryActions, setRecoveryActions] = useState<RecoveryAction[]>([]);
  const [logFilter, setLogFilter] = useState<"all" | "recovery" | "ai">("all");
  const [intervention, setIntervention] = useState<{
    type: "OTP_SMS" | "CAPTCHA_3D" | "PAYMENT" | "BAN_OR_BLOCKED" | "OTHER";
    diagnosis: string;
    explanation: string;
    recommendedAction: string;
    inputSelector?: string;
    currentUrl?: string;
    timestamp: string;
    screenshotBase64?: string;
  } | null>(null);
  const [otpInput, setOtpInput] = useState("");
  const [isSubmittingOtp, setIsSubmittingOtp] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [autoScrollLogs, setAutoScrollLogs] = useState(false); // Désactivé par défaut pour empêcher que l'écran bouge sans cesse
  const [isBrowserExpanded, setIsBrowserExpanded] = useState(false); // Mode plein écran / vue fixe pour fixer l'écran
  const [freezeScreenView, setFreezeScreenView] = useState(false); // Permet de figer l'image actuelle sans être interrompu par les nouveaux frames
  const [frozenScreenshot, setFrozenScreenshot] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  const handleSubmitOtp = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!otpInput.trim()) return;
    setIsSubmittingOtp(true);
    try {
      const res = await fetch("/api/bot/otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: otpInput.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        setOtpInput("");
      } else {
        toast.error(data.message);
      }
    } catch (err: any) {
      toast.error(err.message || "Erreur de transmission OTP");
    } finally {
      setIsSubmittingOtp(false);
    }
  };

  const handleResumeIntervention = async () => {
    setIsResuming(true);
    try {
      const res = await fetch("/api/bot/resume", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        setIntervention(null);
      } else {
        toast.error(data.message);
      }
    } catch (err: any) {
      toast.error(err.message || "Erreur de reprise");
    } finally {
      setIsResuming(false);
    }
  };

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/bot/status", {
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) {
        console.warn(`[STATUS] Response not ok: ${res.status}`);
        return;
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.warn("[STATUS] Non-JSON response received, waiting for server to be fully ready...");
        return;
      }
      const data = await res.json();
      if (data && typeof data === "object") {
        setStatus({ isRunning: Boolean(data.isRunning), status: data.status || "idle" });
        if (data.lastError) setApiError(data.lastError);
        if (data.intervention) setIntervention(data.intervention);
        else if (data.status !== "waiting_human_intervention") setIntervention(null);
      }
    } catch (err) {
      console.warn("Failed to fetch status (server might still be initializing)", err);
    }
  };

  const fetchProxyStats = async () => {
    try {
      const res = await fetch("/api/proxy/status");
      const data = await res.json();
      if (data.success && data.stats) {
        setProxyStats(data.stats);
      }
    } catch {
      // ignore
    }
  };

  const handleRefreshProxies = async () => {
    setRefreshingProxies(true);
    try {
      const res = await fetch("/api/proxy/refresh-free", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.success(`${data.downloadedCount} proxys gratuits rafraîchis ! Échantillon test: ${data.healthySample}`);
        setProxyStats(data.stats);
      } else {
        toast.error("Erreur téléchargement proxys");
      }
    } catch (err: any) {
      toast.error(err.message || "Erreur de connexion");
    } finally {
      setRefreshingProxies(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchProxyStats();
    
    // Initialize Socket.IO
    const socket = io();
    socketRef.current = socket;

    socket.on("bot:log", (log: string) => {
      setLogs(prev => [...prev.slice(-99), log]);
      if (log.includes("[RECOVERY]")) {
        const match = log.match(/\[RECOVERY\]\s*\[(.*?)\]\s*Action:\s*(.*?)\s*\|\s*Reason:\s*(.*)/);
        if (match) {
          const recAction = {
            timestamp: match[1],
            action: match[2],
            reason: match[3]
          };
          setRecoveryActions(prev => {
            if (prev.some(p => p.timestamp === recAction.timestamp && p.action === recAction.action)) {
              return prev;
            }
            return [recAction, ...prev].slice(0, 50);
          });
        }
      }
    });

    socket.on("bot:recovery", (recovery: RecoveryAction) => {
      setRecoveryActions(prev => {
        if (prev.some(p => p.timestamp === recovery.timestamp && p.action === recovery.action)) {
          return prev;
        }
        return [recovery, ...prev].slice(0, 50);
      });
    });

    socket.on("bot:screenshot", (data: string) => {
      setScreenshot(data);
    });

    socket.on("bot:available_dates", (dates: string[]) => {
      setAvailableDates(dates);
    });

    socket.on("bot:success", (data: any) => {
      const message = typeof data === "string" ? data : data.message;
      const details = typeof data === "object" ? data.details : null;
      
      setSuccessDetails(details);
      
      toast.success(message, {
        duration: 10000,
        icon: <CheckCircle className="w-5 h-5 text-green-500" />,
      });
      // Play a notification sound if possible
      try {
        const audio = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3");
        audio.play();
      } catch (e) {}
    });

    socket.on("bot:status", (data: any) => {
      if (data && typeof data === "object") {
        setStatus({ isRunning: Boolean(data.isRunning), status: data.status || "idle" });
        if (data.lastError) setApiError(data.lastError);
      }
    });

    socket.on("bot:emergency", (data: any) => {
      toast.error(`ALERTE URGENCE: ${data.message || "Intervention requise"}`, {
        duration: 20000,
        icon: <AlertCircle className="w-5 h-5 text-red-500" />,
      });
    });

    socket.on("bot:human_intervention", (data: any) => {
      setIntervention(data);
      if (data.screenshotBase64) {
        setScreenshot(data.screenshotBase64);
      }
      toast.error(`🚨 INTERVENTION REQUISE: ${data.diagnosis || "Action requise"}`, {
        duration: 30000,
        description: data.explanation,
      });
    });

    socket.on("bot:intervention_resolved", () => {
      setIntervention(null);
      toast.success("✅ Intervention résolue ! Reprise de la navigation en autonomie.");
    });

    socket.on("bot:error", (data: any) => {
      setApiError(data);
      toast.error(data.message, {
        description: data.resolution,
        duration: 15000,
      });
    });

    socket.on("connect", () => {
      console.log("Connected to WebSocket");
      setIsConnected(true);
      toast.success("System Connection Active");
    });

    socket.on("disconnect", () => {
      console.log("Disconnected from WebSocket");
      setIsConnected(false);
      toast.error("System Connection Lost");
    });

    // Initial logs fetch
    fetch("/api/bot/logs", {
      headers: { "Accept": "application/json" }
    })
      .then(async res => {
        if (!res.ok) return [];
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) return [];
        return res.json();
      })
      .then(data => {
        if (!Array.isArray(data)) return;
        setLogs(data);
        const extracted = data
          .filter((log: string) => typeof log === "string" && log.includes("[RECOVERY]"))
          .map((log: string) => {
            const match = log.match(/\[RECOVERY\]\s*\[(.*?)\]\s*Action:\s*(.*?)\s*\|\s*Reason:\s*(.*)/);
            if (match) {
              return {
                timestamp: match[1],
                action: match[2],
                reason: match[3]
              };
            }
            return null;
          })
          .filter(Boolean) as RecoveryAction[];
        setRecoveryActions(extracted);
      })
      .catch(err => console.warn("[LOGS] Failed to fetch initial logs", err));

    // Periodic status refresh fallback
    const interval = setInterval(() => {
      fetchStatus();
    }, 10000);

    return () => {
      socket.disconnect();
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (autoScrollLogs) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScrollLogs]);

  const handleStart = async () => {
    try {
      setAvailableDates([]); // Clear previous findings
      const res = await fetch("/api/bot/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          email, 
          password, 
          applicationIndex, 
          preferredDateStart, 
          preferredDateEnd,
          checkInterval: parseInt(checkInterval) * 60 * 1000, // Convert minutes to ms
          quality: parseInt(screenshotQuality),
          maxReloads: parseInt(maxReloads),
          sniperMode
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(sniperMode ? "Mode Sniper activé : Réservation instantanée sans validation !" : "Bot démarré en mode surveillance");
        fetchStatus();
      } else {
        toast.error(data.message);
      }
    } catch (err) {
      toast.error("Failed to start bot");
    }
  };

  const handleTestTelegram = async () => {
    setTestingTelegram(true);
    try {
      const res = await fetch("/api/telegram/test", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.success("Message de test Telegram envoyé avec succès !");
      } else {
        toast.error(`Erreur Telegram: ${data.error || "Vérifiez TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID"}`);
      }
    } catch (err: any) {
      toast.error(`Échec du test Telegram: ${err.message}`);
    } finally {
      setTestingTelegram(false);
    }
  };

  const handleStop = async () => {
    try {
      const res = await fetch("/api/bot/stop", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        toast.info("Bot stopped");
        fetchStatus();
        setScreenshot(null);
        setAvailableDates([]);
      }
    } catch (err) {
      toast.error("Failed to stop bot");
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchStatus();
    setTimeout(() => setIsRefreshing(false), 500);
    toast.info("Status refreshed");
  };

  return (
    <div className={cn(
      "min-h-screen font-sans selection:bg-orange-500/30 transition-colors duration-300 relative",
      theme === "dark" ? "bg-[#0a0a0a] text-zinc-100" : "bg-zinc-50 text-zinc-900"
    )}>
      <Toaster position="top-right" theme={theme} />
      
      {/* API Error Banner */}
      <AnimatePresence>
        {apiError && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="w-full bg-red-500/10 border-b border-red-500/20 backdrop-blur-xl z-[60] relative"
          >
            <div className="max-w-7xl mx-auto px-8 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                <div>
                  <p className="text-[11px] font-bold text-red-500 uppercase tracking-wider">{apiError.message}</p>
                  <p className="text-[10px] text-zinc-400 font-medium">{apiError.resolution}</p>
                </div>
              </div>
              <button 
                onClick={() => setApiError(null)}
                className="p-1 px-2 rounded hover:bg-white/5 text-[10px] font-bold text-zinc-500 uppercase tracking-widest transition-colors"
              >
                Dismiss
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-orange-500/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] brightness-100 contrast-150" />
      </div>

      {/* Navigation Rail */}
      <div className={cn(
        "fixed left-0 top-0 bottom-0 w-16 border-r flex flex-col items-center py-8 gap-8 z-50 transition-all duration-300",
        theme === "dark" 
          ? "border-white/5 bg-black/20 backdrop-blur-xl" 
          : "border-zinc-200 bg-zinc-100/80 backdrop-blur-xl"
      )}>
        <div className="w-10 h-10 bg-orange-500 rounded-xl flex items-center justify-center shadow-lg shadow-orange-500/20">
          <Shield className="w-6 h-6 text-black" />
        </div>
        <div className="flex flex-col gap-6 mt-8">
          <button className="p-2 text-orange-500 bg-orange-500/10 rounded-lg"><Activity className="w-5 h-5" /></button>
          <button className={cn("p-2 transition-colors", theme === "dark" ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-400 hover:text-zinc-700")}><Settings className="w-5 h-5" /></button>
          <button className={cn("p-2 transition-colors", theme === "dark" ? "text-zinc-500 hover:text-zinc-300" : "text-zinc-400 hover:text-zinc-700")}><History className="w-5 h-5" /></button>
        </div>
        <div className="mt-auto flex flex-col gap-4 items-center">
          <button 
            onClick={() => {
              const nextTheme = theme === "dark" ? "light" : "dark";
              setTheme(nextTheme);
              localStorage.setItem("theme", nextTheme);
              toast.success(`Switched to ${nextTheme === "dark" ? "Dark" : "Light"} Mode`);
            }}
            className={cn(
              "p-2 rounded-lg border transition-all duration-300 flex items-center justify-center",
              theme === "dark" 
                ? "border-white/10 bg-white/5 hover:bg-white/10 text-amber-400" 
                : "border-zinc-200 bg-white hover:bg-zinc-50 text-blue-600 shadow-sm"
            )}
            title={theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"}
          >
            {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <div className={cn("w-8 h-8 rounded-full border transition-colors", theme === "dark" ? "bg-zinc-800 border-white/10" : "bg-zinc-200 border-zinc-300")} />
        </div>
      </div>

      {/* Main Content */}
      <main className="pl-16 min-h-screen">
        <div className="max-w-7xl mx-auto px-8 py-12">
          
          {/* Header */}
          <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
            <div>
              <div className="flex items-center gap-2 text-orange-500 mb-2">
                <Bot className="w-4 h-4" />
                <span className="text-[10px] font-bold tracking-[0.2em] uppercase">System Operational</span>
              </div>
              <h1 className={cn(
                "text-5xl font-bold tracking-tight mb-2 transition-colors duration-300",
                theme === "dark" ? "text-white" : "text-zinc-900"
              )}>
                Schengen <span className="text-orange-500">Automator</span>
              </h1>
              <p className={cn(
                "max-w-xl text-sm leading-relaxed transition-colors duration-300",
                theme === "dark" ? "text-zinc-500" : "text-zinc-600"
              )}>
                Advanced automated appointment booking system for Visa on Web. 
                Designed for speed, reliability, and precision.
              </p>
            </div>
            
            <div className="flex items-center gap-4">
              <button 
                onClick={handleRefresh}
                className={cn(
                  "p-3 rounded-xl border transition-all duration-300",
                  theme === "dark" 
                    ? "border-white/5 bg-white/5 hover:bg-white/10 text-zinc-100" 
                    : "border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-800 shadow-sm",
                  isRefreshing && "animate-spin"
                )}
              >
                <RefreshCw className="w-5 h-5" />
              </button>
              
              {!status.isRunning ? (
                <div className="flex items-center gap-3">
                  {status.status === "safety_paused" && (
                    <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 text-red-500 text-xs font-bold rounded-xl animate-pulse">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>SAFETY PAUSED</span>
                    </div>
                  )}
                  <button 
                    onClick={handleStart}
                    className="flex items-center gap-2 px-6 py-3 bg-orange-500 hover:bg-orange-600 text-black font-bold rounded-xl transition-all shadow-lg shadow-orange-500/20"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    START BOT
                  </button>
                </div>
              ) : (
                <button 
                  onClick={handleStop}
                  className="flex items-center gap-2 px-6 py-3 bg-zinc-100 hover:bg-white text-black font-bold rounded-xl transition-all"
                >
                  <Square className="w-4 h-4 fill-current" />
                  STOP BOT
                </button>
              )}
            </div>
          </header>

          {/* Human-in-the-Loop Emergency Intervention Banner */}
          <AnimatePresence>
            {intervention && (
              <motion.div
                initial={{ opacity: 0, y: -20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.98 }}
                className={cn(
                  "p-6 rounded-3xl border-2 mb-8 shadow-2xl relative overflow-hidden",
                  intervention.type === "OTP_SMS"
                    ? "bg-amber-500/10 border-amber-500/40 text-amber-200"
                    : "bg-red-500/10 border-red-500/40 text-red-200"
                )}
              >
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-white/10">
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      "p-3 rounded-2xl animate-bounce",
                      intervention.type === "OTP_SMS" ? "bg-amber-500 text-black" : "bg-red-500 text-white"
                    )}>
                      <AlertCircle className="w-6 h-6" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-0.5 rounded-full bg-black/40 border border-white/10">
                          {intervention.type === "OTP_SMS" ? "Validation OTP Requise" : "Intervention Humaine Requise"}
                        </span>
                        <span className="text-xs text-zinc-400">Signalé à {intervention.timestamp}</span>
                      </div>
                      <h2 className="text-lg font-black text-white mt-1">
                        {intervention.diagnosis}
                      </h2>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleResumeIntervention}
                      disabled={isResuming}
                      className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-bold rounded-xl border border-white/10 transition-colors flex items-center gap-2"
                    >
                      <RefreshCw className={cn("w-3.5 h-3.5", isResuming && "animate-spin")} />
                      Reprendre la navigation (/resume)
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-6 mt-4 items-center">
                  <div className="md:col-span-7 space-y-2">
                    <p className="text-sm text-zinc-300 font-medium">
                      <strong className="text-white">Explication IA :</strong> {intervention.explanation}
                    </p>
                    <p className="text-xs text-zinc-400">
                      <strong className="text-zinc-300">Action recommandée :</strong> {intervention.recommendedAction}
                    </p>
                    <p className="text-[11px] text-zinc-500 flex items-center gap-1.5 flex-wrap">
                      <span>💡 <b>Contrôle à distance :</b> Vous pouvez également envoyer</span>
                      {intervention.type === "OTP_SMS" ? (
                        <code className="bg-black/50 px-2 py-0.5 rounded text-amber-400 border border-amber-500/20">/otp 123456</code>
                      ) : (
                        <code className="bg-black/50 px-2 py-0.5 rounded text-red-400 border border-red-500/20">/resume</code>
                      )}
                      <span>directement sur Telegram.</span>
                    </p>
                  </div>

                  {intervention.type === "OTP_SMS" && (
                    <div className="md:col-span-5 bg-black/40 p-4 rounded-2xl border border-amber-500/30">
                      <form onSubmit={handleSubmitOtp} className="flex gap-2">
                        <input
                          type="text"
                          value={otpInput}
                          onChange={(e) => setOtpInput(e.target.value)}
                          placeholder="Entrez le code OTP..."
                          autoFocus
                          maxLength={10}
                          className="flex-1 px-3 py-2.5 bg-black/60 border border-amber-500/40 rounded-xl text-white font-mono text-center tracking-widest text-lg focus:outline-none focus:border-amber-400"
                        />
                        <button
                          type="submit"
                          disabled={isSubmittingOtp || !otpInput.trim()}
                          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-400 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all disabled:opacity-50 shadow-lg shadow-amber-500/20"
                        >
                          {isSubmittingOtp ? "Envoi..." : "Valider"}
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            
            {/* Left Column: Configuration & Live View */}
            <div className="lg:col-span-5 space-y-8">
              
              {/* Live Browser View */}
              <section className={cn(
                "rounded-3xl border overflow-hidden flex flex-col aspect-[16/10] transition-all duration-300",
                theme === "dark" ? "border-white/5 bg-black/40 backdrop-blur-md" : "border-zinc-200 bg-white shadow-sm"
              )}>
                <div className={cn(
                  "flex items-center justify-between px-5 py-3 border-b transition-colors duration-300",
                  theme === "dark" ? "border-white/5 bg-white/5" : "border-zinc-200 bg-zinc-50"
                )}>
                  <div className="flex items-center gap-2">
                    <Monitor className="w-3.5 h-3.5 text-orange-500" />
                    <h3 className="text-[10px] font-bold tracking-widest uppercase">Live Browser View</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {/* Bouton Figer l'écran pour garder les yeux fixés sans saut */}
                    {screenshot && (
                      <button
                        onClick={() => {
                          if (!freezeScreenView) {
                            setFrozenScreenshot(screenshot);
                            setFreezeScreenView(true);
                            toast.info("Image figée : vous pouvez l'examiner calmement sans être dérangé.");
                          } else {
                            setFreezeScreenView(false);
                            setFrozenScreenshot(null);
                            toast.success("Flux direct réactivé.");
                          }
                        }}
                        title={freezeScreenView ? "Reprendre le flux en direct" : "Figer cette image pour l'observer"}
                        className={cn(
                          "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider flex items-center gap-1 border transition-all",
                          freezeScreenView
                            ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                            : "bg-zinc-800 text-zinc-400 border-white/10 hover:text-white"
                        )}
                      >
                        {freezeScreenView ? <Play className="w-2.5 h-2.5 fill-current" /> : <Pause className="w-2.5 h-2.5 fill-current" />}
                        <span>{freezeScreenView ? "Figé (Pause)" : "Figer"}</span>
                      </button>
                    )}

                    <div className={cn("w-1.5 h-1.5 rounded-full", status.isRunning ? "bg-green-500 animate-pulse" : status.status === "safety_paused" ? "bg-red-500 animate-pulse" : "bg-zinc-500")} />
                    <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider">
                      {freezeScreenView ? "Paused View" : status.isRunning ? "Streaming" : status.status === "safety_paused" ? "Paused" : "Offline"}
                    </span>
                  </div>
                </div>
                
                <div className="flex-1 bg-zinc-900/50 relative group">
                  {(freezeScreenView ? frozenScreenshot : screenshot) ? (
                    <img 
                      src={(freezeScreenView ? frozenScreenshot : screenshot) || ""} 
                      alt="Browser View" 
                      className="w-full h-full object-contain cursor-zoom-in"
                      onClick={() => setIsBrowserExpanded(true)}
                    />
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-zinc-600">
                      <Eye className="w-12 h-12 opacity-20" />
                      <p className="text-xs font-medium uppercase tracking-widest opacity-40">No signal detected</p>
                    </div>
                  )}
                  
                  {status.isRunning && !screenshot && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
                      <div className="flex items-center gap-3 px-4 py-2 bg-black/60 rounded-full border border-white/10">
                        <RefreshCw className="w-3 h-3 animate-spin text-orange-500" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-white">Waiting for first frame...</span>
                      </div>
                    </div>
                  )}

                  <div className="absolute bottom-3 right-3 flex items-center gap-2 opacity-90 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={() => setIsBrowserExpanded(true)}
                      title="Ouvrir en plein écran fixe (Pas de scroll)"
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-black/80 hover:bg-black text-white text-xs font-semibold rounded-xl border border-white/20 backdrop-blur-md transition-all shadow-lg"
                    >
                      <Maximize2 className="w-3.5 h-3.5 text-orange-400" />
                      <span>Fixer plein écran</span>
                    </button>
                  </div>
                </div>
              </section>

              {/* Status Card */}
              <section className={cn(
                "p-6 rounded-3xl border backdrop-blur-md transition-all duration-300",
                theme === "dark" ? "border-white/5 bg-white/5" : "border-zinc-200 bg-white shadow-sm"
              )}>
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xs font-bold tracking-widest uppercase text-zinc-500">Status</h3>
                  <div className={cn(
                    "flex items-center gap-2 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider transition-colors duration-300",
                    status.isRunning ? "bg-green-500/10 text-green-500" : 
                    status.status === "safety_paused" ? "bg-red-500/10 text-red-500 border border-red-500/20" :
                    status.status === "success" ? "bg-blue-500/10 text-blue-500" :
                    "bg-zinc-500/10 text-zinc-500"
                  )}>
                    <div className={cn(
                      "w-1.5 h-1.5 rounded-full", 
                      status.isRunning ? "bg-green-500 animate-pulse" : 
                      status.status === "safety_paused" ? "bg-red-500 animate-pulse" :
                      status.status === "success" ? "bg-blue-500" :
                      "bg-zinc-500"
                    )} />
                    {status.isRunning ? "Active" : 
                     status.status === "safety_paused" ? "Safety Paused" : 
                     status.status === "success" ? "Completed" : "Idle"}
                  </div>
                </div>
                
                <div className="space-y-4">
                  <div className={cn("flex justify-between items-center py-3 border-b transition-colors duration-300", theme === "dark" ? "border-white/5" : "border-zinc-100")}>
                    <span className="text-sm text-zinc-400">Current Task</span>
                    <span className={cn("text-sm font-semibold capitalize", status.status === "safety_paused" && "text-red-500")}>
                      {status.status === "safety_paused" ? "Safety Paused" : status.status}
                    </span>
                  </div>
                  <div className={cn("flex justify-between items-center py-3 border-b transition-colors duration-300", theme === "dark" ? "border-white/5" : "border-zinc-100")}>
                    <span className="text-sm text-zinc-400">Target Portal</span>
                    <span className="text-sm font-medium flex items-center gap-1">
                      Visa on Web <ExternalLink className="w-3 h-3" />
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-3">
                    <span className="text-sm text-zinc-400">Last Check</span>
                    <span className="text-sm font-medium">Just now</span>
                  </div>
                </div>
              </section>

              {/* Recovery & Responsiveness Monitor Card */}
              <section className={cn(
                "p-6 rounded-3xl border backdrop-blur-md transition-all duration-300",
                theme === "dark" ? "border-white/5 bg-white/5" : "border-zinc-200 bg-white shadow-sm"
              )}>
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-amber-500" />
                    <h3 className="text-xs font-bold tracking-widest uppercase text-zinc-400">Recovery & Healing</h3>
                  </div>
                  {recoveryActions.length > 0 && (
                    <span className="px-2 py-0.5 bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[9px] font-black rounded-full uppercase">
                      Struggling ({recoveryActions.length} Actions)
                    </span>
                  )}
                </div>

                <div className="space-y-4">
                  {/* Status Indicator Bar */}
                  <div className={cn(
                    "p-4 rounded-2xl border flex items-center justify-between transition-colors duration-300",
                    theme === "dark" ? "bg-black/40 border-white/5" : "bg-zinc-50 border-zinc-200"
                  )}>
                    <div>
                      <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-0.5">Automation Health</span>
                      <span className={cn(
                        "text-xs font-bold uppercase",
                        recoveryActions.length === 0 ? "text-green-500" :
                        recoveryActions.length < 3 ? "text-yellow-500 animate-pulse" : "text-amber-500 animate-pulse"
                      )}>
                        {recoveryActions.length === 0 ? "Optimal Responsiveness" :
                         recoveryActions.length < 3 ? "Self-Healing Engaged" : "Heavily Throttled / Recovery Mode"}
                      </span>
                    </div>
                    <RefreshCw className={cn(
                      "w-4 h-4",
                      status.isRunning ? "text-orange-500 animate-spin" : "text-zinc-600",
                      recoveryActions.length > 0 && "text-amber-500"
                    )} />
                  </div>

                  {/* Recovery List preview */}
                  <div className="space-y-2">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block">System Recovery Log</span>
                    {recoveryActions.length === 0 ? (
                      <div className="p-4 rounded-xl border border-white/5 bg-black/20 text-xs text-zinc-500 italic text-center">
                        No responsive issues or automatic page reloads detected.
                      </div>
                    ) : (
                      <div className="max-h-48 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                        {recoveryActions.map((rec, idx) => (
                          <div 
                            key={idx} 
                            className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/10 flex flex-col gap-1 text-[11px] leading-relaxed"
                          >
                            <div className="flex justify-between items-center text-[9px] font-bold text-amber-500/60 uppercase">
                              <span>{rec.action}</span>
                              <span className="font-mono">{rec.timestamp}</span>
                            </div>
                            <p className="text-zinc-300 text-xs font-mono">{rec.reason}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {/* Findings Section */}
              <AnimatePresence>
                {availableDates.length > 0 && (
                  <motion.section 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    className="p-6 rounded-3xl border border-orange-500/20 bg-orange-500/5 backdrop-blur-md"
                  >
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-orange-500" />
                        <h3 className="text-xs font-bold tracking-widest uppercase text-orange-500">Available Slots</h3>
                      </div>
                      <span className="px-2 py-0.5 bg-orange-500 text-black text-[9px] font-black rounded-full uppercase">
                        {availableDates.length} Found
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {availableDates.map((date, idx) => (
                        <div 
                          key={idx} 
                          className="p-3 rounded-xl bg-orange-500/10 border border-orange-500/20 flex flex-col items-center gap-1"
                        >
                          <span className="text-[9px] font-bold text-orange-500/60 uppercase tracking-tighter">
                            {new Date(date).toLocaleDateString('en-US', { weekday: 'short' })}
                          </span>
                          <span className="text-sm font-mono font-bold text-orange-500">
                            {new Date(date).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })}
                          </span>
                          <span className="text-[8px] font-medium text-orange-400/40">
                            {new Date(date).getFullYear()}
                          </span>
                        </div>
                      ))}
                    </div>
                    
                    <p className="mt-4 text-[9px] text-orange-500/50 font-medium text-center uppercase tracking-widest">
                      AI is attempting to settle on the best date...
                    </p>
                  </motion.section>
                )}
              </AnimatePresence>

              {/* Configuration Card */}
              <section className={cn(
                "p-6 rounded-3xl border backdrop-blur-md transition-all duration-300",
                theme === "dark" ? "border-white/5 bg-white/5" : "border-zinc-200 bg-white shadow-sm"
              )}>
                <h3 className="text-xs font-bold tracking-widest uppercase text-zinc-500 mb-6">Configuration</h3>
                
                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-500 flex items-center gap-2">
                      <User className="w-3 h-3" /> EMAIL ADDRESS
                    </label>
                    <input 
                      type="email" 
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className={cn(
                        "w-full rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500/50 transition-colors border",
                        theme === "dark" ? "bg-black/40 border-white/10 text-zinc-100" : "bg-zinc-50 border-zinc-300 text-zinc-900"
                      )}
                      placeholder="email@example.com"
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-500 flex items-center gap-2">
                      <Lock className="w-3 h-3" /> PASSWORD
                    </label>
                    <input 
                      type="password" 
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={cn(
                        "w-full rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500/50 transition-colors border",
                        theme === "dark" ? "bg-black/40 border-white/10 text-zinc-100" : "bg-zinc-50 border-zinc-300 text-zinc-900"
                      )}
                      placeholder="••••••••"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-500 flex items-center gap-2">
                      <Globe className="w-3 h-3" /> APPLICATION INDEX
                    </label>
                    <input 
                      type="number" 
                      value={applicationIndex}
                      onChange={(e) => setApplicationIndex(e.target.value)}
                      className={cn(
                        "w-full rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500/50 transition-colors border",
                        theme === "dark" ? "bg-black/40 border-white/10 text-zinc-100" : "bg-zinc-50 border-zinc-300 text-zinc-900"
                      )}
                      min="1"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-500 flex items-center gap-2">
                      <RefreshCw className="w-3 h-3" /> CHECK INTERVAL (MINS)
                    </label>
                    <input 
                      type="number" 
                      value={checkInterval}
                      onChange={(e) => setCheckInterval(e.target.value)}
                      className={cn(
                        "w-full rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500/50 transition-colors border",
                        theme === "dark" ? "bg-black/40 border-white/10 text-zinc-100" : "bg-zinc-50 border-zinc-300 text-zinc-900"
                      )}
                      min="1"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-zinc-500 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <AlertCircle className="w-3 h-3 text-amber-500" /> MAX AUTO-RELOADS
                      </span>
                      <span className="text-xs text-zinc-500">Default: 5 reloads</span>
                    </label>
                    <input 
                      type="number" 
                      value={maxReloads}
                      onChange={(e) => setMaxReloads(e.target.value)}
                      className={cn(
                        "w-full rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-orange-500/50 transition-colors border",
                        theme === "dark" ? "bg-black/40 border-white/10 text-zinc-100" : "bg-zinc-50 border-zinc-300 text-zinc-900"
                      )}
                      min="1"
                      placeholder="e.g. 5"
                    />
                    <p className="text-[10px] text-zinc-500 leading-normal">
                      Maximum page reloads for unresponsive states before warning of potential portal outage.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                        <Activity className="w-3 h-3" /> START DATE
                      </label>
                      <input 
                        type="date" 
                        value={preferredDateStart}
                        onChange={(e) => setPreferredDateStart(e.target.value)}
                        className={cn(
                          "w-full rounded-xl px-4 py-3 text-[11px] focus:outline-none focus:border-orange-500/50 transition-colors border",
                          theme === "dark" ? "bg-black/40 border-white/10 text-zinc-300" : "bg-zinc-50 border-zinc-300 text-zinc-800"
                        )}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                        <Activity className="w-3 h-3" /> END DATE
                      </label>
                      <input 
                        type="date" 
                        value={preferredDateEnd}
                        onChange={(e) => setPreferredDateEnd(e.target.value)}
                        className={cn(
                          "w-full rounded-xl px-4 py-3 text-[11px] focus:outline-none focus:border-orange-500/50 transition-colors border",
                          theme === "dark" ? "bg-black/40 border-white/10 text-zinc-300" : "bg-zinc-50 border-zinc-300 text-zinc-800"
                        )}
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-4 pt-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Eye className="w-3 h-3 text-orange-500" /> SCREENSHOT QUALITY
                    </span>
                    <span className="text-orange-500 font-mono">{screenshotQuality}%</span>
                  </label>
                  <input 
                    type="range" 
                    min="20" 
                    max="100" 
                    step="5"
                    value={screenshotQuality}
                    onChange={(e) => setScreenshotQuality(e.target.value)}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-orange-500"
                  />
                  <div className="flex justify-between text-[7px] text-zinc-600 font-bold uppercase tracking-tighter">
                    <span>Performance</span>
                    <span>AI Precision</span>
                  </div>
                </div>

                {/* Sniper Mode Toggle & Telegram Integration */}
                <div className="pt-4 border-t border-white/5 space-y-4">
                  {/* Mode Sniper */}
                  <div className="flex items-center justify-between p-3 rounded-2xl bg-orange-500/10 border border-orange-500/20">
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-orange-500/20 text-orange-500">
                        <Bot className="w-4 h-4" />
                      </div>
                      <div>
                        <span className="text-xs font-bold text-orange-500 block">MODE SNIPER 24/7</span>
                        <span className="text-[10px] text-zinc-400 block">Réservation automatique immédiate sans validation</span>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={sniperMode} 
                        onChange={(e) => setSniperMode(e.target.checked)} 
                        className="sr-only peer" 
                      />
                      <div className="w-9 h-5 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-500"></div>
                    </label>
                  </div>

                  {/* Telegram Alerts Integration */}
                  <div className="p-3.5 rounded-2xl border border-white/5 bg-black/20 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Shield className="w-3.5 h-3.5 text-blue-400" />
                        <span className="text-[11px] font-bold text-zinc-300 uppercase tracking-wide">Alertes Telegram Bot</span>
                      </div>
                      <span className="text-[9px] font-semibold text-blue-400 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20">
                        Succès & Urgences
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      Avertit instantanément sur Telegram uniquement lors d'un <b>Succès</b> (créneau réservé) ou d'une <b>Urgence</b> (Captcha / blocage requérant intervention).
                    </p>
                    <button
                      type="button"
                      onClick={handleTestTelegram}
                      disabled={testingTelegram}
                      className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-xl bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 transition-all disabled:opacity-50"
                    >
                      <RefreshCw className={cn("w-3.5 h-3.5", testingTelegram && "animate-spin")} />
                      <span>{testingTelegram ? "Envoi du test en cours..." : "Tester l'alerte Telegram"}</span>
                    </button>
                  </div>

                  {/* Proxys Gratuits & Health Check Auto */}
                  <div className="p-3.5 rounded-2xl border border-white/5 bg-black/20 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Globe className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-[11px] font-bold text-zinc-300 uppercase tracking-wide">Proxys Gratuits & Health Check</span>
                      </div>
                      <span className="text-[9px] font-semibold text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                        100% Gratuit (ProxyScrape)
                      </span>
                    </div>
                    <div className="space-y-1 text-[10px]">
                      <div className="flex justify-between text-zinc-400">
                        <span>Mode Actif:</span>
                        <span className="font-semibold text-zinc-200">
                          {proxyStats?.activeMode === "free_proxies" ? "Auto-Scrape + Health Check" : 
                           proxyStats?.activeMode === "manual_proxies" ? "Manuel (Configuré)" : "Connexion Directe Sécurisée"}
                        </span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Pool en mémoire:</span>
                        <span className="font-mono text-zinc-300">
                          {proxyStats ? `${proxyStats.freeCount} proxys (${proxyStats.healthyCount} testés sains)` : "Téléchargement au lancement"}
                        </span>
                      </div>
                      {proxyStats?.lastTestedProxy && (
                        <div className="flex justify-between text-zinc-400">
                          <span>Dernier test:</span>
                          <span className="font-mono text-emerald-400 truncate max-w-[170px]" title={proxyStats.lastTestedProxy}>
                            {proxyStats.lastTestedProxy}
                          </span>
                        </div>
                      )}
                    </div>
                    <p className="text-[10px] text-zinc-400 leading-relaxed">
                      Chaque proxy public est testé en direct (latence max 2.5s) avant démarrage. S'il est mort ou lent, le bot passe au suivant ou bascule automatiquement en direct sans jamais geler.
                    </p>
                    <button
                      type="button"
                      onClick={handleRefreshProxies}
                      disabled={refreshingProxies}
                      className="w-full flex items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition-all disabled:opacity-50"
                    >
                      <RefreshCw className={cn("w-3.5 h-3.5", refreshingProxies && "animate-spin")} />
                      <span>{refreshingProxies ? "Téléchargement & Health Check..." : "Rafraîchir & Tester les proxys"}</span>
                    </button>
                  </div>
                </div>
              </section>
            </div>

            {/* Right Column: Terminal Logs */}
            <div className="lg:col-span-7">
              <section className={cn(
                "h-full flex flex-col rounded-3xl border backdrop-blur-md overflow-hidden transition-all duration-300",
                theme === "dark" ? "border-white/5 bg-black/40" : "border-zinc-200 bg-white shadow-sm"
              )}>
                <div className={cn(
                  "flex items-center justify-between px-6 py-4 border-b transition-colors duration-300",
                  theme === "dark" ? "border-white/5 bg-white/5" : "border-zinc-200 bg-zinc-50"
                )}>
                  <div className="flex items-center gap-3">
                    <Terminal className="w-4 h-4 text-orange-500" />
                    <h3 className={cn("text-xs font-bold tracking-widest uppercase", theme === "dark" ? "text-zinc-300" : "text-zinc-700")}>System Console</h3>
                    <div className={cn(
                      "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-tighter",
                      isConnected ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"
                    )}>
                      <div className={cn("w-1 h-1 rounded-full", isConnected ? "bg-green-500 animate-pulse" : "bg-red-500")} />
                      {isConnected ? "Connected" : "Disconnected"}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/20 border border-red-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/20 border border-green-500/50" />
                  </div>
                </div>

                {/* Log Category Selection Tabs & Auto-Scroll Controls */}
                <div className={cn(
                  "flex items-center justify-between border-b px-6 py-2 gap-2 text-[10px] font-bold tracking-wider uppercase text-zinc-500 transition-colors duration-300",
                  theme === "dark" ? "border-white/5 bg-black/20" : "border-zinc-200 bg-zinc-100/50"
                )}>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => setLogFilter("all")}
                      className={cn(
                        "px-3 py-1.5 rounded-lg transition-all",
                        logFilter === "all" 
                          ? (theme === "dark" ? "bg-white/10 text-orange-500" : "bg-zinc-200/80 text-orange-600") 
                          : (theme === "dark" ? "hover:text-zinc-300 text-zinc-500" : "hover:text-zinc-700 text-zinc-500")
                      )}
                    >
                      All Logs
                    </button>
                    <button 
                      onClick={() => setLogFilter("recovery")}
                      className={cn(
                        "px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5",
                        logFilter === "recovery" 
                          ? (theme === "dark" ? "bg-white/10 text-amber-500 font-extrabold" : "bg-zinc-200/80 text-amber-600 font-extrabold") 
                          : (theme === "dark" ? "hover:text-zinc-300 text-zinc-500" : "hover:text-zinc-700 text-zinc-500")
                      )}
                    >
                      <span className={cn("w-1.5 h-1.5 rounded-full bg-amber-500", logFilter === "recovery" && "animate-ping")} />
                      Recovery Actions ({recoveryActions.length})
                    </button>
                    <button 
                      onClick={() => setLogFilter("ai")}
                      className={cn(
                        "px-3 py-1.5 rounded-lg transition-all",
                        logFilter === "ai" 
                          ? (theme === "dark" ? "bg-white/10 text-blue-400" : "bg-zinc-200/80 text-blue-600") 
                          : (theme === "dark" ? "hover:text-zinc-300 text-zinc-500" : "hover:text-zinc-700 text-zinc-500")
                      )}
                    >
                      AI Decisions
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Auto-scroll toggle */}
                    <button
                      onClick={() => setAutoScrollLogs(prev => !prev)}
                      title={autoScrollLogs ? "Désactiver le défilement automatique" : "Activer le défilement automatique"}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[10px] font-semibold transition-all",
                        autoScrollLogs 
                          ? "bg-orange-500/10 border-orange-500/30 text-orange-400"
                          : "bg-zinc-800/40 border-white/10 text-zinc-400 hover:text-zinc-200"
                      )}
                    >
                      <span className={cn(
                        "w-1.5 h-1.5 rounded-full",
                        autoScrollLogs ? "bg-orange-500 animate-pulse" : "bg-zinc-500"
                      )} />
                      <span>Auto-scroll : {autoScrollLogs ? "ACTIF" : "PAUSE"}</span>
                    </button>

                    {/* Scroll to bottom manually */}
                    <button
                      onClick={() => logEndRef.current?.scrollIntoView({ behavior: "smooth" })}
                      title="Aller tout en bas"
                      className="p-1 rounded-lg bg-zinc-800/40 border border-white/10 text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                
                <div className="flex-1 p-6 font-mono text-xs overflow-y-auto custom-scrollbar space-y-2">
                  {logs.length === 0 ? (
                    <div className="text-zinc-600 italic">Waiting for system initialization...</div>
                  ) : (
                    (() => {
                      const filtered = logs.filter(log => {
                        if (logFilter === "recovery") return log.includes("[RECOVERY]");
                        if (logFilter === "ai") return log.includes("Decision") || log.includes("Action:") || log.includes("CYCLE");
                        return true;
                      });

                      if (filtered.length === 0) {
                        return <div className="text-zinc-600 italic py-4 text-center">No logs matching this category in current buffer.</div>;
                      }

                      return filtered.map((log, i) => {
                        const isRecovery = log.includes("[RECOVERY]");
                        const isSuccess = log.includes("SUCCESS") || log.includes("SUCCESSFUL");
                        const isError = log.includes("Error") || log.includes("CRITICAL") || log.includes("Warning");

                        return (
                          <motion.div 
                            key={i}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            className={cn(
                              "flex gap-3 leading-relaxed",
                              isSuccess ? (theme === "dark" ? "text-green-400 font-semibold" : "text-green-600 font-semibold") : 
                              isError ? (theme === "dark" ? "text-red-400 font-semibold" : "text-red-600 font-semibold") : 
                              isRecovery ? (theme === "dark" ? "text-amber-400 bg-amber-50/5 px-2 py-1 rounded border border-amber-500/10 my-1 shadow-sm" : "text-amber-700 bg-amber-500/10 px-2 py-1 rounded border border-amber-200 my-1 shadow-sm") :
                              (theme === "dark" ? "text-zinc-400" : "text-zinc-600")
                            )}
                          >
                            <span className={cn("shrink-0", theme === "dark" ? "text-zinc-600" : "text-zinc-400")}>[{i.toString().padStart(3, '0')}]</span>
                            <span className="break-all">{log}</span>
                          </motion.div>
                        );
                      });
                    })()
                  )}
                  <div ref={logEndRef} />
                </div>

                <div className={cn(
                  "px-6 py-4 border-t flex items-center justify-between transition-colors duration-300",
                  theme === "dark" ? "border-white/5 bg-white/5" : "border-zinc-200 bg-zinc-50"
                )}>
                  <div className="flex items-center gap-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                      Live Feed
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                      Encrypted
                    </div>
                  </div>
                  <div className="text-[10px] font-mono text-zinc-500 uppercase">
                    v1.2.0-recovery-monitored
                  </div>
                </div>
              </section>
            </div>

          </div>

          {/* Footer Info */}
          <footer className={cn(
            "mt-12 pt-8 border-t flex flex-col md:flex-row justify-between gap-6 text-[11px] uppercase tracking-[0.2em] font-bold transition-all duration-300",
            theme === "dark" ? "border-white/5 text-zinc-500" : "border-zinc-200 text-zinc-400"
          )}>
            <div className="flex items-center gap-6">
              <span className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-green-500" /> AES-256 Encryption</span>
              <span className="flex items-center gap-2"><CheckCircle className="w-3 h-3 text-green-500" /> Anti-Detection Engine</span>
            </div>
            <div className="flex items-center gap-6">
              <span className={cn("transition-colors cursor-pointer", theme === "dark" ? "hover:text-zinc-300" : "hover:text-zinc-700")}>Security Protocol</span>
              <span className={cn("transition-colors cursor-pointer", theme === "dark" ? "hover:text-zinc-300" : "hover:text-zinc-700")}>API Documentation</span>
              <span className="text-zinc-500">© 2026 Automator Systems</span>
            </div>
          </footer>
        </div>
      </main>

      {/* Success Modal */}
      <AnimatePresence>
        {successDetails && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSuccessDetails(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-zinc-900 border border-white/10 rounded-[32px] overflow-hidden shadow-2xl"
            >
              <div className="bg-orange-500 p-8 flex flex-col items-center text-center gap-4">
                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-xl">
                  <CheckCircle className="w-10 h-10 text-orange-500" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-black">Appointment Booked!</h2>
                  <p className="text-black/70 text-sm font-medium">Your visa appointment has been successfully secured.</p>
                </div>
              </div>
              
              <div className="p-8 space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/5">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">Date</span>
                    <span className="text-sm font-medium text-zinc-200">{successDetails.date || "N/A"}</span>
                  </div>
                  <div className="p-4 rounded-2xl bg-white/5 border border-white/5">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">Time</span>
                    <span className="text-sm font-medium text-zinc-200">{successDetails.time || "N/A"}</span>
                  </div>
                </div>
                
                <div className="p-4 rounded-2xl bg-white/5 border border-white/5">
                  <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest block mb-1">Location</span>
                  <span className="text-sm font-medium text-zinc-200">{successDetails.location || "N/A"}</span>
                </div>
                
                <div className="p-4 rounded-2xl bg-orange-500/10 border border-orange-500/20 relative group/ref">
                  <span className="text-[10px] font-bold text-orange-500 uppercase tracking-widest block mb-1">Reference Number</span>
                  <div className="flex items-center justify-between">
                    <span className="text-lg font-mono font-bold text-orange-500">{successDetails.referenceNumber || "N/A"}</span>
                    <button 
                      onClick={() => {
                        navigator.clipboard.writeText(successDetails.referenceNumber || "");
                        toast.success("Reference number copied!");
                      }}
                      className="p-2 hover:bg-orange-500/20 rounded-lg transition-colors text-orange-500"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <button 
                  onClick={() => setSuccessDetails(null)}
                  className="w-full py-4 bg-zinc-100 hover:bg-white text-black font-bold rounded-2xl transition-all"
                >
                  DISMISS
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Mode Plein Écran / Vue Fixe Dédiée (Empêche les sauts et permet de fixer l'écran sereinement) */}
      <AnimatePresence>
        {isBrowserExpanded && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/90 backdrop-blur-xl">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="w-full max-w-6xl max-h-[95vh] h-[90vh] flex flex-col rounded-3xl border border-white/10 bg-zinc-950 overflow-hidden shadow-2xl relative"
            >
              {/* Header Modal Plein Écran */}
              <div className="px-6 py-4 border-b border-white/10 bg-zinc-900/80 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Monitor className="w-4 h-4 text-orange-400" />
                  <span className="text-sm font-bold text-white uppercase tracking-wider">Vue Navigateur Agrandie & Fixe</span>
                  <span className={cn(
                    "text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full",
                    freezeScreenView ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  )}>
                    {freezeScreenView ? "Image Figée (Pause)" : "Flux Direct Actif"}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {/* Bouton Figer / Reprendre */}
                  {screenshot && (
                    <button
                      onClick={() => {
                        if (!freezeScreenView) {
                          setFrozenScreenshot(screenshot);
                          setFreezeScreenView(true);
                          toast.info("Image figée : observez calmement.");
                        } else {
                          setFreezeScreenView(false);
                          setFrozenScreenshot(null);
                          toast.success("Flux direct réactivé.");
                        }
                      }}
                      className={cn(
                        "px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 border transition-all",
                        freezeScreenView
                          ? "bg-amber-500 text-black border-amber-400 shadow-md shadow-amber-500/20"
                          : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-white/10"
                      )}
                    >
                      {freezeScreenView ? <Play className="w-3.5 h-3.5 fill-current" /> : <Pause className="w-3.5 h-3.5 fill-current" />}
                      <span>{freezeScreenView ? "Reprendre le direct" : "Figer cette image"}</span>
                    </button>
                  )}

                  {/* Fermer */}
                  <button
                    onClick={() => setIsBrowserExpanded(false)}
                    className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white border border-white/10 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Corps Image Plein Écran */}
              <div className="flex-1 bg-black p-4 flex items-center justify-center overflow-auto">
                {(freezeScreenView ? frozenScreenshot : screenshot) ? (
                  <img 
                    src={(freezeScreenView ? frozenScreenshot : screenshot) || ""} 
                    alt="Expanded Browser View" 
                    className="max-w-full max-h-full object-contain rounded-xl shadow-2xl border border-white/5"
                  />
                ) : (
                  <div className="text-zinc-500 text-sm italic">Aucun frame disponible pour le moment</div>
                )}
              </div>

              {/* Footer Modal */}
              <div className="px-6 py-3 border-t border-white/10 bg-zinc-900/60 flex items-center justify-between text-xs text-zinc-400">
                <span>💡 Cette vue reste totalement fixe et ne subit aucun défilement de console.</span>
                <button
                  onClick={() => setIsBrowserExpanded(false)}
                  className="px-4 py-1 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-semibold"
                >
                  Fermer (Échap)
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
