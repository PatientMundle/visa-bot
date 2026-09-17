import { Page } from "puppeteer";
import { db, isDatabaseConfigured, checkDatabaseReachable } from "../db/index.ts";
import { botSessions } from "../db/schema.ts";
import { encryptData, decryptData } from "./crypto.ts";
import { eq } from "drizzle-orm";

interface MemorySession {
  cookies: any[];
  userAgent?: string;
  lastValidUrl?: string;
  expiresAt: number;
}

/**
 * Service de persistance et de réinjection des cookies de session Puppeteer.
 * - Sécurisé par chiffrement AES-256-GCM si PostgreSQL est joignable.
 * - Cache mémoire immédiat si la BDD est hors ligne.
 * - Permet au bot de reprendre immédiatement une session active après redémarrage ou reconnexion.
 */
export class SessionService {
  private static memorySessions = new Map<string, MemorySession>();

  /**
   * Sauvegarde les cookies de session actuels d'une page Puppeteer
   */
  public static async saveSession(
    page: Page,
    sessionKey: string,
    domain: string = "visaonweb.diplomatie.be"
  ): Promise<boolean> {
    try {
      if (!page || page.isClosed()) return false;

      const cookies = await page.cookies();
      if (!cookies || cookies.length === 0) {
        return false;
      }

      const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
      const currentUrl = page.url();
      const expiresAtMs = Date.now() + 24 * 60 * 60 * 1000;

      // Sauvegarde en mémoire systématique
      this.memorySessions.set(sessionKey, {
        cookies,
        userAgent,
        lastValidUrl: currentUrl,
        expiresAt: expiresAtMs,
      });

      const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
      if (!isDbReady) {
        return true;
      }

      const jsonCookies = JSON.stringify(cookies);
      const encryptedCookies = encryptData(jsonCookies);
      const expiresAt = new Date(expiresAtMs);

      await db.insert(botSessions)
        .values({
          sessionKey,
          domain,
          encryptedCookies,
          userAgent,
          lastValidUrl: currentUrl,
          isValid: true,
          expiresAt,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: botSessions.sessionKey,
          set: {
            encryptedCookies,
            userAgent,
            lastValidUrl: currentUrl,
            isValid: true,
            expiresAt,
            updatedAt: new Date(),
          },
        });

      return true;
    } catch {
      return true; // Conservé en mémoire
    }
  }

  /**
   * Réinjecte les cookies de session enregistrés dans une page Puppeteer
   */
  public static async restoreSession(
    page: Page,
    sessionKey: string
  ): Promise<{ restored: boolean; cookieCount: number; lastUrl?: string }> {
    try {
      if (!page || page.isClosed()) {
        return { restored: false, cookieCount: 0 };
      }

      // 1. Vérifier le cache mémoire
      const memSession = this.memorySessions.get(sessionKey);
      if (memSession && memSession.expiresAt > Date.now()) {
        if (Array.isArray(memSession.cookies) && memSession.cookies.length > 0) {
          await page.setCookie(...memSession.cookies);
          return {
            restored: true,
            cookieCount: memSession.cookies.length,
            lastUrl: memSession.lastValidUrl,
          };
        }
      }

      const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
      if (!isDbReady) {
        return { restored: false, cookieCount: 0 };
      }

      const rows = await db.select()
        .from(botSessions)
        .where(eq(botSessions.sessionKey, sessionKey))
        .limit(1);

      if (rows.length === 0 || !rows[0].encryptedCookies) {
        return { restored: false, cookieCount: 0 };
      }

      const session = rows[0];

      if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) {
        return { restored: false, cookieCount: 0 };
      }

      const decrypted = decryptData(session.encryptedCookies);
      if (!decrypted) {
        return { restored: false, cookieCount: 0 };
      }

      const cookies = JSON.parse(decrypted);
      if (!Array.isArray(cookies) || cookies.length === 0) {
        return { restored: false, cookieCount: 0 };
      }

      await page.setCookie(...cookies);

      // Mettre en cache mémoire
      this.memorySessions.set(sessionKey, {
        cookies,
        userAgent: session.userAgent || undefined,
        lastValidUrl: session.lastValidUrl || undefined,
        expiresAt: session.expiresAt ? new Date(session.expiresAt).getTime() : Date.now() + 86400000,
      });

      return {
        restored: true,
        cookieCount: cookies.length,
        lastUrl: session.lastValidUrl || undefined,
      };
    } catch {
      return { restored: false, cookieCount: 0 };
    }
  }

  /**
   * Invalide ou supprime la session enregistrée
   */
  public static async invalidateSession(sessionKey: string): Promise<boolean> {
    this.memorySessions.delete(sessionKey);
    const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
    if (!isDbReady) {
      return true;
    }
    try {
      await db.update(botSessions)
        .set({ isValid: false, updatedAt: new Date() })
        .where(eq(botSessions.sessionKey, sessionKey));
      return true;
    } catch {
      return true;
    }
  }
}
