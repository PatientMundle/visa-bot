import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "puppeteer";
import { Server } from "socket.io";
import { GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { telegramService } from "./telegram.ts";
import { logAppointmentBooking } from "../db/configService.ts";
import { proxyService, ProxyConfig } from "./proxyService.ts";
import { SessionService } from "./sessionService.ts";
import { LockService } from "./lockService.ts";

puppeteer.use(StealthPlugin());

export class VisaBot {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private isRunning: boolean = false;
  private logs: string[] = [];
  private status: string = "idle";
  private intervalId: NodeJS.Timeout | null = null;
  private scheduleTimeoutId: NodeJS.Timeout | null = null;
  private checkInterval: number = 300000; // 5 minutes
  private io: Server;
  private cachedGeminiKey: string = "";
  private cachedGeminiClient: GoogleGenAI | null = null;
  private cachedGroqKey: string = "";
  private cachedGroqClient: Groq | null = null;
  private lastError: { type: string; message: string; resolution: string } | null = null;
  private screenshotQuality: number = 30;
  private maxReloads: number = 5;
  private reloadsCount: number = 0;
  private lastErrorMsg: string | null = null;
  private consecutiveErrorCount: number = 0;
  private sniperMode: boolean = true;
  private lastEmergencySentAt: number = 0;
  private currentProxy: ProxyConfig | null = null;
  private lastScreenshotBase64: string | null = null;

  // Auto-réparation des Sélecteurs (Self-Healing Cache pour le mode Sniper)
  private selfHealedElements: Map<string, {
    selector?: string;
    coordinates?: { x: number; y: number };
    actionType: "click" | "type" | "dismiss_overlay";
    successCount: number;
    lastUsed: number;
  }> = new Map();

  // Garde-fous Cognitifs : Exponential Backoff sur 429/503
  private consecutive429or503Count: number = 0;
  private backoffUntil: number = 0;

  // Human-in-the-Loop & Gestionnaire OTP/Intervention
  private pendingIntervention: {
    type: "OTP_SMS" | "CAPTCHA_3D" | "PAYMENT" | "BAN_OR_BLOCKED" | "OTHER";
    diagnosis: string;
    explanation: string;
    recommendedAction: string;
    inputSelector?: string;
    coordinates?: { x: number; y: number };
    currentUrl?: string;
    timestamp: string;
  } | null = null;
  private pendingOtpResolver: ((code: string | null) => void) | null = null;
  private pendingResumeResolver: ((resumed: boolean) => void) | null = null;

  private getGeminiClient(): GoogleGenAI | null {
    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (!geminiKey) return null;
    if (this.cachedGeminiClient && this.cachedGeminiKey === geminiKey) {
      return this.cachedGeminiClient;
    }
    this.cachedGeminiKey = geminiKey;
    this.cachedGeminiClient = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
    return this.cachedGeminiClient;
  }

  private getGroqClient(): Groq | null {
    const groqKey = process.env.GROQ_API_KEY || "";
    if (!groqKey) return null;
    if (this.cachedGroqClient && this.cachedGroqKey === groqKey) {
      return this.cachedGroqClient;
    }
    this.cachedGroqKey = groqKey;
    this.cachedGroqClient = new Groq({ apiKey: groqKey });
    return this.cachedGroqClient;
  }

  constructor(io: Server) {
    try {
      this.io = io;
      this.log("System initialization sequence started...");
      
      // Check Gemini AI (Primary)
      const geminiClient = this.getGeminiClient();
      if (!geminiClient) {
        const errMsg = "Gemini API key is not configured.";
        this.log(`WARNING: ${errMsg}`);
        this.lastError = {
          type: "GEMINI_API_KEY_MISSING",
          message: errMsg,
          resolution: "Please add GEMINI_API_KEY to your environment variables or check the AI Studio Secrets panel (Settings -> Secrets)."
        };
        this.io.emit("bot:error", this.lastError);
      } else {
        this.log("Primary AI (Google Gemini Multi-Model Cascade: 2.5 / 2.0 / 3.8 Flash) initialized and ready.");
      }

      // Check Groq AI (Fallback)
      const groqClient = this.getGroqClient();
      if (groqClient) {
        this.log("Groq fallback AI initialized with active vision models (qwen/qwen3.8-27b, qwen/qwen3.6-27b).");
      } else {
        const errMsg = "Fallback AI (Groq) is not configured.";
        this.log(`INFO: ${errMsg}`);
        if (!geminiClient) {
          this.lastError = {
            type: "GROQ_API_KEY_MISSING",
            message: errMsg,
            resolution: "Add GROQ_API_KEY to your environment variables or .env file as a reliable backup."
          };
          this.io.emit("bot:error", this.lastError);
        }
      }
      
      this.log("System ready. Waiting for user to start...");

      // Periodic heartbeat to ensure connectivity is visible even when idle
      setInterval(() => {
        const state = this.isRunning ? `ACTIVE (Status: ${this.status})` : "IDLE";
        this.log(`Heartbeat: System is ${state}. Waiting for instructions.`);
      }, 30000); // Every 30 seconds
    } catch (err: any) {
      console.error("FATAL: VisaBot constructor failed:", err);
    }
  }

  private log(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    this.logs.push(logEntry);
    if (this.logs.length > 100) this.logs.shift();
    this.io.emit("bot:log", logEntry);
    console.log(logEntry);
  }

  private logRecovery(action: string, reason: string) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[RECOVERY] [${timestamp}] Action: ${action} | Reason: ${reason}`;
    this.logs.push(logEntry);
    if (this.logs.length > 100) this.logs.shift();
    this.io.emit("bot:log", logEntry);
    this.io.emit("bot:recovery", { timestamp, action, reason });
    console.log(logEntry);
  }

  private async performReload(reason: string) {
    this.reloadsCount++;
    this.logRecovery("Automatic Page Reload", `Triggered page reload (Attempt ${this.reloadsCount}/${this.maxReloads}) due to: ${reason}`);
    
    if (this.reloadsCount >= this.maxReloads) {
      const errMsg = `CRITICAL WARNING: The maximum number of automated page reloads (${this.maxReloads}) has been reached. The Visa on Web site might be down or highly unresponsive.`;
      this.logRecovery("Site Outage Warning", errMsg);
      this.lastError = {
        type: "SITE_DOWN_WARNING",
        message: "Target site might be experiencing an outage",
        resolution: `The system has automatically reloaded the page ${this.reloadsCount} times. Please check the official Visa on Web portal status manually.`
      };
      this.io.emit("bot:error", this.lastError);
    }

    try {
      if (this.page && !this.page.isClosed()) {
        const currentUrl = this.page.url();
        if (!currentUrl || currentUrl === "about:blank" || currentUrl.startsWith("chrome-error://")) {
          this.log("[Recovery] Re-navigating to login page instead of reloading blank/error page...");
          await this.page.goto("https://visaonweb.diplomatie.be/en/Account/Login", {
            waitUntil: "load",
            timeout: 60000,
          }).catch(() => {});
        } else {
          await this.page.reload({ waitUntil: "load", timeout: 60000 }).catch(() => {});
        }
      }
    } catch (err: any) {
      this.log(`Reload action failed: ${err.message}`);
    }
  }

  private handleErrorCount(errMsg: string) {
    if (!errMsg) return;
    const normalized = errMsg.trim();
    if (this.lastErrorMsg === normalized) {
      this.consecutiveErrorCount++;
    } else {
      this.lastErrorMsg = normalized;
      this.consecutiveErrorCount = 1;
    }
    this.log(`[Safety Watch] Consecutive error check: "${normalized}" (Count: ${this.consecutiveErrorCount}/3)`);
    if (this.consecutiveErrorCount >= 3) {
      this.triggerSafetyPause(normalized);
    }
  }

  private async triggerSafetyPause(reason: string) {
    this.isRunning = false;
    this.status = "safety_paused";
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }
    this.lastError = {
      type: "SAFETY_PAUSED",
      message: "Bot Safety Paused due to repeated errors",
      resolution: `The bot encountered the exact same error 3 times in a row: "${reason}". Pausing execution to avoid flag detection or resource waste. Please check site access and restart.`
    };
    this.io.emit("bot:error", this.lastError);
    this.io.emit("bot:status", this.getStatus());
    this.log(`[SAFETY ACTIVATE] Bot Safety Paused. Reason: ${reason}`);

    // Telegram Emergency Alert (Urgence / Blocage persistant)
    (async () => {
      try {
        await telegramService.sendEmergencyAlert({
          reason: `Blocage automatique (Safety Pause) : Le bot a rencontré 3 erreurs consécutives identiques : "${reason}". Une intervention manuelle est requise.`,
        });
      } catch (err: any) {
        this.log(`[ALERT] Error sending safety pause Telegram alert: ${err.message}`);
      }
    })();
  }

  private async attemptReattach(): Promise<boolean> {
    if (!this.browser || !this.browser.isConnected()) {
      this.log("[Re-attach] No connected browser instance available.");
      return false;
    }
    try {
      const pages = await this.browser.pages();
      if (pages.length > 0) {
        // Find the last active, non-closed page
        const activePage = pages.find(p => !p.isClosed());
        if (activePage) {
          this.page = activePage;
          this.log(`[Re-attach] Successfully re-attached to active browser page. URL: ${this.page.url()}`);
          return true;
        }
      }
      // If all existing pages were closed, open a fresh page
      this.page = await this.browser.newPage();
      this.page.setDefaultNavigationTimeout(90000);
      this.page.setDefaultTimeout(45000);
      this.log("[Re-attach] Created and attached fresh browser page.");
      return true;
    } catch (err: any) {
      this.log(`[Re-attach] Error querying browser pages: ${err.message}`);
    }
    return false;
  }

  private async captureScreenshot(): Promise<string | null> {
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!this.page || this.page.isClosed()) {
        this.log(`[Screenshot] Page is closed or missing (Attempt ${attempt}/${maxRetries}). Attempting to re-attach...`);
        const reattached = await this.attemptReattach();
        if (!reattached) {
          if (attempt === maxRetries) {
            this.logRecovery("Screenshot Failure", "Screenshot unavailable: no active browser page.");
            return this.lastScreenshotBase64;
          }
          continue;
        }
      }

      try {
        // Fast viewport capture: disable full document scroll calculation and optimize for speed
        const screenshotPromise = this.page.screenshot({ 
          encoding: "base64", 
          type: "jpeg", 
          quality: Math.min(Math.max(this.screenshotQuality || 30, 20), 60),
          captureBeyondViewport: false,
          optimizeForSpeed: true
        });

        // 8s timeout to avoid freezing execution on slow render/proxy
        const timeoutPromise = new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error("Screenshot timeout (8s)")), 8000)
        );

        const screenshot = await Promise.race([screenshotPromise, timeoutPromise]);
        
        if (screenshot) {
          this.lastScreenshotBase64 = screenshot as string;
          const dataUrl = `data:image/jpeg;base64,${screenshot}`;
          this.io.emit("bot:screenshot", dataUrl);
          return screenshot as string;
        }
      } catch (err: any) {
        const errorMsg = err.message || "";
        const isTargetClosedOrDetached = 
          errorMsg.includes("Target closed") || 
          errorMsg.includes("detached Frame") || 
          errorMsg.includes("Session closed") || 
          errorMsg.includes("frame was detached") || 
          errorMsg.includes("Target crashed") ||
          errorMsg.includes("Not attached to an active page") ||
          errorMsg.includes("Cannot take screenshot") ||
          errorMsg.includes("Execution context was destroyed") ||
          errorMsg.includes("Protocol error");

        if (isTargetClosedOrDetached) {
          this.logRecovery("Page Detached", `Page detached (${errorMsg}). Attempting to re-attach (Attempt ${attempt}/${maxRetries})...`);
          const reattached = await this.attemptReattach();
          if (reattached && attempt < maxRetries) {
            await this.humanDelay(500, 1000).catch(() => {});
            continue; // retry capturing screenshot
          }
        } else {
          // Check if page DOM is still responsive before assuming failure
          let isPageAlive = false;
          try {
            if (this.page && !this.page.isClosed()) {
              isPageAlive = await Promise.race([
                this.page.evaluate(() => document.readyState).then(() => true),
                new Promise<boolean>((_, reject) => setTimeout(() => reject(false), 2000))
              ]);
            }
          } catch {
            isPageAlive = false;
          }

          if (isPageAlive) {
            this.log(`[Screenshot] Snapshot skipped (busy rendering: ${errorMsg}); reusing previous frame.`);
            if (this.lastScreenshotBase64) {
              return this.lastScreenshotBase64;
            }
          } else {
            this.logRecovery("Screenshot Attempt Failed", `Screenshot error: ${errorMsg} (Attempt ${attempt}/${maxRetries})`);
          }
        }
        
        if (attempt === maxRetries) {
          return this.lastScreenshotBase64;
        }
      }
    }
    return this.lastScreenshotBase64;
  }

  private async humanDelay(min: number = 800, max: number = 2500) {
    const delay = Math.floor(Math.random() * (max - min + 1) + min);
    await new Promise(r => setTimeout(r, delay));
  }

  private async moveMouseHumanly(selector: string) {
    if (!this.page) return;
    try {
      const element = await this.page.$(selector);
      if (element) {
        const box = await element.boundingBox();
        if (box) {
          // Move mouse to a random point within the element
          const x = box.x + Math.random() * box.width;
          const y = box.y + Math.random() * box.height;
          
          // Simulate some jitter/movement before the final position
          await this.page.mouse.move(x - 5, y + 2);
          await new Promise(r => setTimeout(r, 100));
          await this.page.mouse.move(x, y);
        }
      }
    } catch (e) {
      // Best effort mouse movement
    }
  }

  /**
   * Encadre waitForSelector avec un timeout strict via Promise.race()
   * pour éviter tout blocage indéfini du protocole CDP ou du thread Node.js
   */
  private async safeWaitForSelector(
    selector: string,
    timeoutMs: number = 5000,
    options: any = {}
  ): Promise<any> {
    if (!this.page) return null;
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<null>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Timeout strict (${timeoutMs}ms) via Promise.race dépassé pour le sélecteur: ${selector}`));
      }, timeoutMs);
    });

    try {
      const el = await Promise.race([
        this.page.waitForSelector(selector, { timeout: timeoutMs, ...options }),
        timeoutPromise,
      ]);
      if (timer) clearTimeout(timer);
      return el;
    } catch (err) {
      if (timer) clearTimeout(timer);
      throw err;
    }
  }

  private async typeHumanly(selector: string, text: string) {
    if (!this.page) return;
    try {
      await this.safeWaitForSelector(selector, 8000);
    } catch {
      // Ignorer si déjà visible
    }
    await this.page.click(selector, { clickCount: 3 });
    await this.page.keyboard.press('Backspace');
    
    for (const char of text) {
      await this.page.keyboard.sendCharacter(char);
      // Simulation frappe humaine aléatoire : délai strict entre 50ms et 150ms
      const delay = Math.floor(Math.random() * (150 - 50 + 1)) + 50;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  private async dismissPopups() {
    if (!this.page) return;
    try {
      const selectors = [
        "button#cookies-accept",
        "button.cookie-close",
        "button.btn-close",
        "[aria-label='Close']",
        ".modal-header .close",
        "#onetrust-accept-btn-handler",
        "#accept-choices",
        ".cc-btn.cc-dismiss",
        "#gdpr-consent-notice button.accept",
        ".cookie-banner-close",
        "button[id*='accept']",
        "button[class*='accept']",
        "button[id*='cookie']",
        "button[class*='cookie']"
      ];

      for (const selector of selectors) {
        try {
          const exists = await this.page.evaluate((s) => {
            const elements = Array.from(document.querySelectorAll(s));
            const visible = elements.find(el => {
              const htmlEl = el as HTMLElement;
              const txt = (htmlEl.innerText || htmlEl.textContent || "").toLowerCase();
              return htmlEl.offsetParent !== null && 
                     (txt.includes('accept') || 
                      txt.includes('agree') ||
                      txt.includes('close') ||
                      txt.includes('ok') ||
                      txt.includes('tout accepter') ||
                      txt.includes('continuer') ||
                      txt.includes('got it'));
            });
            
            if (visible) {
              (visible as HTMLElement).click();
              return true;
            }
            return false;
          }, selector);

          if (exists) {
            this.log(`Auto-dismissed overlay using selector: ${selector}`);
            await this.humanDelay(1500, 3000);
            return; // Dismiss one at a time
          }
        } catch (innerError) {
          // Individual selector error
        }
      }
    } catch (e: any) {
      this.log(`Error during popup dismissal scan: ${e.message}`);
      await this.captureScreenshot();
    }
  }

  private async askAI(prompt: string, screenshotBase64: string): Promise<any> {
    const geminiClient = this.getGeminiClient();

    // 1. Primary AI: Google Gemini Multi-Model Cascade
    if (geminiClient) {
      // Prioritize high-capacity, currently active models (gemini-3.8-flash, gemini-3.5-flash-lite, gemini-flash-latest)
      const geminiModels = [
        "gemini-3.8-flash",
        "gemini-3.5-flash-lite",
        "gemini-flash-latest"
      ];

      for (const modelName of geminiModels) {
        let retriesForModel = 1;
        let modelSuccess = false;

        while (retriesForModel >= 0 && !modelSuccess) {
          try {
            this.log(`AI Vision: Querying Gemini (${modelName})...`);
            const response = await geminiClient.models.generateContent({
              model: modelName,
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: prompt },
                    {
                      inlineData: {
                        mimeType: "image/jpeg",
                        data: screenshotBase64,
                      },
                    },
                  ],
                },
              ],
            });

            let text = response.text || "{}";
            text = text.replace(/```json/g, "").replace(/```/g, "").trim();
            
            try {
              const parsed = JSON.parse(text);
              if (parsed && parsed.action) {
                if (this.lastError && (this.lastError.type.startsWith("GEMINI_") || this.lastError.type.startsWith("GROQ_") || this.lastError.type === "NO_AI_AVAILABLE")) {
                  this.lastError = null;
                  this.io.emit("bot:error", null);
                }
                return parsed;
              }
            } catch (parseErr: any) {
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                try {
                  const parsed = JSON.parse(jsonMatch[0]);
                  if (parsed && parsed.action) {
                    if (this.lastError && (this.lastError.type.startsWith("GEMINI_") || this.lastError.type.startsWith("GROQ_") || this.lastError.type === "NO_AI_AVAILABLE")) {
                      this.lastError = null;
                      this.io.emit("bot:error", null);
                    }
                    return parsed;
                  }
                } catch (e) {}
              }
              this.log(`Gemini (${modelName}) parsing warning: ${parseErr.message}`);
            }
            modelSuccess = true;
            break;
          } catch (err: any) {
            const msg = err.message || "";
            const is503 = msg.includes("503") || msg.includes("high demand") || msg.includes("UNAVAILABLE") || (err.status === 503) || (err.code === 503);
            const is429 = msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");
            const isInvalidKey = msg.includes("API_KEY_INVALID") || msg.includes("400") || msg.includes("invalid key") || msg.includes("API key not valid");

            if (isInvalidKey) {
              const errMsg = "CRITICAL: The GEMINI_API_KEY is invalid or expired.";
              this.log(errMsg);
              this.lastError = { 
                type: "GEMINI_API_KEY", 
                message: errMsg,
                resolution: "Please update your GEMINI_API_KEY in the AI Studio Secrets panel. Go to Settings -> Secrets and paste a newly generated key."
              };
              this.io.emit("bot:error", this.lastError);
              retriesForModel = -1;
              break;
            } else if (is503) {
              this.log(`Notice: Gemini (${modelName}) high demand (503). Falling through to alternative...`);
              if (retriesForModel > 0) {
                retriesForModel--;
                await new Promise(r => setTimeout(r, 1200));
                continue;
              }
              break;
            } else if (is429) {
              this.log(`Notice: Gemini (${modelName}) rate limit reached (429). Switching to backup...`);
              break;
            } else {
              this.log(`Gemini (${modelName}) note: ${msg}`);
              break;
            }
          }
        }

        if (this.lastError?.type === "GEMINI_API_KEY") {
          break;
        }
      }
    } else {
      const errMsg = "GEMINI_API_KEY is not configured.";
      this.log(`INFO: ${errMsg} Checking fallback...`);
      this.lastError = { 
        type: "GEMINI_API_KEY_MISSING", 
        message: errMsg,
        resolution: "Please provide a valid GEMINI_API_KEY in Settings -> Secrets in AI Studio."
      };
      this.io.emit("bot:error", this.lastError);
    }

    // 2. Secondary AI: Groq Backup with Active Production Vision Models
    const groqClient = this.getGroqClient();
    if (groqClient) {
      this.log("Engaging backup AI with Groq Vision...");
      // Active vision models supported in production on Groq
      const GROQ_VISION_MODELS = [
        "qwen/qwen3.8-27b",
        "qwen/qwen3.6-27b"
      ];

      for (const groqModel of GROQ_VISION_MODELS) {
        try {
          this.log(`Querying Groq active vision model: ${groqModel}...`);
          const completion = await groqClient.chat.completions.create({
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:image/jpeg;base64,${screenshotBase64}`,
                    },
                  },
                ],
              },
            ],
            model: groqModel,
            temperature: 0.1,
            max_tokens: 1024,
            response_format: { type: "json_object" },
          });

          let text = completion.choices[0]?.message?.content || "{}";
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.action) {
              this.log(`Groq fallback successfully returned decision via ${groqModel}.`);
              if (this.lastError && (this.lastError.type.startsWith("GROQ_") || this.lastError.type === "NO_AI_AVAILABLE")) {
                this.lastError = null;
                this.io.emit("bot:error", null);
              }
              return parsed;
            }
          } catch (parseErr: any) {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed && parsed.action) {
                  return parsed;
                }
              } catch (e) {}
            }
            this.log(`Groq (${groqModel}) JSON parsing warning: ${parseErr.message}`);
          }
          break; // Request succeeded, stop model loop
        } catch (groqErr: any) {
          const msg = groqErr.message || "";
          this.log(`Groq ${groqModel} error: ${msg}`);

          if (groqErr.status === 401 || msg.includes("api_key_invalid") || msg.includes("Invalid API Key")) {
            const errMsg = "CRITICAL: The GROQ_API_KEY is invalid.";
            this.log(errMsg);
            this.lastError = { 
              type: "GROQ_API_KEY", 
              message: errMsg,
              resolution: "Check your GROQ_API_KEY in the .env file or environment variables settings."
            };
            this.io.emit("bot:error", this.lastError);
            break;
          } else if (groqErr.status === 429 || msg.includes("rate_limit_exceeded")) {
            const errMsg = "Groq API rate limit reached.";
            this.log(errMsg);
            this.lastError = {
              type: "GROQ_RATE_LIMIT",
              message: errMsg,
              resolution: "Groq is currently rate-limited. Retry in a few minutes or check your Groq usage console."
            };
            this.io.emit("bot:error", this.lastError);
            break;
          } else if (groqErr.status === 400 || msg.includes("model_decommissioned") || msg.includes("not found") || msg.includes("does not exist")) {
            this.log(`Model ${groqModel} is not accessible, trying next active Groq vision model...`);
            continue;
          } else {
            this.log(`Groq fallback attempt with ${groqModel} failed: ${msg}`);
          }
        }
      }
    } else {
      if (!geminiClient) {
        this.lastError = {
          type: "NO_AI_AVAILABLE",
          message: "No AI vision service is configured.",
          resolution: "Please configure your GEMINI_API_KEY in Settings -> Secrets, or provide GROQ_API_KEY."
        };
        this.io.emit("bot:error", this.lastError);
      }
    }

    return null;
  }

  public getStatus() {
    return { 
      isRunning: this.isRunning, 
      status: this.status, 
      lastError: this.lastError,
      intervention: this.pendingIntervention
    };
  }

  public getLogs() {
    return this.logs;
  }

  public isAwaitingOtp(): boolean {
    return Boolean(this.pendingIntervention && this.pendingIntervention.type === "OTP_SMS");
  }

  public getIntervention() {
    return this.pendingIntervention;
  }

  public async submitOtp(code: string): Promise<{ success: boolean; message: string }> {
    const cleanCode = (code || "").trim();
    if (!cleanCode) {
      return { success: false, message: "Le code OTP fourni est vide." };
    }
    if (!this.pendingOtpResolver) {
      return { success: false, message: "Le bot n'attend actuellement aucun code OTP." };
    }
    this.log(`[HUMAN-IN-THE-LOOP] Code OTP reçu (${cleanCode}). Transmission au pilote IA...`);
    this.pendingOtpResolver(cleanCode);
    this.pendingOtpResolver = null;
    return { success: true, message: `Code ${cleanCode} injecté dans le formulaire Visa.` };
  }

  public async resumeIntervention(): Promise<{ success: boolean; message: string }> {
    if (!this.pendingResumeResolver) {
      return { success: false, message: "Aucune intervention en attente de reprise." };
    }
    this.log("[HUMAN-IN-THE-LOOP] Signal de reprise manuelle reçu. Reprise de l'analyse visuelle...");
    this.pendingResumeResolver(true);
    this.pendingResumeResolver = null;
    this.pendingIntervention = null;
    this.io.emit("bot:intervention_resolved", { timestamp: new Date().toISOString() });
    return { success: true, message: "Session réactivée avec succès." };
  }

  public async start(
    email: string, 
    password: string, 
    applicationIndex: string, 
    preferredDateStart?: string, 
    preferredDateEnd?: string, 
    checkInterval?: number, 
    quality?: number, 
    maxReloads?: number,
    sniperMode: boolean = true
  ) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.sniperMode = sniperMode;
    this.status = "starting";
    this.reloadsCount = 0; // Reset reload count when bot is started/restarted
    this.consecutiveErrorCount = 0; // Reset consecutive errors when bot starts
    this.lastErrorMsg = null;
    if (checkInterval) this.checkInterval = checkInterval;
    if (quality) this.screenshotQuality = quality;
    if (maxReloads) this.maxReloads = maxReloads;
    this.log(`Bot starting with AI Guidance. Mode Sniper: ${this.sniperMode ? "ACTIVÉ (Réservation automatique instantanée)" : "Désactivé"}. Intervalle: ${this.checkInterval / 60000} min. Qualité: ${this.screenshotQuality}.`);

    this.runCheck(email, password, applicationIndex, preferredDateStart, preferredDateEnd)
      .finally(() => {
        if (this.isRunning) {
          this.scheduleNextRun(email, password, applicationIndex, preferredDateStart, preferredDateEnd);
        }
      });
  }

  /**
   * Planifie le cycle de recherche suivant avec un délai aléatoire (jitter de ±20%)
   * pour éviter le profilage temporel par les solutions anti-bots
   */
  private scheduleNextRun(
    email: string, 
    password: string, 
    applicationIndex: string, 
    preferredDateStart?: string, 
    preferredDateEnd?: string
  ) {
    if (!this.isRunning) return;
    if (this.scheduleTimeoutId) {
      clearTimeout(this.scheduleTimeoutId);
      this.scheduleTimeoutId = null;
    }

    // Jitter aléatoire strict de ±20% (facteur compris entre 0.80 et 1.20)
    const jitterFactor = 0.8 + Math.random() * 0.4;
    const randomizedInterval = Math.round(this.checkInterval * jitterFactor);
    this.log(`[JITTER-ANTI-BOT] Prochain cycle dans ${Math.round(randomizedInterval / 1000)}s (intervalle de base: ${Math.round(this.checkInterval / 1000)}s avec jitter aléatoire ±20%).`);

    this.scheduleTimeoutId = setTimeout(async () => {
      if (!this.isRunning) return;
      try {
        await this.runCheck(email, password, applicationIndex, preferredDateStart, preferredDateEnd);
      } finally {
        if (this.isRunning) {
          this.scheduleNextRun(email, password, applicationIndex, preferredDateStart, preferredDateEnd);
        }
      }
    }, randomizedInterval);
  }

  public async stop() {
    this.isRunning = false;
    this.status = "idle";
    if (this.scheduleTimeoutId) {
      clearTimeout(this.scheduleTimeoutId);
      this.scheduleTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        try {
          this.browser.process()?.kill("SIGKILL");
        } catch {}
      } finally {
        this.browser = null;
        this.page = null;
      }
    }
    this.currentProxy = null;
    this.log("Bot stopped.");
  }

  private async launchBrowser(forceDirect: boolean = false) {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        try {
          this.browser.process()?.kill("SIGKILL");
        } catch {}
      } finally {
        this.browser = null;
        this.page = null;
      }
    }

    this.log("Launching browser engine (Puppeteer Stealth)...");
    let activeProxy: ProxyConfig | null = null;
    if (!forceDirect) {
      this.log("[PROXY] Exécution du Health Check des proxys...");
      activeProxy = await proxyService.getNextHealthyProxy();
    }
    this.currentProxy = activeProxy;

    const proxyArgs = proxyService.getLaunchArgs(activeProxy);
    if (activeProxy) {
      this.log(`[PROXY] ✅ Proxy validé: ${activeProxy.host}:${activeProxy.port} (${activeProxy.latencyMs || 0}ms)`);
    } else {
      this.log(`[PROXY] 🌐 Mode connexion directe sécurisée (Direct Mode actif).`);
    }

    let newlyLaunchedBrowser: Browser | null = null;
    try {
      const launchOptions: any = {
        headless: true,
        protocolTimeout: 240000, 
        args: [
          "--no-sandbox", 
          "--disable-setuid-sandbox", 
          "--disable-dev-shm-usage", 
          "--disable-gpu",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-blink-features=AutomationControlled",
          "--disable-infobars",
          "--window-position=0,0",
          "--ignore-certifcate-errors",
          "--ignore-certifcate-errors-spki-list",
          "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
          ...proxyArgs
        ],
        defaultViewport: null
      };

      if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      }

      newlyLaunchedBrowser = await puppeteer.launch(launchOptions);

      this.browser = newlyLaunchedBrowser;
      this.page = await this.browser.newPage();
      this.page.setDefaultNavigationTimeout(90000);
      this.page.setDefaultTimeout(45000);

      if (activeProxy && activeProxy.username && activeProxy.password) {
        await this.page.authenticate({
          username: activeProxy.username,
          password: activeProxy.password,
        });
        this.log(`[PROXY] Authentification configurée pour ${activeProxy.username}`);
      }

      const width = 1280 + Math.floor(Math.random() * 100);
      const height = 800 + Math.floor(Math.random() * 80);
      await this.page.setViewport({ width, height });

      await this.page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9,fr-FR;q=0.8,fr;q=0.7',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      });

      this.log(`Browser engine launched (${width}x${height}).`);
    } catch (launchErr: any) {
      if (newlyLaunchedBrowser) {
        try {
          await newlyLaunchedBrowser.close();
        } catch {
          try {
            newlyLaunchedBrowser.process()?.kill("SIGKILL");
          } catch {}
        }
      }
      this.browser = null;
      this.page = null;
      throw launchErr;
    }
  }

  private async handleHumanIntervention(decision: any, screenshot: string) {
    const currentUrl = this.page ? this.page.url() : "https://visaonweb.diplomatie.be";
    const interventionData = {
      type: (decision.blockedType || "OTHER") as "OTP_SMS" | "CAPTCHA_3D" | "PAYMENT" | "BAN_OR_BLOCKED" | "OTHER",
      diagnosis: decision.diagnosis || "Intervention requise sur le site",
      explanation: decision.explanation || "Une action manuelle est exigée par le portail pour continuer.",
      recommendedAction: decision.recommendedAction || (decision.blockedType === "OTP_SMS" ? "Veuillez entrer le code reçu via la commande Telegram /otp 123456" : "Veuillez reprendre la main sur la session"),
      inputSelector: decision.inputSelector,
      coordinates: decision.coordinates,
      currentUrl,
      timestamp: new Date().toLocaleTimeString("fr-FR"),
    };

    this.status = "waiting_human_intervention";
    this.pendingIntervention = interventionData;
    this.io.emit("bot:human_intervention", { ...interventionData, screenshotBase64: screenshot });

    // Envoi de l'alerte Telegram enrichie HD avec diagnostic, explication et solution
    await telegramService.sendHumanInterventionReport({
      diagnosis: interventionData.diagnosis,
      explanation: interventionData.explanation,
      recommendedAction: interventionData.recommendedAction,
      blockedType: interventionData.type,
      currentUrl,
      screenshotBase64: screenshot,
      directAppUrl: process.env.APP_URL,
    });

    if (interventionData.type === "OTP_SMS") {
      this.log(`[HUMAN-IN-THE-LOOP] 📱 En attente du code OTP (via Telegram /otp <code> ou panneau UI) pendant 5 minutes...`);
      
      const otpCode = await new Promise<string | null>((resolve) => {
        this.pendingOtpResolver = resolve;
        setTimeout(() => {
          if (this.pendingOtpResolver === resolve) {
            this.pendingOtpResolver = null;
            resolve(null);
          }
        }, 5 * 60 * 1000);
      });

      if (!otpCode) {
        this.log(`[HUMAN-IN-THE-LOOP] ⏰ Délai d'attente OTP dépassé (5 min). Fin de l'attente.`);
        this.pendingIntervention = null;
        return;
      }

      this.log(`[HUMAN-IN-THE-LOOP] ⚡ Injection du code OTP "${otpCode}"...`);
      if (this.page) {
        let injected = false;
        if (interventionData.inputSelector) {
          try {
            await this.safeWaitForSelector(interventionData.inputSelector, 4000);
            await this.typeHumanly(interventionData.inputSelector, otpCode);
            injected = true;
          } catch {}
        }

        if (!injected) {
          const otpSelectors = [
            'input[name*="code" i]',
            'input[name*="otp" i]',
            'input[name*="sms" i]',
            'input[name*="token" i]',
            'input[id*="code" i]',
            'input[id*="otp" i]',
            'input[type="text"][maxlength="6"]',
            'input[type="number"][maxlength="6"]',
            '#verificationCode',
            '#otp',
            '.form-control',
          ];
          for (const sel of otpSelectors) {
            try {
              const el = await this.page.$(sel);
              if (el) {
                await this.typeHumanly(sel, otpCode);
                injected = true;
                break;
              }
            } catch {}
          }
        }

        if (!injected && interventionData.coordinates) {
          try {
            await this.page.mouse.click(interventionData.coordinates.x, interventionData.coordinates.y);
            await this.humanDelay(200, 400);
            for (const char of otpCode) {
              await this.page.keyboard.sendCharacter(char);
              const delay = Math.floor(Math.random() * (150 - 50 + 1)) + 50;
              await new Promise(r => setTimeout(r, delay));
            }
            injected = true;
          } catch {}
        }

        await this.humanDelay(600, 1200);
        try {
          const submitBtn = await this.page.$('button[type="submit"], input[type="submit"], button.btn-primary, button[id*="submit" i], button[id*="verify" i]');
          if (submitBtn) {
            await submitBtn.click();
          } else {
            await this.page.keyboard.press("Enter");
          }
          this.log(`[HUMAN-IN-THE-LOOP] ✅ Code OTP ${otpCode} validé ! Reprise de la navigation en autonomie.`);
        } catch (e: any) {
          this.log(`[HUMAN-IN-THE-LOOP] Soumission formulaire OTP: ${e.message}`);
        }
      }

      this.pendingIntervention = null;
      this.status = "checking";
      this.io.emit("bot:intervention_resolved", { timestamp: new Date().toISOString() });
      await this.humanDelay(3000, 5000);
    } else {
      this.log(`[HUMAN-IN-THE-LOOP] En attente de résolution manuelle (/resume sur Telegram ou bouton Reprendre dans l'UI)...`);
      await new Promise<boolean>((resolve) => {
        this.pendingResumeResolver = resolve;
        setTimeout(() => {
          if (this.pendingResumeResolver === resolve) {
            this.pendingResumeResolver = null;
            resolve(false);
          }
        }, 10 * 60 * 1000);
      });
      this.pendingIntervention = null;
      this.status = "checking";
      this.io.emit("bot:intervention_resolved", { timestamp: new Date().toISOString() });
    }
  }

  private isChecking: boolean = false;

  /**
   * Déclenche un repli exponentiel (Exponential Backoff) pour protéger la réputation IP
   * Paliers : 1ère détection = 5 min, 2ème détection = 15 min, 3ème+ détection = 60 min.
   */
  private triggerExponentialBackoff(statusCode: string, reason: string) {
    this.consecutive429or503Count++;
    let backoffMs = 300000; // 5 min
    if (this.consecutive429or503Count === 2) {
      backoffMs = 900000; // 15 min
    } else if (this.consecutive429or503Count >= 3) {
      backoffMs = 3600000; // 60 min
    }
    this.backoffUntil = Date.now() + backoffMs;
    const durationMin = Math.round(backoffMs / 60000);
    this.status = "paused_backoff";
    this.log(`[EXPONENTIAL-BACKOFF] 🛡️ Alerte HTTP ${statusCode} (${reason}). Protection de réputation IP activée: pause stricte de ${durationMin} minutes.`);

    telegramService.sendEmergencyAlert({
      reason: `Protection IP activée suite à HTTP ${statusCode}. Pause de ${durationMin} minutes pour éviter tout bannissement définitif.`,
      url: this.page ? this.page.url() : "https://visaonweb.diplomatie.be",
    }).catch(() => {});
  }

  private async runCheck(email: string, password: string, applicationIndex: string, preferredDateStart?: string, preferredDateEnd?: string) {
    if (this.isChecking) return;

    // Garde-fou Cognitif : Vérification du temps de pause Exponential Backoff
    const now = Date.now();
    if (this.backoffUntil > now) {
      const remainingMinutes = Math.ceil((this.backoffUntil - now) / 60000);
      this.log(`[EXPONENTIAL-BACKOFF] 🛡️ Pause de protection IP active (429/503). Reprise dans ${remainingMinutes} min.`);
      return;
    }

    // Verrou distribué anti-conflits pour le mode Sniper (évite que 2 workers ciblent et réservent le même créneau)
    const lockKey = `sniper:${email.trim().toLowerCase()}`;
    const lock = await LockService.acquireLock(lockKey, 180000, `Sniper check index ${applicationIndex}`);
    if (!lock.acquired) {
      this.log(`[LOCK] Cycle différé: ${lock.error || "Un autre processus réserve actuellement ce profil"}`);
      return;
    }

    this.isChecking = true;

    try {
      this.status = "checking";
      
      if (!this.browser || !this.browser.isConnected()) {
        try {
          await this.launchBrowser(false);
        } catch (launchErr: any) {
          this.log(`CRITICAL: Failed to launch browser: ${launchErr.message}`);
          throw launchErr;
        }
      }

      if (!this.page) throw new Error("Page initialization failed");

      // Restauration de session (cookies chiffrés AES-256) pour éviter ré-authentification répétitive
      const sessionKey = `visa_session:${email.trim().toLowerCase()}`;
      try {
        const sessionResult = await SessionService.restoreSession(this.page, sessionKey);
        if (sessionResult.restored) {
          this.log(`[SESSION] ${sessionResult.cookieCount} cookie(s) réinjecté(s). Tentative d'accès direct...`);
        }
      } catch (sessErr: any) {
        this.log(`[SESSION] Restauration ignorée: ${sessErr.message}`);
      }

      // Navigate to portal with proxy fallback
      this.log("Navigating to Visa on Web Login page...");
      let navSuccess = false;
      const targetLoginUrl = "https://visaonweb.diplomatie.be/en/Account/Login";

      for (let navAttempt = 1; navAttempt <= 2; navAttempt++) {
        try {
          await this.page!.goto(targetLoginUrl, { 
            waitUntil: "load",
            timeout: 60000 
          });
          navSuccess = true;
          this.log("Login page loaded successfully.");
          await this.captureScreenshot();
          break;
        } catch (navErr: any) {
          const isProxyOrTimeout = 
            navErr.message.includes("ERR_TIMED_OUT") ||
            navErr.message.includes("ERR_PROXY_") ||
            navErr.message.includes("ERR_TUNNEL_") ||
            navErr.message.includes("ERR_CONNECTION_") ||
            navErr.message.includes("net::");

          this.logRecovery("Navigation Failure", `${navErr.message} (Tentative ${navAttempt}/2)`);

          if (this.currentProxy && isProxyOrTimeout) {
            this.log(`[PROXY] Échec du proxy (${this.currentProxy.host}:${this.currentProxy.port}). Bascule immédiate en connexion directe...`);
            proxyService.markProxyFailure(this.currentProxy.server);
            await this.launchBrowser(true); // Bascule forcée en mode direct
          } else {
            await this.humanDelay(2000, 3000);
          }
        }
      }

      if (!navSuccess) {
        this.logRecovery("Cycle Aborted", "Impossible de joindre le portail Visa on Web. Cycle suspendu, nouvelle tentative au prochain intervalle.");
        return;
      }

      let maxSteps = 30; // Increased steps for more thorough AI exploration
      let currentStep = 0;
      let goalReached = false;
      let lastError: string | null = null;
      let consecutiveStuckSteps = 0;
      let lastStepUrl = "";

      while (currentStep < maxSteps && !goalReached && this.isRunning) {
        currentStep++;
        const currentUrl = this.page.url();
        await this.captureScreenshot(); // Capture at start of every step
        
        if (currentUrl === lastStepUrl) {
          consecutiveStuckSteps++;
          if (consecutiveStuckSteps >= 3) {
            await this.performReload(`Bot has been stuck on ${currentUrl} for 3 cycles with no change.`);
            await this.humanDelay(3000, 5000).catch(() => {});
            consecutiveStuckSteps = 0;
            lastStepUrl = this.page.url();
            continue;
          }
        } else {
          consecutiveStuckSteps = 0;
          lastStepUrl = currentUrl;
        }

        this.log(`CYCLE [${currentStep}/${maxSteps}]: Currently at ${currentUrl}`);
        
        await this.dismissPopups();
        
        // Auto-wait for common loading spinners
        const isSpinnerVisible = await this.page.evaluate(() => {
          const spinners = document.querySelectorAll('.spinner, .loading, .loader, #loading-image, .modal-backdrop');
          return Array.from(spinners).some(el => (el as HTMLElement).offsetParent !== null);
        });
        if (isSpinnerVisible) {
          this.log("Loading spinner detected, waiting 2s...");
          await new Promise(r => setTimeout(r, 2000));
        }
        
        // Automated Handling for Standard Pages to save AI tokens and improve speed
        const pageContent = await this.page.content();

        // 0. Detect Captcha or Blocking Emergency for immediate Telegram Alert
        const isCaptchaPresent = await this.page.evaluate(() => {
          const body = document.body;
          if (!body) return false;
          const bodyText = (body.innerText || body.textContent || "").toLowerCase();
          const hasRecaptcha = !!document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, #recaptcha, iframe[src*="hcaptcha"], .cf-turnstile');
          const hasCaptchaKeyword = bodyText.includes("solve the captcha") || bodyText.includes("security check") || bodyText.includes("unusual traffic") || bodyText.includes("prove you are human");
          return hasRecaptcha || hasCaptchaKeyword;
        }).catch(() => false);

        if (isCaptchaPresent) {
          this.log("[EMERGENCY] Captcha / Contrôle de sécurité détecté sur Visa on Web !");
          const now = Date.now();
          // Rate limit emergency alerts to once every 5 minutes to avoid spamming
          if (now - this.lastEmergencySentAt > 300000) {
            this.lastEmergencySentAt = now;
            const currentBase64 = await this.captureScreenshot();
            await telegramService.sendEmergencyAlert({
              reason: "Un Captcha ou contrôle de sécurité anti-bot a été détecté sur la page. Votre intervention manuelle est requise.",
              url: currentUrl,
              screenshotBase64: currentBase64 || undefined,
            });
            await logAppointmentBooking({
              profileName: email,
              status: "EMERGENCY_CAPTCHA",
              details: `Captcha détecté à l'adresse ${currentUrl}`,
              telegramAlertSent: true,
            });
          }
          this.io.emit("bot:emergency", {
            type: "CAPTCHA_DETECTED",
            url: currentUrl,
            message: "Captcha détecté sur Visa on Web. Veuillez résoudre le test manuellement dans la session.",
          });
          // Wait longer so user can interact
          await new Promise(r => setTimeout(r, 10000));
        }

        // 0. Handle Chrome / Browser Network Error Pages ("This site can't be reached", net::ERR_TIMED_OUT, etc.)
        const isBrowserNetworkError =
          currentUrl.startsWith("chrome-error://") ||
          currentUrl === "about:blank" ||
          pageContent.includes("This site can’t be reached") ||
          pageContent.includes("This site can't be reached") ||
          pageContent.includes("ERR_TIMED_OUT") ||
          pageContent.includes("ERR_CONNECTION_") ||
          pageContent.includes("ERR_PROXY_") ||
          pageContent.includes("ERR_TUNNEL_") ||
          pageContent.includes("net::ERR_");

        if (isBrowserNetworkError) {
          this.logRecovery("Browser Network Error", `Portail injoignable (${currentUrl}). Re-navigation vers Login...`);
          try {
            await this.page.goto("https://visaonweb.diplomatie.be/en/Account/Login", {
              waitUntil: "load",
              timeout: 60000,
            });
          } catch (err: any) {
            this.log(`Tentative de reconnexion échouée: ${err.message}`);
          }
          await this.humanDelay(3000, 5000);
          continue;
        }

        // 0. Garde-fou Cognitif : Détection 429 (Too Many Requests) ou 503 (Service Unavailable)
        const is429or503 =
          pageContent.includes("429 Too Many Requests") ||
          pageContent.includes("Too Many Requests") ||
          pageContent.includes("503 Service Unavailable") ||
          pageContent.includes("503 - Service Unavailable") ||
          pageContent.includes("Service Temporarily Unavailable") ||
          pageContent.includes("rate limit exceeded");

        if (is429or503) {
          const code = pageContent.includes("429") ? "429" : "503";
          this.triggerExponentialBackoff(code, "Portail Visa on Web saturé ou limitation de requêtes active");
          break; // Fin du cycle actuel pour laisser passer le temps d'attente exponentiel
        }

        // 0. Handle 403 or Error Pages
        if (pageContent.includes("403 - Forbidden") || pageContent.includes("403.14") || pageContent.includes("Directory Listing Forbidden") || pageContent.includes("Server Error")) {
          this.logRecovery("Backoff and Direct Redirect", `Detected error page (403/500). Navigating back to Login page.`);
          const now = Date.now();
          if (now - this.lastEmergencySentAt > 300000) {
            this.lastEmergencySentAt = now;
            await telegramService.sendEmergencyAlert({
              reason: `Erreur serveur HTTP 403 ou 500 détectée sur le portail Visa on Web.`,
              url: currentUrl,
            });
          }
          await this.humanDelay(10000, 20000);
          await this.page.goto("https://visaonweb.diplomatie.be/en/Account/Login", { waitUntil: "load" }).catch(() => {});
          await this.humanDelay(5000, 8000);
          continue;
        }
        
        // 1. Handling Login Page automatically if possible
        if (currentUrl.toLowerCase().includes("/account/login")) {
          this.log("Auto-handling Login Page...");
          try {
            const emailSelector = 'input[name="UserName"], #Email, input[name="Email"]';
            const passSelector = 'input[name="Password"], #Password';
            
            await this.safeWaitForSelector(emailSelector, 10000);
            
            await this.moveMouseHumanly(emailSelector);
            await this.typeHumanly(emailSelector, email);
            
            await this.humanDelay(500, 1500);
            
            await this.moveMouseHumanly(passSelector);
            await this.typeHumanly(passSelector, password);
            
            await this.humanDelay(800, 2000);

            const submitBtn = await this.page.$('input[type="submit"], button[type="submit"]');
            if (submitBtn) {
              await this.moveMouseHumanly('input[type="submit"], button[type="submit"]');
              try {
                await submitBtn.click();
              } catch (e) {
                await this.page.evaluate((el: any) => el.click(), submitBtn);
              }
            } else {
              await this.page.keyboard.press('Enter');
            }
            
            await this.humanDelay(5000, 8000);
            continue; 
          } catch (e: any) {
            this.log(`Auto-login failed: ${e.message}, falling back to AI.`);
          }
        }

        // 2. Handling main portal landing page - redirect to applications if needed
        const isLandingPage = currentUrl === "https://visaonweb.diplomatie.be/" || 
                             currentUrl === "https://visaonweb.diplomatie.be/en" ||
                             currentUrl === "https://visaonweb.diplomatie.be/nl" ||
                             currentUrl === "https://visaonweb.diplomatie.be/fr" ||
                             currentUrl.includes("/en/Home") ||
                             currentUrl.includes("/nl/Home") ||
                             currentUrl.includes("/fr/Home");

        if (isLandingPage) {
          this.log("On landing page, detecting session state...");
          try {
             const loginLink = await this.page.$("a[href*='Account/Login']");
             if (loginLink) {
               this.log("Session not found, moving to login...");
               await this.page.goto("https://visaonweb.diplomatie.be/en/Account/Login", { waitUntil: "networkidle2" });
               continue;
             }

             const appListLink = await this.page.$("a[href*='VisaApplication/Index']");
             if (appListLink) {
               this.log("Active session found, opening applications list...");
               // Persistance des cookies chiffrés AES-256
               const sessionKey = `visa_session:${email.trim().toLowerCase()}`;
               SessionService.saveSession(this.page, sessionKey).catch(() => {});
               try {
                 await Promise.all([
                   this.page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
                   appListLink.click().catch(async () => {
                     await this.page!.evaluate((el: any) => el.click(), appListLink);
                   })
                 ]);
               } catch (e) {
                 this.log("Click on applications list link failed, trying direct navigation.");
                 await this.page.goto("https://visaonweb.diplomatie.be/en/VisaApplication/Index", { waitUntil: "networkidle2" }).catch(() => {});
               }
             } else {
               this.log("Defaulting to direct application list navigation...");
               await this.page.goto("https://visaonweb.diplomatie.be/en/VisaApplication/Index", { waitUntil: "networkidle2" });
             }
             await new Promise(r => setTimeout(r, 4000));
             continue;
          } catch (e: any) {
             this.log(`Landing page logic failed: ${e.message}. Attempting direct jump to applications.`);
             await this.page.goto("https://visaonweb.diplomatie.be/en/VisaApplication/Index", { waitUntil: "networkidle2" }).catch(() => {});
          }
        }

        // 3. Handling Applications List page - look for calendar icon or details directly
        if (currentUrl.includes("/VisaApplication/Index")) {
          this.log(`On applications list page, looking for target application at index ${applicationIndex}...`);
          try {
            await this.page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => {});
            
            const navResult = await this.page.evaluate((index) => {
              const rows = Array.from(document.querySelectorAll('table tbody tr'));
              if (rows.length === 0) return null;
              const targetRow = rows[parseInt(index) - 1] || rows[0];
              if (!targetRow) return null;
              
              // 1. Look for appointment link / icon
              const cal = targetRow.querySelector('a[href*="Appointment"], [title*="Appointment" i], [title*="Rendez-vous" i], [title*="Afspraak" i], .fa-calendar, .fa-calendar-alt') as HTMLElement;
              if (cal) {
                const anchor = cal.tagName === 'A' ? (cal as HTMLAnchorElement) : cal.closest('a');
                if (anchor && anchor.href && !anchor.href.endsWith('#')) {
                  return { type: 'Appointment', url: anchor.href };
                }
              }
              
              // 2. Look for details link / icon
              const det = targetRow.querySelector('a[href*="Details"], a[href*="Consult"], [title*="Details" i], [title*="Consulter" i], .fa-search, .fa-eye') as HTMLElement;
              if (det) {
                const anchor = det.tagName === 'A' ? (det as HTMLAnchorElement) : det.closest('a');
                if (anchor && anchor.href && !anchor.href.endsWith('#')) {
                  return { type: 'Details', url: anchor.href };
                }
              }

              // 3. Any anchor in the action column
              const lastTdLink = targetRow.querySelector('td:last-child a') as HTMLAnchorElement;
              if (lastTdLink && lastTdLink.href && !lastTdLink.href.endsWith('#')) {
                return { type: 'Action Link', url: lastTdLink.href };
              }

              return null;
            }, applicationIndex);

            if (navResult && navResult.url) {
              this.log(`Detected application ${navResult.type} link: ${navResult.url}. Navigating directly...`);
              await this.page.goto(navResult.url, { waitUntil: "networkidle2", timeout: 45000 }).catch(async () => {
                await this.page?.goto(navResult.url, { waitUntil: "load", timeout: 45000 });
              });
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
          } catch (listErr: any) {
            this.log(`Auto-list handling failed: ${listErr.message}. Falling back to AI.`);
          }
        }

        // 4. Handling Application Details page - automatically go to Appointment tab
        if (currentUrl.includes("/VisaApplication/Details/")) {
          this.log("Inside application details, navigating to Appointment tab...");
          try {
            const apptTabUrl = await this.page.evaluate(() => {
              const activeTab = document.querySelector('li.active a[href*="Appointment"]');
              if (activeTab) return 'already_active';
              
              const tab = document.querySelector('a[href*="Appointment"]') as HTMLAnchorElement;
              if (tab && tab.href && !tab.href.endsWith('#')) {
                return tab.href;
              }
              return null;
            });

            if (apptTabUrl && apptTabUrl !== 'already_active') {
              this.log(`Navigating directly to Appointment tab: ${apptTabUrl}`);
              await this.page.goto(apptTabUrl, { waitUntil: "networkidle2", timeout: 45000 }).catch(async () => {
                await this.page?.goto(apptTabUrl, { waitUntil: "load", timeout: 45000 });
              });
              await new Promise(r => setTimeout(r, 3000));
              continue;
            }
          } catch (detailsErr: any) {
             this.log(`Notice in details: ${detailsErr.message}`);
          }
        }

        // 4. AUTO-RÉPARATION (SELF-HEALING) : Utilisation des sélecteurs / coordonnées mémorisés en boucle rapide
        const routeKey = currentUrl.split('?')[0];
        const healed = this.selfHealedElements.get(routeKey);
        if (healed && healed.successCount > 0 && (Date.now() - healed.lastUsed < 3600000)) {
          this.log(`[SELF-HEALING] ⚡ Tentative ultra-rapide avec le sélecteur auto-réparé : ${healed.selector || `(${healed.coordinates?.x}, ${healed.coordinates?.y})`}`);
          let healedSuccess = false;
          if (healed.selector) {
            try {
              const el = await this.safeWaitForSelector(healed.selector, 2000);
              if (el) {
                await this.humanDelay(300, 700);
                await el.click();
                healedSuccess = true;
                healed.successCount++;
                healed.lastUsed = Date.now();
                this.log(`[SELF-HEALING] ✅ Succès du sélecteur auto-réparé ! Navigation immédiate.`);
                await this.humanDelay(2000, 3500);
                continue;
              }
            } catch {
              this.log(`[SELF-HEALING] Sélecteur mémorisé non trouvé, ré-analyse requise.`);
              this.selfHealedElements.delete(routeKey);
            }
          } else if (healed.coordinates) {
            try {
              await this.humanDelay(300, 700);
              await this.page.mouse.click(healed.coordinates.x, healed.coordinates.y);
              healedSuccess = true;
              healed.successCount++;
              healed.lastUsed = Date.now();
              this.log(`[SELF-HEALING] ✅ Clic réussi aux coordonnées spatiales auto-réparées !`);
              await this.humanDelay(2000, 3500);
              continue;
            } catch {
              this.selfHealedElements.delete(routeKey);
            }
          }
        }

        // 5. SNIPER MODE (PUR CODE FAST-TRACK < 500ms): Détection et réservation directe sans latence IA
        if (this.sniperMode && (currentUrl.includes("/Appointment") || currentUrl.includes("/VisaApplication/Details/"))) {
          try {
            const sniperAction = await this.page.evaluate((pStart, pEnd) => {
              // A. Bouton "Prendre un rendez-vous" / "Take an appointment"
              const takeApptBtn = document.querySelector(
                'a[href*="MakeAppointment"], a[href*="TakeAppointment"], button[name*="Take"], a.btn-primary[href*="Appointment"], input[value*="rendez-vous" i], input[value*="appointment" i]'
              ) as HTMLElement;
              if (takeApptBtn) {
                takeApptBtn.click();
                return { action: "clicked_take_appointment", message: "Bouton 'Prendre un rendez-vous' cliqué en code pur (<100ms)" };
              }

              // B. Détection des créneaux horaires ou confirmation finale
              // Bouton de confirmation / validation finale
              const confirmBtn = document.querySelector(
                'button[type="submit"][name*="Book" i], button[type="submit"][name*="Save" i], button[type="submit"][name*="Confirm" i], input[type="submit"][value*="Confirmer" i], input[type="submit"][value*="Book" i], input[type="submit"][value*="Save" i]'
              ) as HTMLElement;

              // Radio ou sélection de slot horaire
              const slotRadio = document.querySelector(
                'input[type="radio"][name*="Slot" i]:not(:disabled), input[type="radio"][name*="Hour" i]:not(:disabled), input[type="radio"][name*="Time" i]:not(:disabled), .slot-item:not(.disabled) input[type="radio"]'
              ) as HTMLInputElement;

              if (slotRadio && !slotRadio.checked) {
                slotRadio.checked = true;
                slotRadio.dispatchEvent(new Event('change', { bubbles: true }));
                if (confirmBtn) {
                  confirmBtn.click();
                  return { action: "booked_slot", message: "Créneau sélectionné et réservation confirmée en mode Sniper pur (<200ms) !" };
                }
                return { action: "selected_slot", message: "Créneau horaire sélectionné en mode Sniper" };
              }

              if (confirmBtn) {
                confirmBtn.click();
                return { action: "clicked_confirm", message: "Confirmation finale de réservation envoyée en code pur" };
              }

              // C. Détection directe de date disponible dans le calendrier
              const availableDateElements = Array.from(document.querySelectorAll(
                'td.available a, td.free a, .calendar-day.available a, a[data-date], a[data-handler="selectDay"], a.ui-state-default:not(.ui-state-disabled)'
              )) as HTMLAnchorElement[];

              if (availableDateElements.length > 0) {
                const targetLink = availableDateElements[0];
                const dateText = targetLink.getAttribute("data-date") || targetLink.innerText || "date_disponible";
                targetLink.click();
                return { action: "clicked_date", message: `Date disponible cliquée instantanément (<100ms) : ${dateText}` };
              }

              return null;
            }, preferredDateStart, preferredDateEnd);

            if (sniperAction) {
              this.log(`[SNIPER FAST-TRACK] ⚡ ${sniperAction.message}`);
              await new Promise(r => setTimeout(r, 2000));
              continue; // Ré-analyse immédiate de la page suivante sans appeler l'IA vision
            }
          } catch (sniperErr: any) {
            this.log(`[SNIPER FAST-TRACK] Notice: ${sniperErr.message}. Passage au mode d'analyse IA.`);
          }
        }

        // Analyse Visuelle & Guidage IA : capture de la page dès que le bot avance ou hésite
        const screenshot = await this.captureScreenshot(); 
        if (!screenshot) {
          this.log("[AI-Loop] Snapshot unavailable; waiting momentarily before retrying step...");
          await this.humanDelay(2000, 3000);
          continue;
        }

        const viewportInfo = this.page ? (await this.page.viewport()) : { width: 1280, height: 800 };
        const vWidth = viewportInfo?.width || 1280;
        const vHeight = viewportInfo?.height || 800;

        const prompt = `
          Tu es le pilote et guide IA expert (Vision & Guidance) chargé de la navigation autonome et de la réservation prioritaire de rendez-vous visa sur le portail Visa on Web (https://visaonweb.diplomatie.be).

          CONTEXTE DU PILOTE :
          "Voici l'état actuel pour la recherche du RDV Visa. Quel est l'élément visuel sur lequel cliquer ou le champ à remplir pour avancer ?"

          URL ACTUELLE : ${currentUrl}
          Index de la demande à traiter : ${applicationIndex}
          Email demandeur : ${email}
          Plage de dates souhaitée : ${preferredDateStart || 'Dès que possible'} à ${preferredDateEnd || 'Dès que possible'}
          Résolution de l'écran analysé : ${vWidth}x${vHeight} pixels.
          ${lastError ? `ÉCHEC DE L'ACTION PRÉCÉDENTE : ${lastError}. Utilise une autre méthode ou privilégie les coordonnées visuelles directes {x, y}.` : ""}

          MISSION #1 : PRIORITÉ ABSOLUE AU CRÉNEAU (MODE CHASSEUR / SNIPER)
          - Si tu repères un calendrier avec des créneaux ouverts / dates disponibles (dates cliquables en vert, surlignées, bleues ou actives non grisées) :
            ORDRE PRIORITAIRE ABSOLU : Donne l'ordre immédiat de cliquer sur la PREMIÈRE date disponible pour sécuriser le RDV !
            Format : { "action": "click", "selector": "sélecteur_de_la_date", "coordinates": { "x": pixel_X, "y": pixel_Y }, "reason": "MODE CHASSEUR : Clic immédiat sur le premier créneau disponible" }
          - Si une liste d'horaires/slots est visible : clique immédiatement sur le premier horaire disponible puis sur le bouton de confirmation/réservation ("Confirm", "Book", "Save", "Enregistrer").

          MISSION #2 : ESCALADE TELEGRAM AVEC RAPPORT ET SOLUTION (HUMAN-IN-THE-LOOP)
          - Si la page requiert obligatoirement une intervention humaine :
            1. Code OTP / SMS de sécurité reçu sur téléphone ou email ("Enter SMS code", "Verification code", "Code envoyé par SMS", "Two-factor")
            2. Captcha 3D ou challenge interactif complexe (reCAPTCHA v2/v3 cases à cocher images, hCaptcha, Turnstile)
            3. Étape de paiement bancaire en ligne (saisie carte bancaire, 3D Secure)
            4. Bannissement ou blocage d'accès ("Access Denied", "IP blocked", "403 Forbidden")
          - Dans ce cas, NE CLIQUE PAS AU HASARD. Renvoie STRICTEMENT cette action d'escalade :
          {
            "action": "human_intervention",
            "blockedType": "OTP_SMS" | "CAPTCHA_3D" | "PAYMENT" | "BAN_OR_BLOCKED" | "OTHER",
            "diagnosis": "Diagnostic précis (ex: Blocage : Le site demande une validation par code SMS envoyé sur votre numéro)",
            "explanation": "Explication claire de ce qui bloque à l'écran",
            "recommendedAction": "Action recommandée (ex: Veuillez entrer le code reçu via la commande Telegram /otp 123456 ou reprendre la main sur la session)",
            "inputSelector": "sélecteur_champ_code_si_disponible",
            "coordinates": { "x": pixel_X, "y": pixel_Y },
            "reason": "Intervention humaine requise"
          }

          MISSION #3 : NAVIGATION DYNAMIQUE & GUIDAGE VISUEL
          - Si le bouton a été modifié, si une modal inattendue surgit ou s'il s'agit d'une nouvelle étape :
            Renvoie les coordonnées visuelles précises en pixels sur l'image : { "x": pixel_X, "y": pixel_Y } ET optionnellement un sélecteur CSS standard (ATTENTION : utilise UNIQUEMENT des sélecteurs CSS standard valides tels que a[href*="..."], button.btn, tr:nth-child(n), SANS pseudo-classes jQuery invalides comme :contains).
            - Clic : { "action": "click", "selector": "CSS_SELECTOR_STANDARD", "coordinates": { "x": X, "y": Y }, "confidenceScore": 95, "reason": "Pourquoi cliquer ici" }
            - Remplir champ : { "action": "type", "selector": "CSS_SELECTOR_STANDARD", "coordinates": { "x": X, "y": Y }, "text": "TEXTE", "confidenceScore": 95, "reason": "Pourquoi" }
            - Patienter : { "action": "wait", "ms": 2500, "reason": "Chargement en cours" }
            - Naviguer : { "action": "navigate", "url": "URL", "reason": "Pourquoi" }
            - Confirmation finale de succès : { "action": "success", "message": "RDV confirmé", "details": { "date": "...", "time": "...", "location": "...", "referenceNumber": "..." }, "reason": "Rendez-vous finalisé" }

          MISSION #4 : GESTION DES IMPRÉVUS (POPUPS, COOKIES, AVIS CONSULAIRES & MODALES)
          - Si une superposition inattendue bloque la page (bannière de cookies, pop-up d'information consulaire, modal d'avertissement, captcha simple à case) :
            Identifie immédiatement le bouton de fermeture ou d'acceptation ("Accepter", "Close", "OK", "×", "Compris", "Continuer") :
            Format : { "action": "dismiss_overlay", "selector": "sélecteur_bouton", "coordinates": { "x": pixel_X, "y": pixel_Y }, "confidenceScore": 95, "reason": "Fermeture pop-up ou consentement" }

          RÈGLE DE L'HUMILITÉ (CONFIDENCE SCORE) :
          - Inclus toujours le champ "confidenceScore" (nombre entier de 0 à 100).
          - Si ton niveau de certitude visuelle est inférieur à 85 %, le bot appliquera la Règle de l'Humilité : interdiction de cliquer, gel de session et transmission directe à l'humain sur Telegram. Sois rigoureux et prudent.

          CHAMP OPTIONNEL :
          - "availableDates": ["YYYY-MM-DD", ...] si tu détectes des dates ouvertes sur le calendrier.

          RÉPONDS UNIQUEMENT PAR UN OBJET JSON STRICT SANS COMMENTAIRE HORS DU JSON.
        `;

        const decision = await this.askAI(prompt, screenshot);
        if (!decision || !decision.action) {
          this.log("AI failed to provide a valid action. Increasing delay and retrying...");
          await new Promise(r => setTimeout(r, 15000)); // Longer delay if AI fails (quota management)
          continue;
        }

      this.log(`AI Decision [Step ${currentStep}]: ${decision.reason}`);
      
      // Emit available dates found by AI
      if (decision.availableDates && Array.isArray(decision.availableDates) && decision.availableDates.length > 0) {
        this.log(`AI detected ${decision.availableDates.length} available dates.`);
        this.io.emit("bot:available_dates", decision.availableDates);
      }

      try {
        if (!this.isRunning || !this.page) {
          this.log("Bot stopped during execution. Ending current check.");
          break;
        }
        
        lastError = null;

        // Règle de l'Humilité (Strict Handoff si confiance < 85%)
        const confidenceScore = typeof decision.confidenceScore === "number" ? decision.confidenceScore : 90;
        if (confidenceScore < 85 && decision.action !== "wait" && decision.action !== "success" && decision.action !== "human_intervention") {
          this.log(`[RÈGLE DE L'HUMILITÉ] 🛑 Indice de certitude IA insuffisant (${confidenceScore}% < 85%). Interdiction stricte de cliquer & gel du navigateur.`);
          await this.handleHumanIntervention({
            type: "OTHER",
            diagnosis: `Hésitation IA : Confiance visuelle à ${confidenceScore}% (seuil de sécurité : 85%)`,
            explanation: `L'IA hésite face à la disposition de la page (${decision.reason}) et refuse de cliquer au hasard afin de préserver votre dossier.`,
            recommendedAction: "Veuillez examiner la capture d'écran HD et confirmer l'action requise ou reprendre la session.",
            coordinates: decision.coordinates,
            inputSelector: decision.selector,
            currentUrl
          }, screenshot);
          break;
        }

        // Garde-fou Cognitif : Le "Doute Humain" (Human Jitter)
        // Entre la lecture d'écran et l'action physique, délai aléatoire de réaction humaine (800ms à 2200ms)
        if (decision.action === "click" || decision.action === "type" || decision.action === "dismiss_overlay") {
          await this.humanDelay(800, 2200);
        }

        switch (decision.action) {
          case "dismiss_overlay":
            this.log(`[IMPRÉVU] 🛡️ Fermeture de pop-up / avertissement / superposition: ${decision.reason}`);
            let overlayDismissed = false;
            if (decision.selector) {
              try {
                await this.safeWaitForSelector(decision.selector, 3000);
                await this.page.click(decision.selector);
                overlayDismissed = true;
              } catch {}
            }
            if (!overlayDismissed && decision.coordinates && typeof decision.coordinates.x === "number" && typeof decision.coordinates.y === "number") {
              let targetX = decision.coordinates.x;
              let targetY = decision.coordinates.y;
              if (targetX <= 1000 && targetX > 0 && targetY <= 1000 && targetY > 0 && (vWidth > 1000 || vHeight > 1000)) {
                targetX = Math.round((targetX / 1000) * vWidth);
                targetY = Math.round((targetY / 1000) * vHeight);
              }
              await this.page.mouse.click(targetX, targetY);
              overlayDismissed = true;
            }
            this.log(`[IMPRÉVU] ✅ Superposition fermée avec succès. Reprise de la recherche de rendez-vous.`);
            await this.humanDelay(1500, 2500);
            continue;

          case "human_intervention":
            this.log(`🚨 [HUMAN-IN-THE-LOOP] Détection: ${decision.diagnosis || decision.reason}`);
            await this.handleHumanIntervention(decision, screenshot);
            break;

          case "click":
            this.log(`Action: Clicking ${decision.selector || (decision.coordinates ? `coordinates (${decision.coordinates.x}, ${decision.coordinates.y})` : "element")}`);
            if (!this.page) break;
            let clickSuccess = false;

            // 1. Essai prioritaire via le sélecteur CSS ou matching textuel DOM
            if (decision.selector) {
              const rawSelector = decision.selector.trim();
              
              // Nettoyer les pseudo-classes jQuery invalides en CSS natif (ex: :contains('...'))
              const containsMatch = rawSelector.match(/:contains\(['"]?([^'"]+)['"]?\)/i);
              const textFilter = containsMatch ? containsMatch[1] : null;
              const cleanSelector = rawSelector.replace(/:contains\(['"]?[^'"]*['"]?\)/gi, "").trim() || "*";

              try {
                // Si le sélecteur contenait :contains ou s'il s'agit d'un lien textuel
                if (textFilter) {
                  const foundEl = await this.page.evaluate((sel, txt) => {
                    const candidates = Array.from(document.querySelectorAll(sel));
                    for (const cand of candidates) {
                      if (cand.textContent && cand.textContent.includes(txt)) {
                        const target = cand.tagName === 'A' || cand.tagName === 'BUTTON' ? cand : (cand.querySelector('a, button') || cand);
                        (target as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                        return true;
                      }
                    }
                    return false;
                  }, cleanSelector, textFilter);

                  if (foundEl) {
                    await this.humanDelay(200, 400);
                    // Clic direct via DOM
                    await this.page.evaluate((sel, txt) => {
                      const candidates = Array.from(document.querySelectorAll(sel));
                      for (const cand of candidates) {
                        if (cand.textContent && cand.textContent.includes(txt)) {
                          const target = cand.tagName === 'A' || cand.tagName === 'BUTTON' ? cand : (cand.querySelector('a, button') || cand);
                          (target as HTMLElement).click();
                          break;
                        }
                      }
                    }, cleanSelector, textFilter);
                    clickSuccess = true;
                  }
                } else {
                  await this.safeWaitForSelector(cleanSelector, 4000);
                  
                  await this.page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) (el as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                  }, cleanSelector);
                  
                  await this.humanDelay(150, 350);
                  await this.moveMouseHumanly(cleanSelector);
                  await this.humanDelay(100, 250);

                  const elHandle = await this.page.$(cleanSelector);
                  if (elHandle) {
                    await elHandle.click({ delay: Math.floor(Math.random() * 60 + 20) });
                    clickSuccess = true;
                  }
                }
              } catch (clickErr: any) {
                // Essayer de trouver un élément contenant le texte ou un bouton similaire dans le DOM
                try {
                  const fallbackFound = await this.page.evaluate((sel) => {
                    // Si le sélecteur contient un href partiel
                    const hrefMatch = sel.match(/href\*?=['"]?([^'"]+)['"]?/);
                    if (hrefMatch && hrefMatch[1]) {
                      const link = document.querySelector(`a[href*="${hrefMatch[1]}"]`) as HTMLElement;
                      if (link) {
                        link.click();
                        return true;
                      }
                    }
                    return false;
                  }, rawSelector);
                  if (fallbackFound) {
                    clickSuccess = true;
                  }
                } catch {}

                if (!clickSuccess) {
                  this.log(`Sélecteur standard non trouvé (${clickErr.message}). Bascule vers le guidage visuel IA par coordonnées...`);
                }
              }
            }

            // 2. Guidage IA par Coordonnées Visuelles directes ({x, y})
            if (!clickSuccess && decision.coordinates && typeof decision.coordinates.x === "number" && typeof decision.coordinates.y === "number") {
              try {
                let targetX = decision.coordinates.x;
                let targetY = decision.coordinates.y;

                // Normalisation si l'IA renvoie une échelle 0-1000
                if (targetX <= 1000 && targetX > 0 && targetY <= 1000 && targetY > 0 && (vWidth > 1000 || vHeight > 1000)) {
                  targetX = Math.round((targetX / 1000) * vWidth);
                  targetY = Math.round((targetY / 1000) * vHeight);
                }

                this.log(`[PILOTE IA] Clic direct aux coordonnées visuelles (${targetX}, ${targetY})...`);
                await this.page.mouse.move(targetX - 4, targetY - 3, { steps: 5 });
                await this.humanDelay(100, 200);
                await this.page.mouse.click(targetX, targetY);
                clickSuccess = true;
              } catch (coordErr: any) {
                this.log(`Échec clic coordonnées visuelles: ${coordErr.message}`);
              }
            }

            // 3. Fallback DOM dispatch si le clic Puppeteer n'a pas déclenché la navigation
            if (!clickSuccess && decision.selector) {
              const anchorUrl = await this.page.evaluate((sel) => {
                const el = document.querySelector(sel) as HTMLElement;
                if (el) {
                  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                  el.click();

                  const anchor = el.tagName === 'A' ? (el as HTMLAnchorElement) : el.closest('a');
                  if (anchor && anchor.href && !anchor.href.endsWith('#') && !anchor.href.startsWith('javascript:')) {
                    return anchor.href;
                  }
                }
                return null;
              }, decision.selector);

              if (anchorUrl && !this.page.url().includes(anchorUrl)) {
                setTimeout(async () => {
                  try {
                    if (this.page && this.page.url() !== anchorUrl) {
                      await this.page.goto(anchorUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                    }
                  } catch (e) {}
                }, 1500);
              }
            }

            // Auto-réparation des Sélecteurs (Self-Healing Memory) :
            // Si le clic a fonctionné (via sélecteur ou coordonnées spatiales), on extrait et stocke
            // l'élément cliqué dans la mémoire vive pour accélérer les prochains cycles Sniper sans solliciter l'IA.
            if (clickSuccess) {
              try {
                const routeKey = currentUrl.split('?')[0];
                let healedSelector = decision.selector;
                const coordX = decision.coordinates?.x;
                const coordY = decision.coordinates?.y;

                if (!healedSelector && typeof coordX === "number" && typeof coordY === "number" && this.page) {
                  healedSelector = await this.page.evaluate((x, y) => {
                    const el = document.elementFromPoint(x, y);
                    if (!el) return null;
                    if (el.id) return `#${el.id}`;
                    if (el.getAttribute("name")) return `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
                    const btn = el.closest("button, a, input[type='submit'], input[type='radio']");
                    if (btn) {
                      if (btn.id) return `#${btn.id}`;
                      if (btn.getAttribute("name")) return `${btn.tagName.toLowerCase()}[name="${btn.getAttribute("name")}"]`;
                      const cls = Array.from(btn.classList).filter(c => !c.includes("hover") && !c.includes("focus") && !c.includes("active")).join(".");
                      if (cls) return `${btn.tagName.toLowerCase()}.${cls}`;
                    }
                    return null;
                  }, coordX, coordY).catch(() => null);
                }

                if (healedSelector || (coordX && coordY)) {
                  const prev = this.selfHealedElements.get(routeKey);
                  this.selfHealedElements.set(routeKey, {
                    selector: healedSelector || undefined,
                    coordinates: (coordX && coordY) ? { x: coordX, y: coordY } : undefined,
                    actionType: "click",
                    successCount: (prev?.successCount || 0) + 1,
                    lastUsed: Date.now()
                  });
                  this.log(`[SELF-HEALING] 🧠 Signature auto-réparée mémorisée pour ${routeKey} : ${healedSelector || `(${coordX}, ${coordY})`}`);
                }
              } catch (shErr: any) {
                this.log(`[SELF-HEALING] Notice d'extraction: ${shErr.message}`);
              }
            }

            await this.humanDelay(2500, 5000); // Attente pour chargement / animation
            break;

          case "type":
            this.log(`Action: Typing into ${decision.selector || "coordinates field"}`);
            if (!this.page) break;
            let typeSuccess = false;

            if (decision.selector) {
              try {
                await this.moveMouseHumanly(decision.selector);
                await this.typeHumanly(decision.selector, decision.text);
                typeSuccess = true;
              } catch (typeErr: any) {
                this.log(`Champ sélecteur non trouvé, tentative par coordonnées visuelles...`);
              }
            }

            if (!typeSuccess && decision.coordinates && typeof decision.coordinates.x === "number") {
              try {
                await this.page.mouse.click(decision.coordinates.x, decision.coordinates.y);
                await this.humanDelay(200, 400);
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('KeyA');
                await this.page.keyboard.up('Control');
                await this.page.keyboard.press('Backspace');
                for (const char of decision.text) {
                  await this.page.keyboard.sendCharacter(char);
                  const delay = Math.floor(Math.random() * (150 - 50 + 1)) + 50;
                  await new Promise(r => setTimeout(r, delay));
                }
                typeSuccess = true;
              } catch (coordTypeErr: any) {
                this.log(`Échec saisie aux coordonnées: ${coordTypeErr.message}`);
              }
            }
            break;

          case "wait":
            this.log(`Action: Waiting for ${decision.ms || 2000}ms`);
            await this.humanDelay(decision.ms || 2000, (decision.ms || 2000) + 1000);
            break;

          case "navigate":
            this.log(`Action: Navigating to ${decision.url}`);
            if (!this.page) break;
            await this.page.goto(decision.url, { waitUntil: "networkidle2", timeout: 60000 });
            break;

          case "success":
            this.log(`!!! SUCCESS !!! ${decision.message}`);
            this.io.emit("bot:success", { message: decision.message, details: decision.details });
            goalReached = true;
            this.status = "success";

            // Telegram Alert (Succès - Rendez-vous pris)
            (async () => {
              try {
                const finalScreenshot = await this.captureScreenshot();
                await telegramService.sendSuccessAlert({
                  appointmentDate: decision.details?.date || "Non spécifiée",
                  appointmentTime: decision.details?.time || "Non spécifiée",
                  location: decision.details?.location || "Centre Visa (Visa on Web)",
                  referenceNumber: decision.details?.referenceNumber || "Généré sur le portail",
                  applicantName: email,
                  screenshotBase64: finalScreenshot || undefined,
                });
                await logAppointmentBooking({
                  profileName: email,
                  status: "CONFIRMED",
                  appointmentDate: decision.details?.date,
                  appointmentTime: decision.details?.time,
                  referenceNumber: decision.details?.referenceNumber,
                  telegramAlertSent: true,
                  details: JSON.stringify(decision.details || {}),
                });
              } catch (alertErr: any) {
                this.log(`[ALERT] Error sending success Telegram alert: ${alertErr.message}`);
              }
            })();

            this.stop();
            break;

          case "error":
            this.log(`AI reported an error: ${decision.message}`);
            throw new Error(decision.message);
        }
      } catch (err: any) {
        lastError = err.message;
        const currentUrl = this.page ? this.page.url() : "unknown";
        await this.captureScreenshot();
        this.logRecovery("Error Recovery", `Action failed: ${err.message}. Retrying next cycle...`);
        this.handleErrorCount(err.message);
      }

        await new Promise(r => setTimeout(r, 1000));
      }

      if (!goalReached && currentStep >= maxSteps) {
        this.log("Max steps reached without achieving goal. Will retry in 5 minutes.");
        this.status = "waiting";
      }

    } catch (error: any) {
      const currentUrl = this.page ? this.page.url() : "unknown";
      await this.captureScreenshot();
      this.log(`CRITICAL ERROR at ${currentUrl}: ${error.message}`);
      this.status = "error";
      this.handleErrorCount(error.message);
    } finally {
      this.isChecking = false;
      await LockService.releaseLock(lockKey).catch(() => {});
      // Encapsulation try/finally pour forcer await browser.close() et libérer la mémoire Chromium
      if (this.browser) {
        try {
          this.log("[MEMORY] Fermeture propre de l'instance Puppeteer pour libérer les ressources...");
          await this.browser.close();
        } catch (closeErr: any) {
          try {
            this.browser.process()?.kill("SIGKILL");
          } catch {}
        } finally {
          this.browser = null;
          this.page = null;
        }
      }
    }
  }
}
`nexport function startBot() { console.log("Bot service initialized"); }
