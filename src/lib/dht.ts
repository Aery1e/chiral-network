// DHT configuration and utilities
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings } from "./stores";
import { homeDir, join } from "@tauri-apps/api/path";
//importing reputation store for the reputation based peer discovery
import ReputationStore from "$lib/reputationStore";
const __rep = ReputationStore.getInstance();

// Default bootstrap nodes for network connectivity
export const DEFAULT_BOOTSTRAP_NODES = [
  "/ip4/145.40.118.135/tcp/4001/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
  "/ip4/139.178.91.71/tcp/4001/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
  "/ip4/147.75.87.27/tcp/4001/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
  "/ip4/139.178.65.157/tcp/4001/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
  "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
  "/ip4/54.198.145.146/tcp/4001/p2p/12D3KooWNHdYWRTe98KMF1cDXXqGXvNjd1SAchDaeP5o4MsoJLu2",
];

export type NatReachabilityState = "unknown" | "public" | "private";
export type NatConfidence = "low" | "medium" | "high";

export interface NatHistoryItem {
  state: NatReachabilityState;
  confidence: NatConfidence;
  timestamp: number;
  summary?: string | null;
}

export interface DhtConfig {
  port: number;
  bootstrapNodes: string[];
  showMultiaddr?: boolean;
  enableAutonat?: boolean;
  autonatProbeIntervalSeconds?: number;
  autonatServers?: string[];
  proxyAddress?: string;
  chunkSizeKb?: number;
  cacheSizeMb?: number;
}

export interface FileMetadata {
  fileHash: string;
  fileName: string;
  fileSize: number;
  fileData?: Uint8Array | number[];
  seeders: string[];
  createdAt: number;
  mimeType?: string;
  isEncrypted: boolean;
  encryptionMethod?: string;
  keyFingerprint?: string;
  version?: number;
  manifest?: string;
}

export interface FileManifestForJs {
  merkleRoot: string;
  chunks: any[]; // Define a proper type for ChunkInfo if you can
  encryptedKeyBundle: string; // This is the JSON string
}

export const encryptionService = {
  async encryptFile(filePath: string): Promise<FileManifestForJs> {
    return await invoke('encrypt_file_for_upload', { filePath });
  },

  async decryptFile(manifest: FileManifestForJs, outputPath: string): Promise<void> {
    await invoke('decrypt_and_reassemble_file', { manifestJs: manifest, outputPath });
  }
};

export interface DhtHealth {
  peerCount: number;
  lastBootstrap: number | null;
  lastPeerEvent: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  bootstrapFailures: number;
  listenAddrs: string[];
  reachability: NatReachabilityState;
  reachabilityConfidence: NatConfidence;
  lastReachabilityChange: number | null;
  lastProbeAt: number | null;
  lastReachabilityError: string | null;
  observedAddrs: string[];
  reachabilityHistory: NatHistoryItem[];
  autonatEnabled: boolean;
}

export class DhtService {
  private static instance: DhtService | null = null;
  private peerId: string | null = null;
  private port: number = 4001;

  private constructor() {}

  static getInstance(): DhtService {
    if (!DhtService.instance) {
      DhtService.instance = new DhtService();
    }
    return DhtService.instance;
  }

  setPeerId(peerId: string | null): void {
    this.peerId = peerId;
  }

  async start(config?: Partial<DhtConfig>): Promise<string> {
    const port = config?.port || 4001;
    let bootstrapNodes = config?.bootstrapNodes || [];

    // Use default bootstrap nodes if none provided
    if (bootstrapNodes.length === 0) {
      bootstrapNodes = DEFAULT_BOOTSTRAP_NODES;
      console.log("Using default bootstrap nodes for network connectivity");
    } else {
      console.log(`Using ${bootstrapNodes.length} custom bootstrap nodes`);
    }

    try {
      const payload: Record<string, unknown> = {
        port,
        bootstrapNodes,
      };
      if (typeof config?.enableAutonat === "boolean") {
        payload.enableAutonat = config.enableAutonat;
      }
      if (typeof config?.autonatProbeIntervalSeconds === "number") {
        payload.autonatProbeIntervalSecs = config.autonatProbeIntervalSeconds;
      }
      if (config?.autonatServers && config.autonatServers.length > 0) {
        payload.autonatServers = config.autonatServers;
      }
      if (
        typeof config?.proxyAddress === "string" &&
        config.proxyAddress.trim().length > 0
      ) {
        payload.proxyAddress = config.proxyAddress;
      }
      if (typeof config?.chunkSizeKb === "number") {
        payload.chunkSizeKb = config.chunkSizeKb;
      }
      if (typeof config?.cacheSizeMb === "number") {
        payload.cacheSizeMb = config.cacheSizeMb;
      }

      const peerId = await invoke<string>("start_dht_node", payload);
      this.peerId = peerId;
      this.port = port;
      console.log("DHT started with peer ID:", this.peerId);
      console.log("Your multiaddr for others to connect:", this.getMultiaddr());
      return this.peerId;
    } catch (error) {
      console.error("Failed to start DHT:", error);
      this.peerId = null; // Clear on failure
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await invoke("stop_dht_node");
      this.peerId = null;
      console.log("DHT stopped");
    } catch (error) {
      console.error("Failed to stop DHT:", error);
      throw error;
    }
  }

  async publishFile(metadata: FileMetadata): Promise<void> {
    if (!this.peerId) {
      throw new Error("DHT not started");
    }

    try {
      await invoke("publish_file_metadata", {
        fileHash: metadata.fileHash,
        fileName: metadata.fileName,
        fileSize: metadata.fileSize,
        mimeType: metadata.mimeType,
      });
      console.log("Published file metadata:", metadata.fileHash);
    } catch (error) {
      console.error("Failed to publish file:", error);
      throw error;
    }
  }

  async publishFileToNetwork(filePath: string): Promise<FileMetadata> {
    try {
      // Start listening for the published_file event
      const metadataPromise = new Promise<FileMetadata>((resolve, reject) => {
        const unlistenPromise = listen<FileMetadata>(
          "published_file",
          (event) => {
            resolve(event.payload);
            // Unsubscribe once we got the event
            unlistenPromise.then((unlistenFn) => unlistenFn());
          }
        );
      });

      // Trigger the backend upload
      await invoke("upload_file_to_network", { filePath });

      // Wait until the event arrives
      return await metadataPromise;
    } catch (error) {
      console.error("Failed to publish file:", error);
      throw error;
    }
  }

  async downloadFile(fileMetadata: FileMetadata): Promise<FileMetadata> {
    try {
      console.log("Initiating download for file:", fileMetadata.fileHash);
      // Start listening for the published_file event
      const metadataPromise = new Promise<FileMetadata>((resolve, reject) => {
        const unlistenPromise = listen<FileMetadata>(
          "file_content",
          async (event) => {
            console.log("Received file content event:", event.payload);
            const stored = localStorage.getItem("chiralSettings");
            let storagePath = "."; // Default fallback

            if (stored) {
              try {
                const loadedSettings: AppSettings = JSON.parse(stored);
                storagePath = loadedSettings.storagePath;
              } catch (e) {
                console.error("Failed to load settings:", e);
              }
            }
            if (event.payload.fileData) {
              //
              // Construct full file path
              let resolvedStoragePath = storagePath;

              if (storagePath.startsWith("~")) {
                const home = await homeDir();
                resolvedStoragePath = storagePath.replace("~", home);
              }
              resolvedStoragePath += "/" + event.payload.fileName;
              // Convert to Uint8Array if needed
              const fileData =
                event.payload.fileData instanceof Uint8Array
                  ? event.payload.fileData
                  : new Uint8Array(event.payload.fileData);

              // Write file to disk
              console.log(`File saved to: ${resolvedStoragePath}`);

              await invoke("write_file", { path: resolvedStoragePath, contents: Array.from(fileData) });
              console.log(`File saved to: ${resolvedStoragePath}`);
            }

            resolve(event.payload);
            // Unsubscribe once we got the event
            unlistenPromise.then((unlistenFn) => unlistenFn());
          }
        );
      });

      // Trigger the backend upload
      await invoke("download_blocks_from_network", { fileMetadata });

      // Wait until the event arrives
      return await metadataPromise;
    } catch (error) {
      console.error("Failed to publish file:", error);
      throw error;
    }
  }

  async searchFile(fileHash: string): Promise<void> {
    if (!this.peerId) {
      throw new Error("DHT not started");
    }

    try {
      await invoke("search_file_metadata", { fileHash, timeoutMs: 0 });
      console.log("Searching for file:", fileHash);
    } catch (error) {
      console.error("Failed to search file:", error);
      throw error;
    }
  }

  async connectPeer(peerAddress: string): Promise<void> {
    // Note: We check peerId to ensure DHT was started, but the actual error
    // might be from the backend saying networking isn't implemented
    if (!this.peerId) {
      console.error(
        "DHT service peerId not set, service may not be initialized"
      );
      throw new Error("DHT service not initialized properly");
    }

    // ADD: parse a peerId from /p2p/<id> if present; if not, use addr
    const __pid = (peerAddress?.split("/p2p/")[1] ?? peerAddress)?.trim();
    if (__pid) {
      // Mark we’ve seen this peer (freshness)
      try { __rep.noteSeen(__pid); } catch {}
    }

    try {
      await invoke("connect_to_peer", { peerAddress });
      console.log("Connecting to peer:", peerAddress);

      // ADD: count a success (no RTT here, the backend doesn’t expose it)
      if (__pid) {
        try { __rep.success(__pid); } catch {}
      }
    } catch (error) {
      console.error("Failed to connect to peer:", error);

      // ADD: count a failure so low-quality peers drift down
      if (__pid) {
        try { __rep.failure(__pid); } catch {}
      }
      throw error;
    }
  }

  getPeerId(): string | null {
    return this.peerId;
  }

  getPort(): number {
    return this.port;
  }

  getMultiaddr(): string | null {
    if (!this.peerId) return null;
    return `/ip4/127.0.0.1/tcp/${this.port}/p2p/${this.peerId}`;
  }

  async getPeerCount(): Promise<number> {
    try {
      const count = await invoke<number>("get_dht_peer_count");
      return count;
    } catch (error) {
      console.error("Failed to get peer count:", error);
      return 0;
    }
  }

  async getHealth(): Promise<DhtHealth | null> {
    try {
      const health = await invoke<DhtHealth | null>("get_dht_health");
      return health;
    } catch (error) {
      console.error("Failed to get DHT health:", error);
      return null;
    }
  }

  async searchFileMetadata(
    fileHash: string,
    timeoutMs = 10_000
  ): Promise<FileMetadata | null> {
    const trimmed = fileHash.trim();
    if (!trimmed) {
      throw new Error("File hash is required");
    }

    try {
      // Start listening for the search_result event
      const metadataPromise = new Promise<FileMetadata | null>(
        (resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error(`Search timeout after ${timeoutMs}ms`));
          }, timeoutMs);

          const unlistenPromise = listen<FileMetadata | null>(
            "found_file",
            (event) => {
              clearTimeout(timeoutId);
              const result = event.payload;
              // ADDING FOR REPUTATION BASED PEER DISCOVERY: mark discovered providers as "seen" for freshness
              try {
                if (result && Array.isArray(result.seeders)) {
                  for (const addr of result.seeders) {
                    // Extract peer ID from multiaddr if present
                    const pid = (addr?.split("/p2p/")[1] ?? addr)?.trim();
                    if (pid) __rep.noteSeen(pid);
                  }
                }
              } catch (e) {
                console.warn("reputation noteSeen failed:", e);
              }
              resolve(
                result
                  ? {
                      ...result,
                      seeders: Array.isArray(result.seeders)
                        ? result.seeders
                        : [],
                    }
                  : null
              );
              // Unsubscribe once we got the event
              unlistenPromise.then((unlistenFn) => unlistenFn());
            }
          );
        }
      );

      // Trigger the backend search
      await invoke("search_file_metadata", {
        fileHash: trimmed,
        timeoutMs,
      });

      // Wait until the event arrives
      return await metadataPromise;
    } catch (error) {
      console.error("Failed to search file metadata:", error);
      throw error;
    }
  }
}

// Export singleton instance
export const dhtService = DhtService.getInstance();
