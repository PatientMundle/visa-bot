import crypto from "crypto";

// Clé de chiffrement maître AES-256 (32 octets).
// En production, dérivée de process.env.ENCRYPTION_KEY ou générée de manière stable.
const DEFAULT_SALT = "schengen-visa-automator-secure-salt-2026";
const RAW_KEY = process.env.ENCRYPTION_KEY || "visa-bot-secret-aes-key-32chars!!";

function getCipherKey(): Buffer {
  return crypto.scryptSync(RAW_KEY, DEFAULT_SALT, 32);
}

const ALGORITHM = "aes-256-gcm";
// Standard AES-GCM IV : 12 octets (96 bits) conformément aux recommandations NIST & exigences de sécurité
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16; // 16 octets (128 bits)

/**
 * Chiffre une chaîne en clair avec AES-256-GCM.
 * Génère un IV aléatoire de 12 octets à chaque écriture.
 * Formate le stockage sous la forme standard IV:AuthTag:Ciphertext (type TEXT).
 */
export function encryptData(plainText: string): string {
  if (!plainText) return "";
  const key = getCipherKey();
  const iv = crypto.randomBytes(IV_LENGTH); // 12 octets aléatoires à chaque écriture
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");

  // Extraction du jeton d'authentification GCM (16 octets)
  const authTag = cipher.getAuthTag();

  // Stockage strict: IV:AuthTag:Ciphertext
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Déchiffre une chaîne chiffrée avec AES-256-GCM.
 * Extrait et vérifie obligatoirement le jeton d'authentification via decipher.setAuthTag(authTag)
 * et decipher.final() pour bloquer toute donnée altérée ou corrompue.
 */
export function decryptData(cipherPayload: string): string {
  if (!cipherPayload) return "";
  try {
    const parts = cipherPayload.split(":");
    if (parts.length !== 3) {
      // Si la donnée n'était pas au format chiffré (migration douce)
      return cipherPayload;
    }

    const [ivHex, authTagHex, encryptedHex] = parts;
    if (!ivHex || !authTagHex || !encryptedHex) {
      throw new Error("Payload de chiffrement incomplet (IV, AuthTag ou Ciphertext manquant)");
    }

    const key = getCipherKey();
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    // Vérification de sécurité stricte : l'AuthTag doit impérativement faire 16 octets
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`AuthTag invalide (${authTag.length} octets reçus, 16 requis). Donnée altérée rejetée.`);
    }

    // Tolère 12 octets (nouveau format) ou 16 octets (rétro-compatibilité historique)
    if (iv.length !== 12 && iv.length !== 16) {
      throw new Error(`IV invalide (${iv.length} octets reçus). Donnée suspecte rejetée.`);
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    
    // Application impérative du jeton d'authentification pour détection d'altération
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    // final() lève une exception cryptographique si le jeton d'authentification ou le message a été altéré
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err: any) {
    console.error("[CRYPTO] Erreur critique de déchiffrement (donnée altérée ou corrompue bloquée):", err.message);
    return "";
  }
}
