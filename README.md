# ⚡ Schengen Visa Automator — Guide de Démarrage Rapide

Bot automatisé 24/7 avec intelligence artificielle et Puppeteer Stealth pour la détection et la réservation instantanée de rendez-vous sur le portail officiel **Visa on Web**.

---

## 🚀 Lancement Immédiat sur votre Machine

### 1. Prérequis
- **Node.js 18+** ou supérieur (`node -v`)
- **npm** ou **yarn**
- *(Optionnel mais recommandé)* Une base de données PostgreSQL (ex: Neon.tech, Supabase ou PostgreSQL local)

---

### 2. Installation

Ouvrez un terminal dans le dossier du projet et exécutez :

```bash
# 1. Cloner ou naviguer dans le dossier du projet
cd schengen-visa-automator

# 2. Installer toutes les dépendances
npm install
```

---

### 3. Configuration des Variables d'Environnement (`.env`)

Copiez le fichier d'exemple `.env.example` vers un nouveau fichier `.env` :

```bash
cp .env.example .env
```

Remplissez votre fichier `.env` avec vos informations :

```env
# Port du serveur (3000 par défaut)
PORT=3000

# Clé API Groq (utilisée pour l'analyse vision rapide des pages)
GROQ_API_KEY=gsk_votre_cle_groq_ici

# Alertes Telegram (Notification immédiate lors d'un créneau trouvé)
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRstuVWXyz
TELEGRAM_CHAT_ID=123456789

# Identifiants du compte Visa on Web
VOW_EMAIL=votre_email@domaine.com
VOW_PASSWORD=votre_mot_de_passe
VOW_APPLICATION_INDEX=1

# Base de données PostgreSQL (Schéma auto-initialisé au démarrage)
DATABASE_URL=postgresql://user:password@localhost:5432/visa_db
# Clé de chiffrement AES-256 pour les identifiants et cookies (32 caractères ou chaîne sécurisée)
DATABASE_ENCRYPTION_KEY=votre_cle_secrete_ultra_securisee_32caract

# PROXYS (100% GRATUIT) : Laissez vide ! Le bot télécharge et filtre automatiquement les proxys publics.
# ROTATING_PROXY_LIST=
```

> 💡 **Remarque importante sur les proxys** : Vous n'avez **besoin d'aucun abonnement payant**. Le bot intègre un téléchargeur automatique depuis l'API publique de **ProxyScrape** et un filtre de santé en temps réel.

---

### 4. Démarrer l'Application

#### Mode Développement (avec tableau de bord interactif) :
```bash
npm run dev
```

Ouvrez votre navigateur sur : **[http://localhost:3000](http://localhost:3000)**

#### Mode Production :
```bash
npm run build
npm start
```

#### Mode Démon 24/7 en arrière-plan (recommandé pour Sniper) :
```bash
# Installer PM2 si ce n'est pas déjà fait
npm install -g pm2

# Lancer le bot en tâche de fond continue
pm2 start "npm start" --name "schengen-visa-bot"

# Suivre les logs en direct
pm2 logs schengen-visa-bot
```

---

## 🎯 Pourquoi cette approche fonctionne :

L'association de proxys gratuits et d'un bot d'automatisation échoue traditionnellement à cause de la forte instabilité des serveurs publics. Voici précisément pourquoi notre architecture résout ce problème et fonctionne de manière fiable :

### 1. Le Pré-Filtrage "Health Check" Ultra-Rapide (2.5 secondes max)
- **Le problème classique** : Injecter un proxy public au hasard dans Puppeteer entraîne 9 fois sur 10 un timeout de 90 secondes ou une erreur `ERR_PROXY_CONNECTION_FAILED`, gelant le bot.
- **Notre solution** : Avant d'ouvrir Chromium, `ProxyService` teste d'abord l'ouverture TCP de la socket, puis envoie une micro-requête HTTP (`connectivitycheck.gstatic.com/generate_204`). Si le proxy ne répond pas en moins de **2500 ms**, il est immédiatement disqualifié et le bot teste le suivant en millisecondes. Seuls les proxys **100% vivants et véloces** sont injectés.

### 2. Le Filet de Sécurité "Zero-Freeze" (Direct Fallback)
- Si le pool public subit une panne temporaire, le bot ne plante pas : il **bascule automatiquement et silencieusement en connexion directe sécurisée** (`Direct Mode`). La vérification des créneaux n'est donc jamais interrompue.

### 3. Puppeteer Stealth & Empreinte Navigateur Humaine
- Même sans IP résidentielle payante, le plugin `puppeteer-extra-plugin-stealth` couplé à la randomisation des headers (`User-Agent`, `viewport`, `Sec-Ch-Ua`, masquage de `navigator.webdriver`) évite le déclenchement des règles anti-bot automatisées de base de Cloudflare / Visa on Web.

### 4. Persistance des Sessions Chiffrées (Cookies AES-256)
- Les cookies de session (`.AspNet.ApplicationCookie`, `ASP.NET_SessionId`) sont sauvegardés de manière sécurisée en base.
- Résultat : le bot n'a pas besoin de renvoyer le formulaire de login ni de résoudre de captchas à chaque cycle de vérification, ce qui réduit drastiquement les requêtes suspectes envoyées au portail.

### 5. Verrou Distribué Anti-Collision (`LockService`)
- Si vous lancez plusieurs vérifications ou activez le mode Sniper continu, un verrou atomique basé sur PostgreSQL empêche deux processus de réserver simultanément le même compte ou de provoquer des conflits d'état sur le site consulaire.

---

## 🛠️ API & Endpoints Utiles

| Méthode | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/bot/status` | État actuel du bot (en cours, pause, créneaux) |
| `POST` | `/api/bot/start` | Démarre la surveillance / le mode Sniper |
| `POST` | `/api/bot/stop` | Arrête la surveillance |
| `GET` | `/api/proxy/status` | Statistiques du pool de proxys et mode actif |
| `POST` | `/api/proxy/refresh-free` | Force le téléchargement et le Health Check des proxys gratuits |
| `POST` | `/api/telegram/test` | Envoie une notification de test sur votre Telegram |
| `GET` | `/api/lock/status` | État du verrou distribué anti-collision |
| `POST` | `/api/maintenance/purge` | Déclenche immédiatement la purge des données de plus de 7 jours |

---

## 🧹 Maintenance Automatique VPS & Anti-Saturation
- **Purge automatique programmée** : Toutes les 6 heures, le service de maintenance supprime les réservations obsolètes et les fichiers temporaires/captures d'écran vieux de plus de **7 jours**.
- **Anti-Spam Telegram (Debounce)** : Les alertes d'erreur consécutives identiques sont espacées d'un délai d'attente de 10 minutes pour protéger le bot contre les bannissements Telegram.
- **Verrous Distribués (TTL)** : Les verrous de réservation expirent automatiquement après 2 minutes en cas d'interruption inattendue du processus.

---

## 🔒 Sécurité & Bonnes Pratiques
- Toutes les données sensibles (mots de passe, passeports, cookies) sont chiffrées avec **AES-256-GCM** avant écriture en base.
- Ne partagez jamais votre fichier `.env` ni votre clé `DATABASE_ENCRYPTION_KEY`.
