import WebSocket from 'ws'
import { v4 as uuidv4 } from 'uuid'
import { WhatsAppManager } from './WhatsAppManager'
import { WSMessage, StartConnectionData, SendMessageData, ConnectionUpdateData, MessageReceivedData } from './types'

class WhatsAppWebSocketServer {
    private wss: WebSocket.Server
    private whatsappManager: WhatsAppManager
    private clients: Map<string, WebSocket> = new Map()
    private port: number

    constructor(port: number = 8086) {
        this.port = port
        this.whatsappManager = new WhatsAppManager()
        this.wss = new WebSocket.Server({ port })

        this.setupEventListeners()
        this.setupWebSocketHandlers()
        this.initializeConnections()

        console.log(`🚀 WhatsApp WebSocket Server started on port ${port}`)
    }

    private async initializeConnections(): Promise<void> {
        try {
            console.log('🔄 Initializing WhatsApp connections from database...')
            await this.whatsappManager.initializeFromDatabase()
            console.log('✅ WhatsApp connections initialized successfully')
        } catch (error) {
            console.error('❌ Failed to initialize WhatsApp connections:', error)
        }
    }

    private setupEventListeners(): void {
        // Listen to WhatsApp events and broadcast to all connected clients
        this.whatsappManager.on('connectionUpdate', (data: ConnectionUpdateData) => {
            this.broadcastToClients({
                type: 'connectionUpdate',
                data
            })
        })

        this.whatsappManager.on('messageReceived', (data: MessageReceivedData) => {
            this.broadcastToClients({
                type: 'messageReceived',
                data
            })
        })

        this.whatsappManager.on('qrGenerated', (data: { whatsappId: string; qrCode: string }) => {
            this.broadcastToClients({
                type: 'qrGenerated',
                data
            })
        })
    }

    private setupWebSocketHandlers(): void {
        this.wss.on('connection', (ws: WebSocket) => {
            const clientId = uuidv4()
            this.clients.set(clientId, ws)

            console.log(`📱 Client connected: ${clientId} (Total: ${this.clients.size})`)

            // Send welcome message
            this.sendToClient(ws, {
                type: 'connectionUpdate',
                data: { message: `Connected to WhatsApp WebSocket Server. Client ID: ${clientId}` }
            })

            ws.on('message', async (data: WebSocket.Data) => {
                try {
                    const message: WSMessage = JSON.parse(data.toString())
                    await this.handleMessage(ws, message)
                } catch (error) {
                    this.sendToClient(ws, {
                        type: 'error',
                        error: `Invalid message format: ${error instanceof Error ? error.message : 'Unknown error'}`
                    })
                }
            })

            ws.on('close', () => {
                this.clients.delete(clientId)
                console.log(`📱 Client disconnected: ${clientId} (Total: ${this.clients.size})`)
            })

            ws.on('error', (error) => {
                console.error(`❌ WebSocket error for client ${clientId}:`, error)
                this.clients.delete(clientId)
            })
        })
    }

    private async handleMessage(ws: WebSocket, message: WSMessage): Promise<void> {
        const { type, data, id } = message

        try {
            switch (type) {
                case 'startConnection': {
                    const result = await this.whatsappManager.startConnection(data as StartConnectionData)
                    this.sendToClient(ws, {
                        type: 'connectionUpdate',
                        id,
                        data: result
                    })
                    break
                }

                case 'sendMessage': {
                    const sendResult = await this.whatsappManager.sendMessage(data as SendMessageData)
                    this.sendToClient(ws, {
                        type: 'messageReceived',
                        id,
                        data: sendResult
                    })
                    break
                }

                case 'resetConnection': {
                    const whatsappId = data?.whatsappId
                    if (whatsappId) {
                        const result = await this.whatsappManager.resetConnection(whatsappId)
                        this.sendToClient(ws, {
                            type: 'connectionUpdate',
                            id,
                            data: { success: result, message: result ? 'Connection reset successfully' : 'Failed to reset connection' }
                        })
                    } else {
                        this.sendToClient(ws, {
                            type: 'error',
                            id,
                            error: 'WhatsApp ID is required for connection reset'
                        })
                    }
                    break
                }



                case 'deleteSession': {
                    const whatsappId = data?.whatsappId
                    if (whatsappId) {
                        const result = await this.whatsappManager.deleteSession(whatsappId)
                        this.sendToClient(ws, {
                            type: 'connectionUpdate',
                            id,
                            data: { 
                                success: result, 
                                message: result ? 'Session deleted successfully' : 'Failed to delete session',
                                whatsappId
                            }
                        })
                    } else {
                        this.sendToClient(ws, {
                            type: 'error',
                            id,
                            error: 'WhatsApp ID is required for session deletion'
                        })
                    }
                    break
                }

                case 'disconnectSession': {
                    const whatsappId = data?.whatsappId
                    if (whatsappId) {
                        const result = await this.whatsappManager.disconnectSession(whatsappId)
                        this.sendToClient(ws, {
                            type: 'connectionUpdate',
                            id,
                            data: {
                                success: result,
                                message: result ? 'Session disconnected successfully' : 'Failed to disconnect session',
                                whatsappId
                            }
                        })
                    } else {
                        this.sendToClient(ws, {
                            type: 'error',
                            id,
                            error: 'WhatsApp ID is required for session disconnection'
                        })
                    }
                    break
                }

                case 'callSocketMethod': {
                    const { methodName, whatsappId, args } = data || {}
                    
                    if (!methodName) {
                        this.sendToClient(ws, {
                            type: 'error',
                            id,
                            error: 'Method name is required for callSocketMethod'
                        })
                        break
                    }

                    if (!whatsappId) {
                        this.sendToClient(ws, {
                            type: 'error',
                            id,
                            error: 'WhatsApp ID is required for callSocketMethod'
                        })
                        break
                    }

                    // Whitelist of allowed methods for security
                    const allowedMethods = [
                        'onWhatsApp',
                        'logout',
                        'sendMessage',
                        'groupMetadata',
                        'fetchStatus',
                        'fetchBlocklist',
                        'profilePictureUrl',
                        'getBusinessProfile'
                        // Add more makeWASocket methods as needed
                    ]

                    if (!allowedMethods.includes(methodName)) {
                        this.sendToClient(ws, {
                            type: 'error',
                            id,
                            error: `Method '${methodName}' is not allowed`
                        })
                        break
                    }

                    try {
                        // Call the method on WhatsAppManager, which will delegate to the actual makeWASocket instance
                        const result = await this.whatsappManager.callSocketMethod(methodName, whatsappId, ...(args || []))
                        
                        this.sendToClient(ws, {
                            type: 'socketMethodResult',
                            id,
                            data: result
                        })
                    } catch (error) {
                        console.error(`Error calling method '${methodName}': ${error instanceof Error ? error.message : 'Unknown error'}`)
                        this.sendToClient(ws, {
                            type: 'error',
                            id,
                            error: `Error calling method '${methodName}': ${error instanceof Error ? error.message : 'Unknown error'}`
                        })
                    }
                    break
                }

                default:
                    this.sendToClient(ws, {
                        type: 'error',
                        id,
                        error: `Unknown message type: ${type}`
                    })
            }
        } catch (error) {
            this.sendToClient(ws, {
                type: 'error',
                id,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            })
        }
    }

    private sendToClient(ws: WebSocket, message: WSMessage): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message))
        }
    }

    private broadcastToClients(message: WSMessage): void {
        this.clients.forEach((ws) => {
            this.sendToClient(ws, message)
        })
    }

}

//Start the server
const port = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT) : 8086
new WhatsAppWebSocketServer(port)

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down WhatsApp WebSocket Server...')
    process.exit(0)
})

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down WhatsApp WebSocket Server...')
    process.exit(0)
})

export { WhatsAppWebSocketServer }
