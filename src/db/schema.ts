import { pgTable, serial, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";

// Table pour les utilisateurs autorisés
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  uid: text("uid").notNull().unique(), // Firebase Auth UID
  email: text("email").notNull(),
  role: text("role").default("admin"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Table pour les profils Visa et identifiants chiffrés (AES-256)
export const visaProfiles = pgTable("visa_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(), // ex: "Patient Mundele - Visa Belgique"
  encryptedEmail: text("encrypted_email").notNull(), // Chiffré AES-256
  encryptedPassword: text("encrypted_password").notNull(), // Chiffré AES-256
  encryptedPassportNumber: text("encrypted_passport_number"), // Chiffré AES-256
  applicationIndex: integer("application_index").default(1),
  preferredDateStart: text("preferred_date_start"),
  preferredDateEnd: text("preferred_date_end"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Table pour les paramètres et clés d'API centralisées
export const systemConfigs = pgTable("system_configs", {
  key: text("key").primaryKey(), // ex: "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SNIPER_MODE", "GROQ_API_KEY", "GEMINI_API_KEY"
  encryptedValue: text("encrypted_value").notNull(), // Valeur chiffrée AES-256
  description: text("description"),
  isSensitive: boolean("is_sensitive").default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Table pour l'historique des réservations Sniper & Alertes
export const appointmentBookings = pgTable("appointment_bookings", {
  id: serial("id").primaryKey(),
  profileName: text("profile_name").notNull(),
  status: text("status").notNull(), // "SNIPER_CONFIRMED", "EMERGENCY_CAPTCHA", "FAILED"
  targetDate: text("target_date"), // Date cible ou réservée indexée
  appointmentDate: text("appointment_date"),
  appointmentTime: text("appointment_time"),
  referenceNumber: text("reference_number"),
  telegramAlertSent: boolean("telegram_alert_sent").default(false),
  details: text("details"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  // Index composite sur (status, target_date) pour éviter de bloquer le CPU sur les requêtes fréquentes
  index("idx_appointment_bookings_status_target_date").on(table.status, table.targetDate),
]);

// Table pour les verrous distribués (Locks) en BDD pour interdire les conflits du mode Sniper
export const botLocks = pgTable("bot_locks", {
  resource: text("resource").primaryKey(), // ex: "sniper:global", "profile:1", "account:email@domain.com"
  holderId: text("holder_id").notNull(), // Identifiant unique du processus / worker
  acquiredAt: timestamp("acquired_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  metadata: text("metadata"), // Informations contextuelles (action en cours, créneau ciblé)
});

// Table pour la persistance et réinjection des cookies de session Puppeteer (Chiffrés AES-256)
export const botSessions = pgTable("bot_sessions", {
  sessionKey: text("session_key").primaryKey(), // ex: "visa_session:patientmundele17@gmail.com"
  domain: text("domain").notNull(), // ex: "visaonweb.diplomatie.be"
  encryptedCookies: text("encrypted_cookies").notNull(), // JSON serialisé et chiffré AES-256
  userAgent: text("user_agent"),
  lastValidUrl: text("last_valid_url"),
  isValid: boolean("is_valid").default(true),
  expiresAt: timestamp("expires_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

