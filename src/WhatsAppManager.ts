import makeWASocket, {
    Browsers,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    WAMessage,
    BufferJSON
} from '@whiskeysockets/baileys'
import P from 'pino'
import NodeCache from 'node-cache'
import { EventEmitter } from 'events'

import { WhatsAppSession, StartConnectionData, SendMessageData, ConnectionUpdateData, MessageReceivedData } from './types'
import { AuthStateManager } from './authState'
import { DatabaseManager } from './database'
import { MediaProcessor } from './mediaProcessor'

// Define Session type similar to api-interagil
type Session = WhatsAppSession & {
    store?: any;
}

export class WhatsAppManager extends EventEmitter {
    private sessions: Map<string, Session> = new Map()
    private authManager: AuthStateManager
    private logger: any
    private connectionPromises: Map<string, Promise<Session>> = new Map()
    private deletedSessions: Set<string> = new Set()
    private pendingReconnects: Map<string, NodeJS.Timeout> = new Map()
    private retryAttempts: Map<string, number> = new Map()
    private maxRetryAttempts: number = 5
    private databaseManager: DatabaseManager
    private mediaProcessor: MediaProcessor
    private reconciliationTimer?: NodeJS.Timeout
    private sessionStates: Map<string, any> = new Map() // Track session states to prevent cross-contamination

    constructor() {
        super()
        this.databaseManager = new DatabaseManager()
        this.authManager = new AuthStateManager(this.databaseManager)

        // Create logger
        this.logger = P({
            level: 'info',
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard'
                }
            }
        })

        // Initialize media processor
        this.mediaProcessor = new MediaProcessor(this.logger.child({ level: 'error' }))


        // Start periodic reconciliation with database (DB is source of truth)
        this.startPeriodicReconciliation()
    }

    async initializeFromDatabase(): Promise<void> {
        try {
            this.logger.info('Initializing WhatsApp connections from database...')
            
            const dbConnections = await this.databaseManager.getAllWhatsappConnections()
            this.logger.info(`Found ${dbConnections.length} WhatsApp connections in database`)

            for (const dbConnection of dbConnections) {
                try {
                    const connectionData: StartConnectionData = {
                        id: dbConnection.id.toString(),
                        name: dbConnection.name,
                        companyId: dbConnection.companyId,
                        session: dbConnection.session
                    }

                    if (dbConnection.session) {
                        this.logger.info(`Attempting to restore session for ${dbConnection.name} (ID: ${dbConnection.id})`)
                        
                        try {
                            await this.startConnection(connectionData)
                        } catch (error) {
                            this.logger.warn(`Failed to restore session for ${dbConnection.name} (ID: ${dbConnection.id}), will create new session:`, error)
                            
                            connectionData.session = null
                            await this.startConnection(connectionData)
                        }
                    } else {
                        this.logger.info(`No existing session for ${dbConnection.name} (ID: ${dbConnection.id}), creating new session`)
                        await this.startConnection(connectionData)
                    }
                } catch (error) {
                    this.logger.error(`Failed to initialize connection for ${dbConnection.name} (ID: ${dbConnection.id}):`, error)
                }
            }

            this.logger.info('Database initialization completed')
        } catch (error) {
            this.logger.error('Error initializing connections from database:', error)
            throw error
        }
    }

    async startConnection(connectionData: StartConnectionData): Promise<{
        success: boolean
        message: string
        qrCode?: string
    }> {
        const { id } = connectionData

        try {
            // Check if session was explicitly deleted
            if (this.deletedSessions.has(id)) {
                this.logger.info(`Session ${id} was deleted, removing from deleted set and allowing new connection`)
                this.deletedSessions.delete(id)
            }

            // Check if connection already exists
            const existingSession = this.sessions.get(id)
            if (existingSession && existingSession.user) {
                this.logger.info(`Session ${id} already connected`)
                return {
                    success: true,
                    message: `Session ${id} already connected`
                }
            }

            // Check if connection is already in progress
            if (this.connectionPromises.has(id)) {
                this.logger.info(`Connection for ${id} already in progress`)
                const session = await this.connectionPromises.get(id)!
                return {
                    success: true,
                    message: `Connection for ${id} established`,
                    qrCode: session.qrCode
                }
            }

            const connectionPromise = this.createConnection(connectionData)
            this.connectionPromises.set(id, connectionPromise)

            try {
                const session = await connectionPromise
                this.connectionPromises.delete(id)

                return {
                    success: true,
                    message: `Session ${id} initialized`,
                    qrCode: session.qrCode
                }
            } catch (error) {
                this.connectionPromises.delete(id)
                throw error
            }
        } catch (error) {
            this.logger.error(`Error starting connection for ${id}:`, error)
            return {
                success: false,
                message: `Error starting connection: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
        }
    }

    /**
     * Start a lightweight periodic task to reconcile in-memory sessions with DB rows.
     * Any session that no longer exists in DB will be deleted from memory to prevent drift.
     */
    private startPeriodicReconciliation(intervalMs: number = 300_000): void {
        try {
            if (this.reconciliationTimer) {
                clearInterval(this.reconciliationTimer)
            }
            this.reconciliationTimer = setInterval(async () => {
                try {
                    this.logger.info('Reconciling sessions with database')
                    await this.reconcileSessionsWithDatabase()
                } catch (error) {
                    this.logger.error('Error during periodic reconciliation:', error)
                }
            }, intervalMs)
            this.logger.info(`Started periodic reconciliation every ${intervalMs}ms`)
        } catch (error) {
            this.logger.error('Failed to start periodic reconciliation:', error)
        }
    }

    /**
     * Reconcile the in-memory sessions map with the current WhatsApp rows from DB.
     * - Removes any in-memory session whose row no longer exists in DB
     * - Clears the deletedSessions set (it is not used for blocking and can grow unbounded)
     */
    private async reconcileSessionsWithDatabase(): Promise<void> {
        try {
            const dbConnections = await this.databaseManager.getAllWhatsappConnections()
            const dbIds = new Set<string>(dbConnections.map((c: any) => String(c.id)))

            for (const sessionId of Array.from(this.sessions.keys())) {
                if (!dbIds.has(sessionId)) {
                    this.logger.warn(`Reconciliation: session ${sessionId} not found in DB. Deleting in-memory session.`)
                    try {
                        await this.deleteSession(sessionId)
                    } catch (deleteError) {
                        this.logger.error(`Error deleting in-memory session ${sessionId} during reconciliation:`, deleteError)
                    }
                }
            }

            // Clear deletedSessions to avoid stale markers and memory growth.
            // This set is only checked in startConnection to remove entries and does not block reconnections.
            this.deletedSessions.clear()
        } catch (error) {
            this.logger.error('Failed to reconcile sessions with database:', error)
        }
    }

    private async createConnection(connectionData: StartConnectionData): Promise<Session> {
        const { id, name, companyId, session } = connectionData

        this.logger.info(`Creating WhatsApp connection for ${id} (${name})`)

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion()
            this.logger.info(`Using WA v${version.join('.')}, isLatest: ${isLatest}`)

            // Get authentication state
            const { state, saveState, exportStateData } = await this.authManager.getAuthState(id, session || undefined)
            
            // Store session state reference to prevent cross-contamination
            this.sessionStates.set(id, state)
            
            // Enhanced save state function that includes keys from the store
            const enhancedSaveState = async () => {
                try {
                    await saveState(state.creds)
                } catch (error) {
                    this.logger.error(`Error saving enhanced auth state for ${id}:`, error)
                }
            }

            const msgRetryCounterCache = new NodeCache()

            // Create dedicated error-only logger for Baileys to reduce noise
            const baileysLogger = P({
                level: 'error',
                transport: {
                    target: 'pino-pretty',
                    options: {
                        colorize: true,
                        translateTime: 'SYS:standard'
                    }
                }
            })

            // Create cacheable signal key store with proper error handling
            const keysStore = makeCacheableSignalKeyStore(state.keys, baileysLogger)

            // Create socket
            const wsocket = makeWASocket({
                logger: baileysLogger,
                printQRInTerminal: false,
                browser: Browsers.appropriate('Desktop'),
                auth: {
                    creds: state.creds,
                    keys: keysStore
                },
                version,
                msgRetryCounterCache,
                shouldIgnoreJid: (jid: string) => isJidBroadcast(jid),
                // Add connection stability settings
                // defaultQueryTimeoutMs: 60000,
                // keepAliveIntervalMs: 10000,
                // connectTimeoutMs: 60000,
                // retryRequestDelayMs: 250,
                maxMsgRetryCount: 2, // Reduce from 5 to 2 to minimize retry spam
            }) as Session

            // Set additional properties (like in api-interagil)
            wsocket.id = id
            wsocket.name = name
            wsocket.companyId = companyId
            wsocket.status = 'CONNECTING'

            return new Promise((resolve, reject) => {
                // Handle connection updates
                wsocket.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr, isNewLogin } = update

                    this.logger.info(`Connection update for ${id}: ${connection}`)

                    // Handle pairing completion - save session immediately
                    if (isNewLogin && connection === 'open') {
                        this.logger.info(`New login detected for ${id}, saving session...`)
                        try {
                            await enhancedSaveState()
                            this.logger.info(`Session saved successfully for ${id}`)
                            
                            // Update connection data with saved session for future restarts
                            const { creds, keys } = exportStateData()
                            const sessionData = JSON.stringify({ creds, keys }, BufferJSON.replacer)
                            connectionData.session = sessionData
                        } catch (error) {
                            this.logger.error(`Error saving session after new login for ${id}:`, error)
                        }
                    }

                    if (connection === 'close') {
                        const lastError = lastDisconnect?.error as any
                        const statusCode = lastError?.output?.statusCode
                        const isQrAttemptsEnded = (statusCode === 408 && lastError?.message === 'QR refs attempts ended')
                        const noRestartErrorCodes = [401, 403]

                        this.logger.info(`Connection closed for ${id}`)
                        this.logger.info(`Disconnect reason: ${lastError?.output?.statusCode}, Error: ${lastError?.message}`)

                        wsocket.status = 'DISCONNECTED'
                        this.removeSession(id)

                        if (statusCode && noRestartErrorCodes.includes(statusCode) || isQrAttemptsEnded ) {
                            this.logger.warn(`No restart needed for ${id}, disconnecting session`)
                            await this.databaseManager.updateWhatsappStatus(parseInt(id), 'DISCONNECTED')
                            this.emit('connectionUpdate', {
                                whatsappId: id,
                                status: 'DISCONNECTED',
                                error: `Connection closed for ${id}`
                            } as ConnectionUpdateData)

                            reject(new Error(`Connection closed for ${id}`))
                            return
                        } else {
                            this.logger.warn(`Restart needed for ${id}, restarting connection`)
                            try {
                                await this.handleStreamRestart(connectionData)
                            } catch (error) {
                                this.logger.error(`Error restarting connection for ${id}:`, error)
                            }
                        }

                        // Emit connection update
                        this.emit('connectionUpdate', {
                            whatsappId: id,
                            status: 'DISCONNECTED',
                            error: lastError?.message
                        } as ConnectionUpdateData)

                        reject(new Error(`Connection closed for ${id}`))
                    }

                    if (connection === 'open') {
                        this.logger.info(`${id} connected successfully`)

                        wsocket.status = 'CONNECTED'
                        this.sessions.set(id, wsocket)

                        // Update database status and clear QR code
                        try {
                            await this.databaseManager.updateWhatsappStatus(parseInt(id), 'CONNECTED')
                            await this.databaseManager.clearWhatsappQRCode(parseInt(id))
                        } catch (dbError) {
                            this.logger.error(`Error updating database status for ${id}:`, dbError)
                        }

                        // Emit connection update
                        this.emit('connectionUpdate', {
                            whatsappId: id,
                            status: 'CONNECTED'
                        } as ConnectionUpdateData)

                        resolve(wsocket)
                    }

                    if (qr !== undefined) {
                        this.logger.info(`QR code generated for ${id}`)

                        wsocket.status = 'QR_PENDING'
                        wsocket.qrCode = qr
                        this.sessions.set(id, wsocket)

                        // Print QR code in terminal
                        try {
                            // const qrString = await QRCode.toString(qr, {
                            //     type: 'terminal',
                            //     small: true
                            // })
                            //console.log(`\n🔲 QR Code for ${name} (ID: ${id}):\n`)
                            //console.log(qrString)
                            //console.log(`\nScan this QR code with your WhatsApp app to connect.\n`)
                        } catch (qrError) {
                            this.logger.error(`Error generating QR code for terminal for ${id}:`, qrError)
                        }

                        // Update database with QR code and status
                        try {
                            await this.databaseManager.updateWhatsappStatus(parseInt(id), 'QR_PENDING', qr)
                        } catch (dbError) {
                            this.logger.error(`Error updating database QR code for ${id}:`, dbError)
                        }

                        // Emit QR code
                        this.emit('qrGenerated', {
                            whatsappId: id,
                            qrCode: qr
                        })

                        // Emit connection update
                        this.emit('connectionUpdate', {
                            whatsappId: id,
                            status: 'QR_PENDING',
                            qrCode: qr
                        } as ConnectionUpdateData)
                    }
                })

                // Handle credential updates
                wsocket.ev.on('creds.update', async () => {
                    try {
                        await enhancedSaveState()
                        
                        // Update connection data with saved session for future restarts
                        const { creds, keys } = exportStateData()
                        const sessionData = JSON.stringify({ creds, keys }, BufferJSON.replacer)
                        connectionData.session = sessionData
                        
                        this.logger.info(`Credentials updated and saved for ${id}`)
                    } catch (error) {
                        this.logger.error(`Error saving credentials for ${id}:`, error)
                    }
                })

                // Handle incoming messages
                wsocket.ev.on('messages.upsert', (messageUpdate) => {
                    console.log('messages.upsert', JSON.stringify(messageUpdate))
                    const { messages, type } = messageUpdate
                    if (type === 'notify') {
                        for (const message of messages) {
                            // Check for session errors and handle them
                            if (message.messageStubType === 2) {
                                const stubParams = message.messageStubParameters || []
                                if (stubParams.includes('No matching sessions found for message') || 
                                    stubParams.includes('Invalid PreKey ID')) {
                                    this.logger.warn({ stubParams, whatsappId: wsocket.id }, 'Received session error stub for peer, relying on Baileys retry logic')
                                }
                            }
                            this.handleIncomingMessage(wsocket, message)
                        }
                    }
                })

                this.logger.info(`Session ${id} created without store dependency`)
            })
        } catch (error) {
            this.logger.error(`Error creating connection for ${id}:`, error)
            throw error
        }
    }

    private handleIncomingMessage(session: Session, message: WAMessage): void {
        try {
            // Ignore messages without content or error messages (messageStubType)
            if (!message.message || message.messageStubType) {
                if (message.messageStubType) {
                    this.logger.debug(`Ignoring message stub (error) type ${message.messageStubType} for session ${session.id}`)
                }
                return
            }

            const messageData: MessageReceivedData = {
                whatsappId: session.id,
                companyId: session.companyId || 0,
                from: '', // TODO: remove this field later
                message,
                timestamp: (message.messageTimestamp as number) || Date.now()
            }
    
            this.logger.info(`Processing message from ${message.key.remoteJid}) for session ${session.id}`)
    
            // Emit message received event
            this.emit('messageReceived', messageData)
        } catch (error) {
            this.logger.error(`Error handling incoming message for session ${session.id}:`, error)
        }
    }

    async sendMessage(sendData: SendMessageData, onlyAudio?: boolean): Promise<{
        // TODO: remove the or any later
        success: boolean
        messageId?: string
        error?: string
    } | any> {
        const { whatsappId, to, message, options = {} } = sendData

        try {
            const session = this.sessions.get(whatsappId)

            if (!session) {
                return {
                    success: false,
                    error: `WhatsApp session ${whatsappId} not found`
                }
            }

            if (!session.user) {
                return {
                    success: false,
                    error: `WhatsApp session ${whatsappId} not connected`
                }
            }

            // // Format phone number
            // let formattedNumber = to.replace(/\D/g, '')
            // if (!formattedNumber.includes('@')) {
            //     formattedNumber = `${formattedNumber}@s.whatsapp.net`
            // }
            // TODO: maybe Flowise didnot work anymore, since we are using the JID directly.

            //console.log('formattedNumber', formattedNumber)
            console.log('message', JSON.stringify(message))
            console.log('options', JSON.stringify(options))

            // Process message for media files using the MediaProcessor
            const mediaProcessingResult = await this.mediaProcessor.processMessageMedia(message, onlyAudio)
            if (!mediaProcessingResult.success) {
                return {
                    success: false,
                    error: mediaProcessingResult.error
                }
            }

            const processedMessage = mediaProcessingResult.processedMessage

            // Debug: Log before sending to track session state corruption
            this.logger.debug(`About to send message to ${to} via session ${whatsappId}`)

            // Send message with properly formatted data
            // to is JID
            const sentMessage = await session.sendMessage(to, processedMessage as any, options)

            // Debug: Log after sending
            this.logger.debug(`Message sent, checking session state for ${whatsappId}`)

            this.logger.info(`Message sent successfully to ${to} via session ${whatsappId}`)
            return sentMessage
            // TODO: this is the return expected by the flowise, we need to fix later.
            // return {
            //     success: true,
            //     messageId: sentMessage?.key?.id || undefined
            // }
        } catch (error) {
            this.logger.error(`Error sending message via session ${whatsappId}:`, error)
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            }
        }
    }

    private removeSession(whatsappId: string): void {
        this.sessions.delete(whatsappId)
        this.logger.info(`Session ${whatsappId} removed from memory`)
    }

    async disconnectSession(whatsappId: string): Promise<boolean> {
        try {
            const session = this.sessions.get(whatsappId)
            if (session) {
                await session.logout()
                await this.authManager.deleteAuthState(whatsappId)
                return true
            }
            return false
        } catch (error) {
            this.logger.error(`Error disconnecting session ${whatsappId}:`, error)
            return false
        }
    }

    async deleteSession(whatsappId: string): Promise<boolean> {
        try {
            this.logger.info(`Deleting session ${whatsappId} (removed from database)`)
            
            // Mark session as deleted to prevent reconnections
            this.deletedSessions.add(whatsappId)
            
            // Cancel any pending reconnection timeouts
            const pendingTimeout = this.pendingReconnects.get(whatsappId)
            if (pendingTimeout) {
                clearTimeout(pendingTimeout)
                this.pendingReconnects.delete(whatsappId)
                this.logger.info(`Cancelled pending reconnection timeout for session ${whatsappId}`)
            }
            
            // Clear retry attempts for this session
            this.retryAttempts.delete(whatsappId)
            
            // Clean up the session from memory
            await this.cleanupSession(whatsappId)
            
            // Note: No need to delete auth state since the database record was already deleted
            // The session data is stored in the database, not in files anymore
            
            this.logger.info(`Session ${whatsappId} deleted successfully`)
            return true
        } catch (error) {
            this.logger.error(`Error deleting session ${whatsappId}:`, error)
            return false
        }
    }

    async exportSession(whatsappId: string): Promise<string | null> {
        return await this.authManager.exportAuthState(whatsappId)
    }

    // Add method to reset connection
    async resetConnection(whatsappId: string): Promise<boolean> {
        try {
            this.logger.info(`Resetting connection for ${whatsappId}`)

            // Disconnect existing session if any
            const existingSession = this.sessions.get(whatsappId)
            if (existingSession) {
                try {
                    // Close the websocket connection if it exists
                    if (existingSession.ws) {
                        existingSession.ws.close()
                    }
                } catch (error) {
                    this.logger.warn(`Error closing existing websocket for ${whatsappId}:`, error)
                }
                this.removeSession(whatsappId)
            }

            return true
        } catch (error) {
            this.logger.error(`Error resetting connection for ${whatsappId}:`, error)
            return false
        }
    }

    // Add method to handle automatic restart for stream errors
    private async handleStreamRestart(connectionData: StartConnectionData): Promise<void> {
        const { id } = connectionData

        try {
            // Get current retry count
            const currentRetries = this.retryAttempts.get(id) || 0
            
            if (currentRetries >= this.maxRetryAttempts) {
                this.logger.error(`Max retry attempts (${this.maxRetryAttempts}) reached for session ${id}. Not attempting restart.`)
                this.retryAttempts.delete(id)
                
                // Update database status to DISCONNECTED
                try {
                    await this.databaseManager.updateWhatsappStatus(parseInt(id), 'DISCONNECTED')
                } catch (dbError) {
                    this.logger.error(`Error updating database status after max retries for ${id}:`, dbError)
                }
                
                return
            }

            // Increment retry count
            this.retryAttempts.set(id, currentRetries + 1)
            
            // Calculate exponential backoff delay (base: 2 seconds, max: 30 seconds)
            const baseDelay = 2000
            const maxDelay = 30000
            const delay = Math.min(baseDelay * Math.pow(2, currentRetries), maxDelay)
            
            this.logger.info(`Stream error detected for ${id}. Attempting restart in ${delay}ms (attempt ${currentRetries + 1}/${this.maxRetryAttempts})`)

            // Schedule restart after delay
            const restartTimeout = setTimeout(async () => {
                try {
                    this.pendingReconnects.delete(id)
                    
                    this.logger.info(`Starting automatic restart for session ${id} after stream error`)
                    
                    // Clean up existing session completely
                    await this.cleanupSession(id)
                    
                    // Clear any existing connection promises
                    this.connectionPromises.delete(id)
                    
                    // Start new connection
                    const result = await this.startConnection(connectionData)
                    
                    if (result.success) {
                        this.logger.info(`Successfully restarted session ${id} after stream error`)
                        // Reset retry count on successful connection
                        this.retryAttempts.delete(id)
                    } else {
                        this.logger.warn(`Failed to restart session ${id} after stream error: ${result.message}`)
                        // The retry will be handled by the next connection.update event if it fails again
                    }
                } catch (error) {
                    this.logger.error(`Error during automatic restart for session ${id}:`, error)
                    // Schedule another retry if we haven't reached max attempts
                    await this.handleStreamRestart(connectionData)
                }
            }, delay)
            
            // Store the timeout so it can be cancelled if needed
            this.pendingReconnects.set(id, restartTimeout)
            
        } catch (error) {
            this.logger.error(`Error setting up stream error restart for ${id}:`, error)
        }
    }

    private async cleanupSession(sessionId: string): Promise<void> {
        try {
            const session = this.sessions.get(sessionId)
            if (session) {
                try {
                    // Close the connection gracefully
                    session.end(undefined)
                } catch (endError) {
                    this.logger.warn(`Error ending session ${sessionId} gracefully:`, endError)
                }
                
                // Remove event listeners to prevent memory leaks
                if (session.ev) {
                    session.ev.removeAllListeners('connection.update')
                    session.ev.removeAllListeners('creds.update') 
                    session.ev.removeAllListeners('messages.upsert')
                }
            }
            
            // Clean up all related data
            this.sessions.delete(sessionId)
            this.connectionPromises.delete(sessionId)
            this.sessionStates.delete(sessionId) // Clean up session state reference
            
            // Cancel any pending reconnection timeouts
            const pendingTimeout = this.pendingReconnects.get(sessionId)
            if (pendingTimeout) {
                clearTimeout(pendingTimeout)
                this.pendingReconnects.delete(sessionId)
            }
            
            // Clear retry attempts and tracking data
            this.retryAttempts.delete(sessionId)

            this.logger.info(`Session ${sessionId} cleaned up successfully`)
        } catch (error) {
            this.logger.error(`Error cleaning up session ${sessionId}:`, error)
        }
    }

    /**
     * Generic method to call any method on a WhatsApp socket instance
     * This enables the RPC pattern without needing to replicate each method
     */
    async callSocketMethod(methodName: string, whatsappId: string, ...args: any[]): Promise<any> {
        try {
            if (!whatsappId) {
                throw new Error('WhatsApp ID is required for socket method calls')
            }

            const session = this.sessions.get(whatsappId)
            if (!session) {
                throw new Error(`WhatsApp session ${whatsappId} not found`)
            }

            if (methodName === 'profilePictureUrl') {
                // log the args
                this.logger.info({ args }, `Profile picture URL args`)
            }

            // Special handling for sendMessage to leverage internal media processing (ffmpeg, etc.)
            if (methodName === 'sendMessage') {
                const [jidOrNumber, content, options] = args

                if (!jidOrNumber) {
                    throw new Error('JID/number is required for sendMessage')
                }
                if (!content || typeof content !== 'object') {
                    throw new Error('Valid message content is required for sendMessage')
                }

                this.logger.info({ sessionId: session.id, jidOrNumber }, `Routing 'sendMessage' through WhatsAppManager.sendMessage for media processing`)

                const result = await this.sendMessage({
                    whatsappId,
                    to: String(jidOrNumber),
                    message: content,
                    options,
                }, 
                    true // onlyAudio will be processed by the mediaProcessor
                )

                return result
            }

            // Check if the method exists on the session
            if (typeof (session as any)[methodName] !== 'function') {
                throw new Error(`Method '${methodName}' is not available on WhatsApp socket`)
            }

            this.logger.info({ methodName, sessionId: session.id, args }, `Calling socket method '${methodName}' on session ${session.id} with ${args.length} arguments`)

            // Call the method with the provided arguments
            const result = await (session as any)[methodName](...args)
            
            this.logger.info(`Socket method '${methodName}' completed successfully`)
            return result

        } catch (error) {
            this.logger.error(`Error calling socket method '${methodName}':`, error)
            throw error
        }
    }

    async shutdown(): Promise<void> {
        this.logger.info('Shutting down WhatsAppManager...')
        
        // Stop periodic reconciliation
        if (this.reconciliationTimer) {
            clearInterval(this.reconciliationTimer)
            this.reconciliationTimer = undefined
        }

        // Disconnect all sessions
        const disconnectPromises = Array.from(this.sessions.keys()).map(async (sessionId) => {
            try {
                await this.cleanupSession(sessionId)
            } catch (error) {
                this.logger.error(`Error disconnecting session ${sessionId} during shutdown:`, error)
            }
        })
        
        await Promise.allSettled(disconnectPromises)
        this.logger.info('WhatsAppManager shutdown completed')
    }
}
