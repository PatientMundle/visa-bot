import axios from "axios";
import FormData from "form-data";

export interface TelegramAlertOptions {
  botToken?: string;
  chatId?: string;
}

export class TelegramService {
  private botToken: string;
  private chatId: string;
  // Limiteur de fréquence (anti-spam / debounce) pour les alertes d'erreur/urgence
  private lastAlertTimestamp: number = 0;
  private lastAlertReason: string = "";
  private readonly ERROR_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes entre deux alertes similaires

  constructor(botToken?: string, chatId?: string) {
    this.botToken = (botToken || process.env.TELEGRAM_BOT_TOKEN || "").trim();
    this.chatId = (chatId || process.env.TELEGRAM_CHAT_ID || "").trim();
  }

  public updateCredentials(botToken: string, chatId: string) {
    this.botToken = (botToken || "").trim();
    this.chatId = (chatId || "").trim();
  }

  public isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  /**
   * Alerte de Succès : Rendez-vous réservé avec succès en mode Sniper (Non soumis au debounce).
   */
  public async sendSuccessAlert(data: {
    applicantName?: string;
    appointmentDate: string;
    appointmentTime?: string;
    referenceNumber?: string;
    location?: string;
    screenshotBase64?: string;
    details?: string;
  }): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn("[TELEGRAM] Non configuré : TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID manquant.");
      return false;
    }

    const text = 
`🎯 <b>[VISA BOT] RENDEZ-VOUS RÉSERVÉ AVEC SUCCÈS !</b> 🇧🇪

✅ <b>Statut :</b> Réservation automatique confirmée (Mode Sniper)
👤 <b>Demandeur :</b> ${data.applicantName || "Compte principal"}
📅 <b>Date :</b> ${data.appointmentDate}
⏰ <b>Heure :</b> ${data.appointmentTime || "Non spécifiée"}
📍 <b>Centre :</b> ${data.location || "Centre Visa (Visa on Web)"}
📄 <b>Référence :</b> <code>${data.referenceNumber || "Générée sur le portail"}</code>

<i>${data.details || "La confirmation a été finalisée sur Visa on Web. Veuillez vérifier vos emails pour la convocation officielle."}</i>

⚡ <i>Automate Visa 24/7 en production</i>`;

    if (data.screenshotBase64) {
      return this.sendPhoto(data.screenshotBase64, text);
    }
    return this.sendMessage(text);
  }

  /**
   * Alerte d'Urgence : Blocage nécessitant une intervention manuelle immédiate.
   * Intègre un limiteur de fréquence (Debounce) pour éviter que le bot Telegram ne soit banni pour spam.
   */
  public async sendEmergencyAlert(data: {
    reason: string;
    url?: string;
    screenshotBase64?: string;
    directAppUrl?: string;
    force?: boolean;
  }): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn("[TELEGRAM] Non configuré pour alerte d'urgence.");
      return false;
    }

    const now = Date.now();
    const isSameReason = this.lastAlertReason === data.reason;
    const timeSinceLastAlert = now - this.lastAlertTimestamp;

    // Débouncing anti-spam : bloque si la même alerte a été envoyée il y a moins de 10 min
    if (!data.force && isSameReason && timeSinceLastAlert < this.ERROR_DEBOUNCE_MS) {
      const remainingMin = Math.ceil((this.ERROR_DEBOUNCE_MS - timeSinceLastAlert) / 60000);
      console.log(`[TELEGRAM DEBOUNCE] Alerte similaire bloquée pour éviter le spam (${remainingMin} min d'attente restante).`);
      return false;
    }

    this.lastAlertTimestamp = now;
    this.lastAlertReason = data.reason;

    const text = 
`🚨 <b>[VISA BOT - URGENCE] INTERVENTION MANUELLE REQUISE !</b>

⚠️ <b>Motif du blocage :</b> ${data.reason}
🔗 <b>Page concernée :</b> <code>${data.url || "Portail Visa on Web"}</code>
🕒 <b>Heure de l'alerte :</b> ${new Date().toLocaleTimeString("fr-FR")}

👉 <b>Action requise :</b> Ouvrez immédiatement le tableau de bord pour reprendre la main manuellement ou résoudre le Captcha.
${data.directAppUrl ? `🌐 <b>Accès console :</b> <a href="${data.directAppUrl}">Ouvrir le panneau du bot</a>` : ""}`;

    if (data.screenshotBase64) {
      return this.sendPhoto(data.screenshotBase64, text);
    } else {
      return this.sendMessage(text);
    }
  }

  /**
   * Escalade Telegram avec Rapport et Solution (Human-in-the-Loop).
   * Envoie la capture d'écran exacte du problème visuel, l'explication rédigée par l'IA,
   * et la solution / action recommandée (ex: /otp 123456).
   */
  public async sendHumanInterventionReport(data: {
    diagnosis: string;
    explanation: string;
    recommendedAction: string;
    blockedType: "OTP_SMS" | "CAPTCHA_3D" | "PAYMENT" | "BAN_OR_BLOCKED" | "OTHER";
    currentUrl?: string;
    screenshotBase64?: string;
    directAppUrl?: string;
  }): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn("[TELEGRAM] Non configuré pour le rapport d'intervention humaine.");
      return false;
    }

    const typeIcons: Record<string, string> = {
      OTP_SMS: "📱 CODE OTP / SMS REQUIS",
      CAPTCHA_3D: "🧩 CAPTCHA COMPLEXE / 3D DÉTECTÉ",
      PAYMENT: "💳 ÉTAPE DE PAIEMENT REQUISE",
      BAN_OR_BLOCKED: "🚫 BANNISSEMENT OU ACCÈS BLOQUÉ",
      OTHER: "⚠️ ACTION HUMAINE REQUISE",
    };

    const typeHeader = typeIcons[data.blockedType] || "⚠️ ACTION HUMAINE REQUISE";

    const text = 
`🚨 <b>[VISA BOT - PILOTE IA] INTERVENTION REQUISE</b>

🛡️ <b>Type :</b> <b>${typeHeader}</b>
🔍 <b>Diagnostic IA :</b> ${data.diagnosis}

📝 <b>Explication IA :</b>
<i>${data.explanation}</i>

💡 <b>Solution / Action Recommandée :</b>
<b>${data.recommendedAction}</b>

🔗 <b>Page :</b> <code>${this.urlShort(data.currentUrl)}</code>
🕒 <b>Heure :</b> ${new Date().toLocaleTimeString("fr-FR")}

${data.blockedType === "OTP_SMS" ? 
`📲 <b>POUR INJECTER VOTRE CODE IMMÉDIATEMENT :</b>
Répondez directement à ce bot avec la commande :
<code>/otp VOTRE_CODE</code>  <i>(ex: <code>/otp 123456</code>)</i>
Le bot reprendra automatiquement sa navigation !` : 
`👉 <i>Veuillez effectuer l'action requise ou envoyez <code>/resume</code> une fois terminé.</i>`}
${data.directAppUrl ? `\n🌐 <a href="${data.directAppUrl}">Ouvrir le panneau du bot</a>` : ""}`;

    if (data.screenshotBase64) {
      return this.sendPhoto(data.screenshotBase64, text);
    } else {
      return this.sendMessage(text);
    }
  }

  private urlShort(url?: string): string {
    if (!url) return "Portail Visa on Web";
    try {
      const parsed = new URL(url);
      return parsed.pathname + (parsed.search ? parsed.search.slice(0, 30) : "");
    } catch {
      return url.slice(0, 60);
    }
  }

  /**
   * Polling actif pour écouter les commandes Telegram (/otp 123456, /status, /resume)
   */
  private pollingActive: boolean = false;
  private lastUpdateId: number = 0;
  private commandHandlers: {
    onOtp?: (code: string) => Promise<{ success: boolean; message: string }>;
    onStatus?: () => Promise<string>;
    onResume?: () => Promise<{ success: boolean; message: string }>;
    isAwaitingOtp?: () => boolean;
  } = {};

  public startPolling(handlers: {
    onOtp?: (code: string) => Promise<{ success: boolean; message: string }>;
    onStatus?: () => Promise<string>;
    onResume?: () => Promise<{ success: boolean; message: string }>;
    isAwaitingOtp?: () => boolean;
  }) {
    this.commandHandlers = handlers;
    if (this.pollingActive || !this.isConfigured()) return;
    this.pollingActive = true;
    console.log("[TELEGRAM] Démarrage du polling des commandes interactives (/otp, /status, /resume)...");
    this.pollUpdatesLoop();
  }

  public stopPolling() {
    this.pollingActive = false;
  }

  private async pollUpdatesLoop() {
    while (this.pollingActive) {
      try {
        if (!this.isConfigured()) {
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }

        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=15`;
        const res = await axios.get(url, { timeout: 25000 });

        if (res.data?.ok && Array.isArray(res.data.result)) {
          for (const update of res.data.result) {
            this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
            await this.handleTelegramMessage(update.message);
          }
        }
      } catch (err: any) {
        // En cas d'erreur réseau temporaire, attendre un peu avant de retenter
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handleTelegramMessage(message: any) {
    if (!message || !message.text) return;
    const rawText = message.text.trim();
    const chatId = String(message.chat?.id || "");

    // Si un chatId est spécifié dans l'env, ne répondre qu'au chat autorisé
    if (this.chatId && chatId && chatId !== this.chatId) {
      console.warn(`[TELEGRAM] Message ignoré provenant d'un chat non autorisé (${chatId})`);
      return;
    }

    console.log(`[TELEGRAM] Message reçu de ${message.from?.first_name || "utilisateur"}: "${rawText}"`);

    // 1. Commande /otp <code> ou /code <code>
    const otpMatch = rawText.match(/^\/(?:otp|code)\s+([A-Za-z0-9\-_]+)/i);
    const isPureDigits = /^[0-9]{4,8}$/.test(rawText);
    const awaitingOtp = this.commandHandlers.isAwaitingOtp ? this.commandHandlers.isAwaitingOtp() : false;

    if (otpMatch || (isPureDigits && awaitingOtp)) {
      const code = otpMatch ? otpMatch[1] : rawText;
      await this.sendMessage(`⏳ <b>Code OTP reçu :</b> <code>${code}</code>\nInjection en cours dans le formulaire Visa on Web via le pilote IA...`);

      if (this.commandHandlers.onOtp) {
        try {
          const res = await this.commandHandlers.onOtp(code);
          if (res.success) {
            await this.sendMessage(`✅ <b>Succès :</b> ${res.message}\n🚀 Le bot poursuit la navigation automatiquement.`);
          } else {
            await this.sendMessage(`⚠️ <b>Attention :</b> ${res.message}\nVérifiez le code ou réessayez avec <code>/otp NOUVEAU_CODE</code>.`);
          }
        } catch (err: any) {
          await this.sendMessage(`❌ Erreur lors de l'injection du code : ${err.message}`);
        }
      } else {
        await this.sendMessage("⚠️ Aucun gestionnaire d'OTP actif pour le moment.");
      }
      return;
    }

    // 2. Commande /resume
    if (rawText.toLowerCase().startsWith("/resume") || rawText.toLowerCase().startsWith("/reprendre")) {
      if (this.commandHandlers.onResume) {
        await this.sendMessage("🔄 Signal de reprise reçu. Le pilote IA réévalue la page...");
        const res = await this.commandHandlers.onResume();
        await this.sendMessage(res.success ? `✅ ${res.message}` : `⚠️ ${res.message}`);
      } else {
        await this.sendMessage("ℹ️ Aucune intervention en pause actuellement.");
      }
      return;
    }

    // 3. Commande /status
    if (rawText.toLowerCase().startsWith("/status")) {
      if (this.commandHandlers.onStatus) {
        const statusText = await this.commandHandlers.onStatus();
        await this.sendMessage(statusText);
      } else {
        await this.sendMessage("🤖 Bot Visa en veille.");
      }
      return;
    }

    // 4. Commande /help ou /start
    if (rawText.toLowerCase().startsWith("/help") || rawText.toLowerCase().startsWith("/start")) {
      const helpMsg = 
`🤖 <b>Commandes disponibles pour le Bot Visa on Web :</b>

🔹 <code>/otp 123456</code> : Injecte immédiatement un code SMS / OTP dans le portail.
🔹 <code>/resume</code> : Indique au bot de reprendre après avoir résolu un Captcha ou blocage.
🔹 <code>/status</code> : Affiche l'état en direct du bot, de la session et des créneaux.
🔹 <code>/help</code> : Affiche ce menu d'aide.

⚡ <i>Mode Pilote IA avec analyse visuelle HD et Sniper de créneau activé.</i>`;
      await this.sendMessage(helpMsg);
      return;
    }
  }

  /**
   * Envoi d'un message texte formaté HTML.
   */
  public async sendMessage(htmlText: string): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await axios.post(url, {
        chat_id: this.chatId,
        text: htmlText,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }, { timeout: 10000 });

      return response.data?.ok === true;
    } catch (error: any) {
      console.error("[TELEGRAM] Erreur d'envoi du message:", error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Envoi d'une photo avec légende HTML.
   */
  public async sendPhoto(base64Image: string, captionHtml: string): Promise<boolean> {
    try {
      const buffer = Buffer.from(base64Image.replace(/^data:image\/\w+;base64,/, ""), "base64");
      const url = `https://api.telegram.org/bot${this.botToken}/sendPhoto`;
      
      const formData = new FormData();
      formData.append("chat_id", this.chatId);
      formData.append("caption", captionHtml.slice(0, 1024)); // Limite de légende Telegram
      formData.append("parse_mode", "HTML");
      formData.append("photo", buffer, { filename: "emergency-screen.jpg", contentType: "image/jpeg" });

      const response = await axios.post(url, formData, {
        headers: formData.getHeaders(),
        timeout: 15000,
      });

      return response.data?.ok === true;
    } catch (error: any) {
      console.error("[TELEGRAM] Erreur d'envoi de la photo:", error.response?.data || error.message);
      // Repli vers un simple message texte si la photo échoue
      return this.sendMessage(captionHtml);
    }
  }

  /**
   * Test de connexion au bot Telegram.
   */
  public async testConnection(): Promise<{ success: boolean; botName?: string; error?: string }> {
    if (!this.isConfigured()) {
      return { success: false, error: "Token ou Chat ID manquant (configurez TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID)" };
    }
    try {
      const res = await axios.get(`https://api.telegram.org/bot${this.botToken}/getMe`, { timeout: 8000 });
      if (res.data?.ok) {
        const botName = res.data.result?.username || res.data.result?.first_name;
        await this.sendMessage(`🤖 <b>Test de connexion réussi</b> : Le bot <i>@${botName}</i> est relié avec succès au canal Telegram pour les notifications Visa.`);
        return { success: true, botName };
      }
      return { success: false, error: "Réponse invalide de Telegram" };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.description || err.message };
    }
  }

  public async sendTestMessage(): Promise<{ success: boolean; botName?: string; error?: string }> {
    return this.testConnection();
  }
}

export const telegramService = new TelegramService();
