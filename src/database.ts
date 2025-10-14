import 'dotenv/config';
import { Client } from 'pg'
import P from 'pino'

export interface WhatsappConnection {
    id: number
    name: string
    session: string | null
    status: string | null
    qrcode: string | null
    companyId: number
    token: string | null
    greetingMessage: string
    completionMessage: string
    outOfHoursMessage: string
    ratingMessage: string
    isDefault: boolean
    transferQueueId: number | null
    timeToTransfer: number | null
    expiresInactiveMessage: string | null
    flowIdWelcome: number | null
    createdAt: Date
    updatedAt: Date
}

export class DatabaseManager {
    private client: Client | null = null
    private logger: any
    private config: {
        type: string
        host: string
        port: number
        user: string
        password: string
        database: string
        ssl: boolean
        logging: boolean
    }

    constructor() {
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

        this.config = {
            type: process.env.APPWEB_DATABASE_TYPE || 'postgres',
            host: process.env.APPWEB_DATABASE_HOST || '127.0.0.1',
            port: parseInt(process.env.APPWEB_DATABASE_PORT || '5432'),
            user: process.env.APPWEB_DATABASE_USER || 'my_user22',
            password: process.env.APPWEB_DATABASE_PASSWORD || 'my_password',
            database: process.env.APPWEB_DATABASE_NAME || 'my_database',
            ssl: process.env.APPWEB_DATABASE_SSL === 'true',
            logging: process.env.APPWEB_DATABASE_LOGGING === 'true'
        }

        if (this.config.logging) {
            this.logger.info('Database configuration:', {
                ...this.config,
                password: '***'
            })
        }
    }

    async connect(): Promise<void> {
        try {
            this.client = new Client({
                host: this.config.host,
                port: this.config.port,
                user: this.config.user,
                password: this.config.password,
                database: this.config.database,
                ssl: this.config.ssl
            })

            await this.client.connect()
            this.logger.info('Database connected successfully')
        } catch (error) {
            this.logger.error('Failed to connect to database:', error)
            throw error
        }
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.end()
            this.client = null
            this.logger.info('Database disconnected')
        }
    }

    async getAllWhatsappConnections(): Promise<WhatsappConnection[]> {
        if (!this.client) {
            await this.connect()
        }

        try {
            // don't get ones with status DISCONNECTED
            const query = `
                SELECT
                    id, name, session, status, qrcode,
                    "greetingMessage", "completionMessage",
                    "outOfHoursMessage", "ratingMessage", "isDefault",
                    token, "transferQueueId", "timeToTransfer",
                    "expiresInactiveMessage",
                    "flowIdWelcome",
                    "companyId", "createdAt", "updatedAt"
                FROM "Whatsapps"
                WHERE status != 'DISCONNECTED'
                ORDER BY id
            `
            
            const result = await this.client!.query(query)
            
            return result.rows.map(row => ({
                id: row.id,
                name: row.name,
                session: row.session,
                status: row.status,
                qrcode: row.qrcode,
                companyId: row.companyId,
                token: row.token,
                greetingMessage: row.greetingMessage || '',
                completionMessage: row.completionMessage || '',
                outOfHoursMessage: row.outOfHoursMessage || '',
                ratingMessage: row.ratingMessage || '',
                isDefault: row.isDefault || false,
                transferQueueId: row.transferQueueId,
                timeToTransfer: row.timeToTransfer,
                expiresInactiveMessage: row.expiresInactiveMessage,
                flowIdWelcome: row.flowIdWelcome,
                createdAt: new Date(row.createdAt),
                updatedAt: new Date(row.updatedAt)
            }))
        } catch (error) {
            this.logger.error('Error fetching WhatsApp connections:', error)
            throw error
        }
    }

    async getWhatsappConnection(id: number): Promise<WhatsappConnection | null> {
        if (!this.client) {
            await this.connect()
        }

        try {
            const query = `
                SELECT
                    id, name, session, status, qrcode,
                    "greetingMessage", "completionMessage",
                    "outOfHoursMessage", "ratingMessage", "isDefault",
                    token, "transferQueueId", "timeToTransfer",
                    "expiresInactiveMessage",
                    "flowIdWelcome",
                    "companyId", "createdAt", "updatedAt"
                FROM "Whatsapps"
                WHERE id = $1
            `
            
            const result = await this.client!.query(query, [id])
            
            if (result.rows.length === 0) {
                return null
            }

            const row = result.rows[0]
            return {
                id: row.id,
                name: row.name,
                session: row.session,
                status: row.status,
                qrcode: row.qrcode,
                companyId: row.companyId,
                token: row.token,
                greetingMessage: row.greetingMessage || '',
                completionMessage: row.completionMessage || '',
                outOfHoursMessage: row.outOfHoursMessage || '',
                ratingMessage: row.ratingMessage || '',
                isDefault: row.isDefault || false,
                transferQueueId: row.transferQueueId,
                timeToTransfer: row.timeToTransfer,
                expiresInactiveMessage: row.expiresInactiveMessage,
                flowIdWelcome: row.flowIdWelcome,
                createdAt: new Date(row.createdAt),
                updatedAt: new Date(row.updatedAt)
            }
        } catch (error) {
            this.logger.error(`Error fetching WhatsApp connection ${id}:`, error)
            throw error
        }
    }

    async updateWhatsappSession(id: number, session: string): Promise<void> {
        if (!this.client) {
            await this.connect()
        }

        try {
            const query = `
                UPDATE "Whatsapps" 
                SET session = $1, "updatedAt" = NOW()
                WHERE id = $2
            `
            
            await this.client!.query(query, [session, id])
            
            if (this.config.logging) {
                this.logger.info(`Updated session for WhatsApp connection ${id}`)
            }
        } catch (error) {
            this.logger.error(`Error updating session for WhatsApp connection ${id}:`, error)
            throw error
        }
    }

    async updateWhatsappStatus(id: number, status: string, qrcode?: string | null): Promise<void> {
        if (!this.client) {
            await this.connect()
        }

        try {
            let query: string
            let params: any[]

            if (qrcode !== undefined) {
                query = `
                    UPDATE "Whatsapps"
                    SET status = $1, qrcode = $2, "updatedAt" = NOW()
                    WHERE id = $3
                `
                params = [status, qrcode, id]
            } else {
                query = `
                    UPDATE "Whatsapps" 
                    SET status = $1, "updatedAt" = NOW()
                    WHERE id = $2
                `
                params = [status, id]
            }
            
            await this.client!.query(query, params)
            
            if (this.config.logging) {
                this.logger.info(`Updated status for WhatsApp connection ${id}: ${status}`)
            }
        } catch (error) {
            this.logger.error(`Error updating status for WhatsApp connection ${id}:`, error)
            throw error
        }
    }

    async clearWhatsappQRCode(id: number): Promise<void> {
        if (!this.client) {
            await this.connect()
        }

        try {
            const query = `
                UPDATE "Whatsapps" 
                SET qrcode = NULL, "updatedAt" = NOW()
                WHERE id = $1
            `
            
            await this.client!.query(query, [id])
            
            if (this.config.logging) {
                this.logger.info(`Cleared QR code for WhatsApp connection ${id}`)
            }
        } catch (error) {
            this.logger.error(`Error clearing QR code for WhatsApp connection ${id}:`, error)
            throw error
        }
    }
}