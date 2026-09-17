import http from "http";
import net from "net";
import axios from "axios";

/**
 * Service de gestion des proxys rotatifs pour le bot Puppeteer
 * Supporte :
 * 1. Téléchargement automatique & 100% gratuit via l'API publique ProxyScrape (+ sources de secours)
 * 2. Pré-test de santé ("Health Check") ultra-rapide avec validation HTTPS CONNECT (SSL Tunneling)
 * 3. Élimination automatique des proxys lents, morts ou incompatibles SSL
 * 4. Bascule transparente en connexion directe sécurisée (Direct Mode) en cas de panne ou d'instabilité
 * 5. Support optionnel des proxys manuels via ROTATING_PROXY_LIST ou PROXY_URL
 */

export interface ProxyConfig {
  server: string; // "http://host:port"
  protocol: "http" | "https" | "socks5" | "socks4";
  host: string;
  port: number;
  username?: string;
  password?: string;
  failCount?: number;
  lastUsed?: number;
  latencyMs?: number;
  isFree?: boolean;
}

export interface ProxyStats {
  manualCount: number;
  freeCount: number;
  healthyCount: number;
  activeMode: "free_proxies" | "manual_proxies" | "direct_connection";
  lastRefreshTime: string | null;
  lastTestedProxy: string | null;
}

export class ProxyService {
  private manualProxies: ProxyConfig[] = [];
  private freeProxies: ProxyConfig[] = [];
  private currentFreeIndex: number = 0;
  private lastFetchTime: number = 0;
  private isFetching: boolean = false;
  private lastTestedInfo: string | null = null;

  // Intervalle de rafraîchissement des proxys gratuits (20 minutes)
  private readonly REFRESH_INTERVAL_MS = 20 * 60 * 1000;

  constructor() {
    this.reloadProxiesFromEnv();
  }

  /**
   * Recharge la liste manuelle des proxys depuis les variables d'environnement
   */
  public reloadProxiesFromEnv() {
    const rawList = process.env.ROTATING_PROXY_LIST || process.env.PROXY_URL || "";
    this.manualProxies = [];

    if (rawList.trim()) {
      const items = rawList.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
      for (const item of items) {
        const parsed = this.parseProxyString(item, false);
        if (parsed) {
          this.manualProxies.push(parsed);
        }
      }
    }

    if (this.manualProxies.length > 0) {
      console.log(`[PROXY SERVICE] ${this.manualProxies.length} proxy(s) manuel(s) configuré(s).`);
    } else {
      console.log(`[PROXY SERVICE] Aucun proxy manuel configuré. Mode alternatif gratuit (Health Check HTTPS CONNECT) avec fallback direct actif.`);
    }
  }

  /**
   * Analyse une chaîne de proxy (http://user:pass@host:port ou host:port:user:pass ou host:port)
   */
  public parseProxyString(raw: string, isFree: boolean = false): ProxyConfig | null {
    try {
      let normalized = raw.trim();
      if (!normalized) return null;

      if (!normalized.includes("://")) {
        const parts = normalized.split(":");
        if (parts.length === 4) {
          return {
            protocol: "http",
            host: parts[0],
            port: parseInt(parts[1], 10),
            username: parts[2],
            password: parts[3],
            server: `http://${parts[0]}:${parts[1]}`,
            failCount: 0,
            lastUsed: 0,
            isFree,
          };
        } else if (parts.length === 2) {
          const port = parseInt(parts[1], 10);
          if (isNaN(port) || port <= 0 || port > 65535) return null;
          return {
            protocol: "http",
            host: parts[0],
            port,
            server: `http://${parts[0]}:${parts[1]}`,
            failCount: 0,
            lastUsed: 0,
            isFree,
          };
        }
        normalized = `http://${normalized}`;
      }

      const parsedUrl = new URL(normalized);
      const protocol = (parsedUrl.protocol.replace(":", "") as any) || "http";
      const host = parsedUrl.hostname;
      const port = parseInt(parsedUrl.port, 10) || (protocol === "https" ? 443 : 80);
      if (!host || isNaN(port)) return null;

      const username = parsedUrl.username ? decodeURIComponent(parsedUrl.username) : undefined;
      const password = parsedUrl.password ? decodeURIComponent(parsedUrl.password) : undefined;

      return {
        protocol,
        host,
        port,
        username,
        password,
        server: `${protocol}://${host}:${port}`,
        failCount: 0,
        lastUsed: 0,
        isFree,
      };
    } catch {
      return null;
    }
  }

  /**
   * Télécharge dynamiquement des proxys gratuits depuis des sources publiques fiables
   */
  public async fetchFreeProxies(): Promise<number> {
    if (this.isFetching) return this.freeProxies.length;
    this.isFetching = true;

    try {
      console.log("[PROXY SERVICE] Téléchargement automatique de proxys gratuits...");
      const endpoints = [
        "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all",
        "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
      ];

      let rawData = "";
      for (const url of endpoints) {
        try {
          const res = await axios.get(url, {
            timeout: 5000,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          });
          if (typeof res.data === "string" && res.data.length > 50) {
            rawData = res.data;
            break;
          }
        } catch {
          // Essayer la source suivante
        }
      }

      if (!rawData) {
        return this.freeProxies.length;
      }

      const lines = rawData.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const parsedList: ProxyConfig[] = [];
      const seen = new Set<string>();

      for (const line of lines) {
        if (!line.includes(":") || line.startsWith("#")) continue;
        const cfg = this.parseProxyString(line, true);
        if (cfg && !seen.has(cfg.server)) {
          seen.add(cfg.server);
          parsedList.push(cfg);
        }
      }

      if (parsedList.length > 0) {
        this.freeProxies = parsedList.sort(() => Math.random() - 0.5);
        this.lastFetchTime = Date.now();
        this.currentFreeIndex = 0;
        console.log(`[PROXY SERVICE] ✅ ${this.freeProxies.length} proxys gratuits indexés en mémoire.`);
      }

      return this.freeProxies.length;
    } catch {
      return this.freeProxies.length;
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Health Check pré-vol avec validation SSL Tunneling (CONNECT visaonweb.diplomatie.be:443)
   * Garantit que le proxy sait router le trafic HTTPS sans provoquer de net::ERR_TIMED_OUT
   */
  public async checkProxyHealth(
    proxy: ProxyConfig,
    timeoutMs: number = 2200
  ): Promise<{ isAlive: boolean; latencyMs: number }> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      let isResolved = false;

      const finish = (isAlive: boolean) => {
        if (!isResolved) {
          isResolved = true;
          const latencyMs = Date.now() - startTime;
          resolve({ isAlive, latencyMs });
        }
      };

      // 1. Test d'ouverture de socket TCP rapide
      const socket = net.createConnection({
        host: proxy.host,
        port: proxy.port,
        timeout: timeoutMs,
      });

      socket.on("connect", () => {
        socket.destroy();

        // 2. Test CONNECT HTTP pour le tunnel SSL vers le portail des visas
        const req = http.request({
          host: proxy.host,
          port: proxy.port,
          method: "CONNECT",
          path: "visaonweb.diplomatie.be:443",
          headers: {
            Host: "visaonweb.diplomatie.be:443",
            "User-Agent": "Mozilla/5.0",
          },
          timeout: timeoutMs,
        });

        req.on("connect", (res, tunnelSocket) => {
          tunnelSocket.destroy();
          req.destroy();
          if (res.statusCode === 200) {
            finish(true);
          } else {
            finish(false);
          }
        });

        req.on("response", () => {
          req.destroy();
          finish(false);
        });

        req.on("error", () => {
          req.destroy();
          finish(false);
        });

        req.on("timeout", () => {
          req.destroy();
          finish(false);
        });

        req.end();
      });

      socket.on("timeout", () => {
        socket.destroy();
        finish(false);
      });

      socket.on("error", () => {
        socket.destroy();
        finish(false);
      });
    });
  }

  /**
   * Sélectionne et teste successivement des proxys jusqu'à en trouver un réellement opérationnel
   * Si aucun proxy n'est validé dans le délai, renvoie null (Direct Mode sécurisé)
   */
  public async getNextHealthyProxy(maxAttempts: number = 6): Promise<ProxyConfig | null> {
    // Si l'utilisateur a explicitement désactivé les proxys via l'env
    if (process.env.DISABLE_PROXIES === "true" || process.env.FORCE_DIRECT_CONNECTION === "true") {
      this.lastTestedInfo = "Mode direct forcé (DISABLE_PROXIES=true)";
      return null;
    }

    // 1. Priorité aux proxys manuels configurés
    if (this.manualProxies.length > 0) {
      for (const manual of this.manualProxies) {
        if ((manual.failCount || 0) > 3) continue;
        const check = await this.checkProxyHealth(manual, 2500);
        if (check.isAlive) {
          manual.latencyMs = check.latencyMs;
          this.lastTestedInfo = `Manuel: ${manual.host}:${manual.port} (${check.latencyMs}ms)`;
          console.log(`[PROXY HEALTH CHECK] ✅ Proxy manuel validé: ${manual.host}:${manual.port} (${check.latencyMs}ms)`);
          return manual;
        }
      }
    }

    // 2. Pool gratuit avec vérification HTTPS
    const shouldRefresh =
      this.freeProxies.length === 0 ||
      Date.now() - this.lastFetchTime > this.REFRESH_INTERVAL_MS;

    if (shouldRefresh) {
      await this.fetchFreeProxies();
    }

    if (this.freeProxies.length === 0) {
      console.log("[PROXY HEALTH CHECK] Aucun proxy gratuit disponible. Mode direct actif.");
      return null;
    }

    let attempts = 0;
    while (attempts < maxAttempts && this.freeProxies.length > 0) {
      attempts++;
      this.currentFreeIndex = (this.currentFreeIndex + 1) % this.freeProxies.length;
      const candidate = this.freeProxies[this.currentFreeIndex];

      if ((candidate.failCount || 0) >= 2) {
        continue;
      }

      const check = await this.checkProxyHealth(candidate, 2200);
      if (check.isAlive) {
        candidate.latencyMs = check.latencyMs;
        candidate.lastUsed = Date.now();
        this.lastTestedInfo = `Gratuit: ${candidate.host}:${candidate.port} (${check.latencyMs}ms)`;
        console.log(`[PROXY HEALTH CHECK] ✅ Proxy gratuit validé : ${candidate.host}:${candidate.port} (${check.latencyMs}ms)`);
        return candidate;
      } else {
        candidate.failCount = (candidate.failCount || 0) + 1;
      }
    }

    console.log(`[PROXY HEALTH CHECK] 🌐 Aucun proxy tiers réactif aux tests HTTPS. Bascule automatique et sécurisée en mode Direct.`);
    this.lastTestedInfo = `Bascule en connexion directe sécurisée (Direct Mode)`;
    return null;
  }

  /**
   * Signale un échec de proxy survenu pendant la navigation
   */
  public markProxyFailure(serverUrl?: string) {
    if (!serverUrl) return;
    const all = [...this.manualProxies, ...this.freeProxies];
    const found = all.find((p) => p.server === serverUrl || serverUrl.includes(p.host));
    if (found) {
      found.failCount = (found.failCount || 0) + 3; // Forcer l'invalidation immédiate
      console.log(`[PROXY SERVICE] Proxy invalidé suite à timeout de navigation: ${found.host}:${found.port}`);
    }
  }

  /**
   * Arguments Chromium pour Puppeteer
   */
  public getLaunchArgs(proxy: ProxyConfig | null): string[] {
    if (!proxy || !proxy.server) return [];
    return [`--proxy-server=${proxy.server}`];
  }

  /**
   * Statistiques pour l'interface UI
   */
  public getStats(): ProxyStats {
    let activeMode: "free_proxies" | "manual_proxies" | "direct_connection" = "direct_connection";
    if (this.manualProxies.length > 0) {
      activeMode = "manual_proxies";
    } else if (this.freeProxies.length > 0) {
      activeMode = "free_proxies";
    }

    return {
      manualCount: this.manualProxies.length,
      freeCount: this.freeProxies.length,
      healthyCount: this.freeProxies.filter((p) => (p.failCount || 0) === 0).length,
      activeMode,
      lastRefreshTime: this.lastFetchTime ? new Date(this.lastFetchTime).toLocaleTimeString() : null,
      lastTestedProxy: this.lastTestedInfo,
    };
  }
}

export const proxyService = new ProxyService();
