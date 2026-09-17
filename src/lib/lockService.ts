import { db, isDatabaseConfigured, checkDatabaseReachable } from "../db/index.ts";
import { botLocks } from "../db/schema.ts";
import { eq, sql } from "drizzle-orm";
import crypto from "crypto";

interface MemoryLock {
  resource: string;
  holderId: string;
  expiresAt: number;
  metadata?: string;
}

/**
 * Service de gestion des verrous distribués (Locks).
 * Empêche les conflits de réservation concurrente (Race Conditions) du mode Sniper :
 * - Garantit qu'un seul processus/worker réserve un créneau à la fois
 * - Supporte un TTL (Time-To-Live) avec expiration automatique pour éviter les verrous fantômes
 * - Bascule automatiquement sur un verrou mémoire en l'absence de base PostgreSQL configurée ou accessible
 */
export class LockService {
  private static instanceId: string = `worker-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  private static memoryLocks = new Map<string, MemoryLock>();

  public static getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Acquisition en mémoire locale (Fallback sans BDD)
   */
  private static acquireMemoryLock(
    resource: string,
    ttlMs: number,
    metadata?: string
  ): { acquired: boolean; lockHolder?: string; error?: string } {
    const holderId = this.instanceId;
    const now = Date.now();
    const existing = this.memoryLocks.get(resource);

    if (existing && existing.expiresAt > now) {
      if (existing.holderId === holderId) {
        existing.expiresAt = now + ttlMs;
        return { acquired: true, lockHolder: holderId };
      }
      const remainingSec = Math.max(0, Math.round((existing.expiresAt - now) / 1000));
      return {
        acquired: false,
        lockHolder: existing.holderId,
        error: `Verrou actif détenu par ${existing.holderId} (expire dans ${remainingSec}s)`,
      };
    }

    this.memoryLocks.set(resource, {
      resource,
      holderId,
      expiresAt: now + ttlMs,
      metadata: metadata || `Verrouillé par ${holderId}`,
    });

    return { acquired: true, lockHolder: holderId };
  }

  /**
   * Tente d'acquérir un verrou distribué pour une ressource donnée.
   */
  public static async acquireLock(
    resource: string = "sniper:global",
    ttlMs: number = 120000,
    metadata?: string
  ): Promise<{ acquired: boolean; lockHolder?: string; error?: string }> {
    const holderId = this.instanceId;

    const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
    if (!isDbReady) {
      return this.acquireMemoryLock(resource, ttlMs, metadata);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    try {
      // 1. Nettoyer les verrous expirés pour cette ressource
      await db.delete(botLocks)
        .where(sql`${botLocks.resource} = ${resource} AND ${botLocks.expiresAt} < ${now}`);

      // 2. Tenter d'insérer le verrou
      await db.insert(botLocks)
        .values({
          resource,
          holderId,
          acquiredAt: now,
          expiresAt,
          metadata: metadata || `Verrouillé par ${holderId}`,
        });

      return { acquired: true, lockHolder: holderId };
    } catch {
      try {
        const existing = await db.select()
          .from(botLocks)
          .where(eq(botLocks.resource, resource))
          .limit(1);

        if (existing.length > 0) {
          const activeLock = existing[0];
          if (activeLock.holderId === holderId) {
            await db.update(botLocks)
              .set({ expiresAt, metadata: metadata || activeLock.metadata })
              .where(eq(botLocks.resource, resource));
            return { acquired: true, lockHolder: holderId };
          }

          const remainingSec = Math.max(0, Math.round((new Date(activeLock.expiresAt).getTime() - Date.now()) / 1000));
          return {
            acquired: false,
            lockHolder: activeLock.holderId,
            error: `Verrou actif détenu par ${activeLock.holderId} (expire dans ${remainingSec}s)`,
          };
        }
      } catch {
        // Bascule sur le verrou mémoire
        return this.acquireMemoryLock(resource, ttlMs, metadata);
      }

      return this.acquireMemoryLock(resource, ttlMs, metadata);
    }
  }

  /**
   * Renouvelle le verrou (Heartbeat)
   */
  public static async extendLock(resource: string = "sniper:global", extendMs: number = 60000): Promise<boolean> {
    const mem = this.memoryLocks.get(resource);
    if (mem && mem.holderId === this.instanceId) {
      mem.expiresAt = Date.now() + extendMs;
    }

    const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
    if (!isDbReady) {
      return true;
    }

    try {
      const holderId = this.instanceId;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + extendMs);

      await db.update(botLocks)
        .set({ expiresAt })
        .where(sql`${botLocks.resource} = ${resource} AND ${botLocks.holderId} = ${holderId}`);

      return true;
    } catch {
      return mem !== undefined;
    }
  }

  /**
   * Libère le verrou
   */
  public static async releaseLock(resource: string = "sniper:global"): Promise<boolean> {
    this.memoryLocks.delete(resource);

    const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
    if (!isDbReady) {
      return true;
    }

    try {
      const holderId = this.instanceId;
      await db.delete(botLocks)
        .where(sql`${botLocks.resource} = ${resource} AND ${botLocks.holderId} = ${holderId}`);
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Vérifie l'état actuel d'un verrou
   */
  public static async checkLockStatus(resource: string = "sniper:global"): Promise<{
    isLocked: boolean;
    holderId?: string;
    expiresAt?: Date;
    isCurrentHolder: boolean;
  }> {
    const mem = this.memoryLocks.get(resource);
    const nowMs = Date.now();
    if (mem && mem.expiresAt > nowMs) {
      return {
        isLocked: true,
        holderId: mem.holderId,
        expiresAt: new Date(mem.expiresAt),
        isCurrentHolder: mem.holderId === this.instanceId,
      };
    }

    const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
    if (!isDbReady) {
      return { isLocked: false, isCurrentHolder: false };
    }

    try {
      const now = new Date();
      const rows = await db.select()
        .from(botLocks)
        .where(sql`${botLocks.resource} = ${resource} AND ${botLocks.expiresAt} > ${now}`)
        .limit(1);

      if (rows.length === 0) {
        return { isLocked: false, isCurrentHolder: false };
      }

      const lock = rows[0];
      return {
        isLocked: true,
        holderId: lock.holderId,
        expiresAt: lock.expiresAt,
        isCurrentHolder: lock.holderId === this.instanceId,
      };
    } catch {
      return { isLocked: false, isCurrentHolder: false };
    }
  }
}
