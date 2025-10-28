import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  SignalDataTypeMap,
  proto,
} from "@whiskeysockets/baileys";
import { DatabaseManager } from "./database";

const KEY_MAP = {
  "pre-key": "preKeys",
  session: "sessions",
  "sender-key": "senderKeys",
  "app-state-sync-key": "appStateSyncKeys",
  "app-state-sync-version": "appStateVersions",
  "sender-key-memory": "senderKeyMemory",
  // Additional mappings required by SignalDataTypeMap (v7 requires lid-mapping & device-index)
  "lid-mapping": "lidMappings",
  // Some versions expose device-index, others device-list. Include both for compatibility.
  "device-index": "deviceIndexes",
  "device-list": "deviceLists",
} as unknown as { [T in keyof SignalDataTypeMap]: string };

export class AuthStateManager {
  private databaseManager: DatabaseManager;

  constructor(databaseManager?: DatabaseManager) {
    this.databaseManager = databaseManager || new DatabaseManager();
  }

  async getAuthState(
    sessionId: string,
    initialSession?: string
  ): Promise<{
    state: AuthenticationState;
    saveState: (creds: AuthenticationCreds) => Promise<void>;
    exportStateData: () => { creds: AuthenticationCreds; keys: any };
  }> {
    let creds: AuthenticationCreds;
    let keys: any = {};
    let saveInProgress = false;
    let pendingSave = false;

    const saveState = async (updatedCreds: AuthenticationCreds) => {
      try {
        // persist the internal raw keys object, not the keystore interface
        creds = updatedCreds;

        // Prevent concurrent saves that can corrupt session state
        if (saveInProgress) {
          pendingSave = true;
          return;
        }

        saveInProgress = true;
        const sessionData = JSON.stringify(
          { creds, keys },
          BufferJSON.replacer
        );
        await this.databaseManager.updateWhatsappSession(
          parseInt(sessionId),
          sessionData
        );
        saveInProgress = false;

        // If there was a pending save, execute it now
        if (pendingSave) {
          pendingSave = false;
          await saveState(creds);
        }
      } catch (error) {
        saveInProgress = false;
        console.error(
          `Error saving auth state to database for ${sessionId}:`,
          error
        );
      }
    };

    try {
      // Try to load existing session
      if (initialSession) {
        // Use provided session data (from database)
        const result = JSON.parse(initialSession, BufferJSON.reviver);
        creds = result.creds;
        keys = result.keys;
      } else {
        // Create new session
        creds = initAuthCreds();
        keys = {};
      }
    } catch (error) {
      console.error(`Error loading auth state for ${sessionId}:`, error);
      // Fallback to new credentials
      creds = initAuthCreds();
      keys = {};
    }

    return {
      state: {
        creds,
        keys: {
          get: (type, ids) => {
            const key = KEY_MAP[type];
            return ids.reduce((dict: any, id) => {
              let value = keys[key]?.[id];
              if (value) {
                if (type === "app-state-sync-key") {
                  // Baileys v7 removed fromObject; use create()
                  value = proto.Message.AppStateSyncKeyData.create(value);
                }
                dict[id] = value;
              }
              return dict;
            }, {});
          },
          set: (data: any) => {
            // eslint-disable-next-line no-restricted-syntax, guard-for-in
            for (const i in data) {
              const key = KEY_MAP[i as keyof SignalDataTypeMap];
              keys[key] = keys[key] || {};
              Object.assign(keys[key], data[i]);
            }
            // Auto-save to database when keys are updated (debounced to prevent race conditions)
            saveState(creds).catch((error) => {
              console.error(
                `Error in keys.set saveState for ${sessionId}:`,
                error
              );
            });
          },
        },
      },
      saveState,
      exportStateData: () => ({ creds, keys }),
    };
  }

  async deleteAuthState(sessionId: string): Promise<void> {
    try {
      // Clear session data from database
      await this.databaseManager.updateWhatsappSession(parseInt(sessionId), "");
    } catch (error) {
      console.error(
        `Error deleting auth state from database for ${sessionId}:`,
        error
      );
    }
  }

  async exportAuthState(sessionId: string): Promise<string | null> {
    try {
      // Get session data from database
      const dbConnection = await this.databaseManager.getWhatsappConnection(
        parseInt(sessionId)
      );
      return dbConnection?.session || null;
    } catch (error) {
      console.error(`Error exporting auth state for ${sessionId}:`, error);
    }
    return null;
  }
}
