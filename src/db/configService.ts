import { db, isDatabaseConfigured, checkDatabaseReachable } from "./index.ts";
import { systemConfigs, visaProfiles, appointmentBookings } from "./schema.ts";
import { encryptData, decryptData } from "../lib/crypto.ts";
import { eq, sql } from "drizzle-orm";

// Mémoire de secours en cas d'absence ou déconnexion de PostgreSQL
const memoryConfigs = new Map<string, string>();
const memoryProfiles: any[] = [];

/**
 * Récupère une valeur de configuration système (déchiffrée)
 */
export async function getConfig(key: string, defaultValue: string = ""): Promise<string> {
  const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
  if (!isDbReady) {
    return memoryConfigs.get(key) || process.env[key] || defaultValue;
  }
  try {
    const records = await db.select().from(systemConfigs).where(eq(systemConfigs.key, key)).limit(1);
    if (records.length > 0 && records[0].encryptedValue) {
      return decryptData(records[0].encryptedValue);
    }
    return memoryConfigs.get(key) || process.env[key] || defaultValue;
  } catch {
    return memoryConfigs.get(key) || process.env[key] || defaultValue;
  }
}

/**
 * Enregistre ou met à jour une configuration système (avec chiffrement AES-256)
 */
export async function setConfig(key: string, value: string, description?: string): Promise<boolean> {
  memoryConfigs.set(key, value);
  const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
  if (!isDbReady) {
    return true;
  }
  try {
    const encrypted = encryptData(value);
    await db.insert(systemConfigs)
      .values({
        key,
        encryptedValue: encrypted,
        description: description || `Configuration pour ${key}`,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: {
          encryptedValue: encrypted,
          updatedAt: new Date(),
        },
      });
    return true;
  } catch {
    return true; // Config sauvegardée en mémoire
  }
}

/**
 * Enregistre un profil visa avec identifiants et passeport chiffrés AES-256
 */
export async function saveVisaProfile(data: {
  name: string;
  email: string;
  password: string;
  passportNumber?: string;
  applicationIndex?: number;
  preferredDateStart?: string;
  preferredDateEnd?: string;
}) {
  const profileItem = {
    id: memoryProfiles.length + 1,
    name: data.name,
    email: data.email,
    password: data.password,
    passportNumber: data.passportNumber || "",
    applicationIndex: data.applicationIndex || 1,
    preferredDateStart: data.preferredDateStart,
    preferredDateEnd: data.preferredDateEnd,
    isActive: true,
    createdAt: new Date(),
  };

  memoryProfiles.push(profileItem);

  const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
  if (!isDbReady) {
    return profileItem;
  }

  try {
    const encEmail = encryptData(data.email);
    const encPassword = encryptData(data.password);
    const encPassport = data.passportNumber ? encryptData(data.passportNumber) : null;

    const inserted = await db.insert(visaProfiles).values({
      name: data.name,
      encryptedEmail: encEmail,
      encryptedPassword: encPassword,
      encryptedPassportNumber: encPassport,
      applicationIndex: data.applicationIndex || 1,
      preferredDateStart: data.preferredDateStart,
      preferredDateEnd: data.preferredDateEnd,
      isActive: true,
      updatedAt: new Date(),
    }).returning();

    return inserted[0] || profileItem;
  } catch {
    return profileItem;
  }
}

/**
 * Récupère les profils visa actifs avec données déchiffrées
 */
export async function getActiveVisaProfiles() {
  const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
  if (!isDbReady) {
    return memoryProfiles;
  }
  try {
    const rows = await db.select().from(visaProfiles);
    if (rows.length === 0) {
      return memoryProfiles;
    }
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      email: decryptData(row.encryptedEmail),
      password: decryptData(row.encryptedPassword),
      passportNumber: row.encryptedPassportNumber ? decryptData(row.encryptedPassportNumber) : "",
      applicationIndex: row.applicationIndex,
      preferredDateStart: row.preferredDateStart,
      preferredDateEnd: row.preferredDateEnd,
      isActive: row.isActive,
      createdAt: row.createdAt,
    }));
  } catch {
    return memoryProfiles;
  }
}

/**
 * Initialise automatiquement les tables en base de données si elles n'existent pas encore
 */
export async function initializeDatabaseSchema() {
  const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
  if (!isDbReady) {
    console.log("[DB] Base PostgreSQL non accessible. Mode mémoire résilient actif.");
    return false;
  }

  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS system_configs (
        key TEXT PRIMARY KEY,
        encrypted_value TEXT NOT NULL,
        description TEXT,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS visa_profiles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        encrypted_email TEXT NOT NULL,
        encrypted_password TEXT NOT NULL,
        encrypted_passport_number TEXT,
        application_index INTEGER DEFAULT 1,
        preferred_date_start TEXT,
        preferred_date_end TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS appointment_bookings (
        id SERIAL PRIMARY KEY,
        profile_name TEXT NOT NULL,
        status TEXT NOT NULL,
        target_date TEXT,
        appointment_date TEXT,
        appointment_time TEXT,
        reference_number TEXT,
        telegram_alert_sent BOOLEAN DEFAULT FALSE,
        details TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Index composite sur (status, target_date) pour éviter de bloquer le CPU sur les requêtes fréquentes
      CREATE INDEX IF NOT EXISTS idx_appointment_bookings_status_target_date 
      ON appointment_bookings (status, target_date);

      CREATE TABLE IF NOT EXISTS bot_locks (
        resource TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        acquired_at TIMESTAMP DEFAULT NOW() NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS bot_sessions (
        session_key TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        encrypted_cookies TEXT NOT NULL,
        user_agent TEXT,
        last_valid_url TEXT,
        is_valid BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    console.log("[DB] Schéma PostgreSQL initialisé et synchronisé avec succès.");
    return true;
  } catch {
    return false;
  }
}

/**
 * Enregistre une réservation ou une alerte en BDD
 */
export async function logAppointmentBooking(data: {
  profileName: string;
  status: string;
  targetDate?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  referenceNumber?: string;
  telegramAlertSent?: boolean;
  details?: string;
}) {
  const isDbReady = isDatabaseConfigured() && await checkDatabaseReachable();
  if (!isDbReady) {
    return [{ ...data, id: Date.now(), createdAt: new Date() }];
  }
  try {
    return await db.insert(appointmentBookings).values({
      profileName: data.profileName,
      status: data.status,
      targetDate: data.targetDate || data.appointmentDate || null,
      appointmentDate: data.appointmentDate,
      appointmentTime: data.appointmentTime,
      referenceNumber: data.referenceNumber,
      telegramAlertSent: data.telegramAlertSent ?? false,
      details: data.details,
    }).returning();
  } catch {
    return null;
  }
}
