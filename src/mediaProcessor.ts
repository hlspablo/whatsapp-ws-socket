import fs from 'fs'
import path from 'path'
import os from 'os'
import P from 'pino'
import { processAudio, processAudioFile, isVoiceNote, cleanupTempFile, processVideo, generateVideoThumbnail } from './audioUtils'
import https from 'https'
import http from 'http'
import audioDecode from 'audio-decode'

export interface ProcessedMessage {
    text?: string
    image?: Buffer
    audio?: Buffer
    video?: Buffer
    document?: Buffer
    ptt?: boolean
    mimetype?: string
    caption?: string
    fileName?: string
    jpegThumbnail?: Buffer
    [key: string]: any
}

export class MediaProcessor {
    private logger: any

    constructor(logger?: any) {
        // Create logger if not provided
        this.logger = logger || P({
            level: 'info',
            transport: {
                target: 'pino-pretty',
                options: {
                    colorize: true,
                    translateTime: 'SYS:standard'
                }
            }
        })
    }

    /**
     * Process all media in a message for WhatsApp compatibility
     */
    async processMessageMedia(message: ProcessedMessage, onlyAudio?: boolean): Promise<{
        success: boolean
        processedMessage: ProcessedMessage
        error?: string
    }> {
        try {
            const processedMessage = { ...message }
            console.log('onlyAudio file', onlyAudio)

            // Only audio is used because only audios need to be processed and converted to ogg format
            // the others processing are used by flowise because it used BASE64 string

            // Process audio
            if (processedMessage.audio) {
                // If audio is provided as a URL object, download it first
                if (processedMessage.audio && typeof processedMessage.audio === 'object' && (processedMessage as any).audio.url) {
                    try {
                        const url = (processedMessage as any).audio.url as string
                        const downloaded = await this.downloadToBuffer(url)
                        processedMessage.audio = downloaded
                    } catch (downloadErr) {
                        this.logger.error('Failed to download audio from URL:', downloadErr)
                        return {
                            success: false,
                            processedMessage: message,
                            error: 'Failed to download audio from URL'
                        }
                    }
                }

                const audioResult = await this.processAudio(processedMessage.audio, processedMessage)
                if (!audioResult.success) {
                    return audioResult
                }
                Object.assign(processedMessage, audioResult.processedMessage)
            }
            
            // If onlyAudio is true, return the processed message
            if (onlyAudio) {
                return {
                    success: true,
                    processedMessage
                }
            }

            // Process image
            if (processedMessage.image) {
                const imageResult = await this.processImage(processedMessage.image)
                if (!imageResult.success) {
                    return imageResult
                }
                processedMessage.image = imageResult.processedMessage.image
            }

            // Process video
            if (processedMessage.video) {
                const videoResult = await this.processVideo(processedMessage.video, processedMessage)
                if (!videoResult.success) {
                    return videoResult
                }
                Object.assign(processedMessage, videoResult.processedMessage)
            }

            // Process document
            if (processedMessage.document) {
                const documentResult = await this.processDocument(processedMessage.document)
                if (!documentResult.success) {
                    return documentResult
                }
                processedMessage.document = documentResult.processedMessage.document
            }

            return {
                success: true,
                processedMessage
            }
        } catch (error) {
            this.logger.error('Error processing message media:', error)
            return {
                success: false,
                processedMessage: message,
                error: error instanceof Error ? error.message : 'Failed to process media'
            }
        }
    }

    private async downloadToBuffer(fileUrl: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            try {
                const client = fileUrl.startsWith('https') ? https : http
                const req = client.get(fileUrl, (res) => {
                    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        // Handle redirects
                        const redirectedUrl = res.headers.location.startsWith('http')
                            ? res.headers.location
                            : new URL(res.headers.location, fileUrl).toString()
                        res.resume()
                        this.downloadToBuffer(redirectedUrl).then(resolve).catch(reject)
                        return
                    }

                    if (res.statusCode !== 200) {
                        reject(new Error(`Failed to download file. Status: ${res.statusCode}`))
                        res.resume()
                        return
                    }

                    const chunks: Buffer[] = []
                    res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
                    res.on('end', () => resolve(Buffer.concat(chunks)))
                    res.on('error', reject)
                })

                req.on('error', reject)
            } catch (err) {
                reject(err)
            }
        })
    }

    /**
     * Helper function to safely handle media data for Baileys
     */
    private async processMediaForBaileys(data: any, type: string): Promise<Buffer | null> {
        if (!data) return null

        try {
            let buffer: Buffer | null = null

            if (typeof data === 'string') {
                // Validate base64 string
                if (!/^[A-Za-z0-9+/=]*$/.test(data)) {
                    throw new Error('Invalid base64 format')
                }
                buffer = Buffer.from(data, 'base64')
            } else if (Buffer.isBuffer(data)) {
                // Already a buffer
                buffer = data
            } else if (data && typeof data === 'object' && data.data) {
                // Handle {data: base64} format for backward compatibility
                if (typeof data.data === 'string') {
                    buffer = Buffer.from(data.data, 'base64')
                } else if (Buffer.isBuffer(data.data)) {
                    buffer = data.data
                }
            }

            if (!buffer) {
                throw new Error('Unable to process media data')
            }

            // Validate buffer size (basic check)
            if (buffer.length === 0) {
                throw new Error('Empty media buffer')
            }

            return buffer
        } catch (error) {
            this.logger.error(`Error processing ${type} media:`, error)
            throw new Error(`Invalid ${type} data format`)
        }
    }

    /**
     * Process image media
     */
    private async processImage(imageData: any): Promise<{
        success: boolean
        processedMessage: { image?: Buffer }
        error?: string
    }> {
        try {
            const imageBuffer = await this.processMediaForBaileys(imageData, 'image')
            if (imageBuffer) {
                return {
                    success: true,
                    processedMessage: { image: imageBuffer }
                }
            } else {
                return {
                    success: false,
                    processedMessage: {},
                    error: 'Invalid image data format'
                }
            }
        } catch (error) {
            return {
                success: false,
                processedMessage: {},
                error: error instanceof Error ? error.message : 'Failed to process image'
            }
        }
    }

    /**
     * Process video media with FFmpeg
     */
    private async processVideo(videoData: any, message: ProcessedMessage): Promise<{
        success: boolean
        processedMessage: Partial<ProcessedMessage>
        error?: string
    }> {
        try {
            const videoBuffer = await this.processMediaForBaileys(videoData, 'video')
            if (videoBuffer) {
                // Write buffer to temporary file for FFmpeg processing
                const tempInputPath = path.join(os.tmpdir(), `input_video_${Date.now()}.tmp`)
                fs.writeFileSync(tempInputPath, videoBuffer)

                // Process video through FFmpeg for WhatsApp compatibility
                const processedVideoPath = await processVideo(tempInputPath)

                // Generate thumbnail for video preview
                let thumbnailBuffer: Buffer | undefined
                try {
                    const thumbnailPath = await generateVideoThumbnail(processedVideoPath)
                    this.logger.info(`Video thumbnail generated: ${thumbnailPath}`)

                    // Read thumbnail into buffer for WhatsApp message
                    thumbnailBuffer = fs.readFileSync(thumbnailPath)

                    // Clean up thumbnail file after reading
                    cleanupTempFile(thumbnailPath)
                } catch (thumbnailError) {
                    this.logger.warn('Failed to generate video thumbnail:', thumbnailError)
                    // Continue without thumbnail - not critical
                }

                // Read the processed video file and update the message
                const processedVideo = fs.readFileSync(processedVideoPath)
                const result: Partial<ProcessedMessage> = {
                    video: processedVideo,
                    mimetype: 'video/mp4'
                }

                // Add thumbnail to the message if available
                if (thumbnailBuffer) {
                    result.jpegThumbnail = thumbnailBuffer
                }

                // Add fileName if provided
                if (message.fileName) {
                    // Ensure filename has .mp4 extension
                    const baseName = path.parse(message.fileName).name
                    result.fileName = `${baseName}.mp4`
                }

                // Clean up temporary files
                cleanupTempFile(processedVideoPath)

                this.logger.info(`Video processed successfully to MP4 format with thumbnail`)

                return {
                    success: true,
                    processedMessage: result
                }
            } else {
                return {
                    success: false,
                    processedMessage: {},
                    error: 'Invalid video data format'
                }
            }
        } catch (error) {
            this.logger.error('Error processing video:', error)
            return {
                success: false,
                processedMessage: {},
                error: error instanceof Error ? error.message : 'Failed to process video'
            }
        }
    }

    /**
     * Process audio media with FFmpeg
     */
    private async processAudio(audioData: any, message: ProcessedMessage): Promise<{
        success: boolean
        processedMessage: Partial<ProcessedMessage>
        error?: string
    }> {
        try {
            const audioBuffer = await this.processMediaForBaileys(audioData, 'audio')
            if (audioBuffer) {
                // Write buffer to temporary file for FFmpeg processing
                const tempInputPath = path.join(os.tmpdir(), `input_${Date.now()}.tmp`)
                fs.writeFileSync(tempInputPath, audioBuffer)

                // Determine if this should be a voice note based on message properties
                // Priority: explicit ptt flag, then filename detection, then mimetype
                const isPtt = message.ptt !== undefined ? message.ptt :
                             isVoiceNote(message.fileName, message.mimetype)

                let processedAudioPath: string
                if (isPtt) {
                    // Process as voice note (ptt: true)
                    processedAudioPath = await processAudio(tempInputPath)
                } else {
                    // Process as regular audio
                    processedAudioPath = await processAudioFile(tempInputPath)
                }

                // Read the processed audio file and update the message
                const processedAudio = fs.readFileSync(processedAudioPath)

                const result: Partial<ProcessedMessage> = {
                    audio: processedAudio,
                    ptt: isPtt,
                    mimetype: 'audio/ogg; codecs=opus'
                }

                // Clean up temporary files
                cleanupTempFile(processedAudioPath)

                this.logger.info(`Audio processed successfully, isPtt: ${isPtt}`)

                return {
                    success: true,
                    processedMessage: result
                }
            } else {
                return {
                    success: false,
                    processedMessage: {},
                    error: 'Invalid audio data format'
                }
            }
        } catch (error) {
            this.logger.error('Error processing audio:', error)
            return {
                success: false,
                processedMessage: {},
                error: error instanceof Error ? error.message : 'Failed to process audio'
            }
        }
    }

    /**
     * Process document media
     */
    private async processDocument(documentData: any): Promise<{
        success: boolean
        processedMessage: { document?: Buffer }
        error?: string
    }> {
        try {
            const documentBuffer = await this.processMediaForBaileys(documentData, 'document')
            if (documentBuffer) {
                return {
                    success: true,
                    processedMessage: { document: documentBuffer }
                }
            } else {
                return {
                    success: false,
                    processedMessage: {},
                    error: 'Invalid document data format'
                }
            }
        } catch (error) {
            return {
                success: false,
                processedMessage: {},
                error: error instanceof Error ? error.message : 'Failed to process document'
            }
        }
    }
}
