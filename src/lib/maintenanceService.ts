import { db, isDatabaseConfigured, checkDatabaseReachable } from "../db/index.ts";
import { sql } from "drizzle-orm";
import fs from "fs";
import path from "path";

/**
 * Service de maintenance automatique pour serveur VPS et BDD :
 * - Purge automatique des enregistrements / logs en BDD vieux de plus de 7 jours (si PostgreSQL actif)
 * - Purge automatique des fichiers captures d'écran (.jpg, .png, .webm) sur le disque de plus de 7 jours
 * - Nettoyage des verrous distribués expirés
 */
export class MaintenanceService {
  private static intervalId: NodeJS.Timeout | null = null;

  /**
   * Lance la tâche de maintenance périodique (toutes les 6 heures)
   */
  public static startScheduler(intervalMs: number = 6 * 60 * 60 * 1000) {
    if (this.intervalId) return;

    // Exécution initiale 10 secondes après le démarrage du serveur
    setTimeout(() => {
      this.runPurgeRoutine().catch((err) => {
        console.warn("[MAINTENANCE] Erreur lors de la purge initiale:", err.message);
      });
    }, 10000);

    this.intervalId = setInterval(() => {
      this.runPurgeRoutine().catch((err) => {
        console.warn("[MAINTENANCE] Erreur lors de la routine de purge:", err.message);
      });
    }, intervalMs);

    console.log("[MAINTENANCE] Service de nettoyage automatique actif (purge tous les 7 jours).");
  }

  /**
   * Exécute une purge complète (fichiers temporaires & base de données)
   */
  public static async runPurgeRoutine(): Promise<{
    deletedDbBookings: number;
    deletedExpiredLocks: number;
    deletedDiskFiles: number;
  }> {
    let deletedDbBookings = 0;
    let deletedExpiredLocks = 0;
    let deletedDiskFiles = 0;

    console.log("[MAINTENANCE] Démarrage de la purge automatique (rétention 7 jours)...");

    // 1. Purge BDD (réservations / historiques > 7 jours) uniquement si la BDD est réellement joignable
    const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
    if (isDbReady) {
      try {
        const resBookings = await db.execute(sql`
          DELETE FROM appointment_bookings 
          WHERE created_at < NOW() - INTERVAL '7 days';
        `);
        deletedDbBookings = (resBookings as any)?.rowCount || 0;

        // Nettoyage des vieux verrous expirés
        const resLocks = await db.execute(sql`
          DELETE FROM bot_locks 
          WHERE expires_at < NOW() - INTERVAL '1 day';
        `);
        deletedExpiredLocks = (resLocks as any)?.rowCount || 0;

        console.log(`[MAINTENANCE] BDD nettoyée : ${deletedDbBookings} réservations obsolètes et ${deletedExpiredLocks} verrous expirés purgés.`);
      } catch {
        // Ignorer silencieusement si la table n'est pas encore créée
      }
    } else {
      console.log("[MAINTENANCE] Purge BDD ignorée : stockage local/mémoire actif.");
    }

    // 2. Purge des fichiers volumineux sur le disque (dossiers temporaires ou captures)
    try {
      const candidateDirs = [
        path.join(process.cwd(), "tmp"),
        path.join(process.cwd(), "screenshots"),
        path.join(process.cwd(), "dist", "screenshots"),
        path.join(process.cwd(), "logs"),
      ];

      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      for (const dir of candidateDirs) {
        if (!fs.existsSync(dir)) continue;

        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          try {
            const stats = fs.statSync(filePath);
            if (stats.isFile() && stats.mtimeMs < sevenDaysAgo) {
              fs.unlinkSync(filePath);
              deletedDiskFiles++;
            }
          } catch {
            // Fichier en cours d'utilisation, ignorer
          }
        }
      }

      if (deletedDiskFiles > 0) {
        console.log(`[MAINTENANCE] Disque nettoyé : ${deletedDiskFiles} fichier(s) capture/log de plus de 7 jours supprimé(s).`);
      }
    } catch {
      // Ignorer les erreurs d'accès disque
    }

    return { deletedDbBookings, deletedExpiredLocks, deletedDiskFiles };
  }
}
