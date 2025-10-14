import { WASocket, WAMessage } from '@whiskeysockets/baileys'

export interface WhatsAppSession extends WASocket {
    id: string
    name?: string
    companyId?: number
    status: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'QR_PENDING'
    qrCode?: string
    store?: any
}

export type WSMessageType =
    | 'startConnection'
    | 'sendMessage'
    | 'resetConnection'
    | 'disconnectSession'
    | 'deleteSession'
    | 'connectionUpdate'
    | 'messageReceived'
    | 'qrGenerated'
    | 'callSocketMethod'
    | 'socketMethodResult'
    | 'error'

export interface WSMessage {
    type: WSMessageType
    id?: string
    data?: any
    error?: string
}

export interface StartConnectionData {
    id: string
    name?: string
    companyId?: number
    session?: string | null // Auth state
}

export interface SendMessageData {
    whatsappId: string
    to: string
    message: {
        text?: string
        image?: any
        audio?: any
        video?: any
        document?: any
        ptt?: boolean
        mimetype?: string
        caption?: string
        fileName?: string
        jpegThumbnail?: Buffer
        [key: string]: any
    }
    options?: any
}

export interface ConnectionUpdateData {
    whatsappId: string
    status: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'QR_PENDING'
    qrCode?: string
    error?: string
}

export interface MessageReceivedData {
    whatsappId: string
    companyId: number
    from: string
    message: WAMessage
    timestamp: number
}

export interface SessionStatus {
    id: string
    name?: string
    companyId?: number
    status: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'QR_PENDING'
    qrCode?: string
    connected: boolean
}
