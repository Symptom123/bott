/**
 * BotSessionManager — manages one Baileys socket per user
 * Each user gets their own session folder: sessions/<username>/
 */

const path = require('path')
const fs = require('fs')
const chalk = require('chalk')
const QRCode = require('qrcode')
const { Boom } = require('@hapi/boom')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    jidDecode,
    proto,
    Browsers
} = require('@whiskeysockets/baileys')
const NodeCache = require('node-cache')
const pino = require('pino')
const PhoneNumber = require('awesome-phonenumber')

const SESSIONS_DIR = path.join(__dirname, '..', 'sessions')
const MAX_LOGS = 200

class BotSessionManager {
    constructor(io) {
        this.io = io
        /** @type {Map<string, { sock: any, status: string, pairingCode: string|null, pairingCodeTime: number|null, qrCode: string|null, logs: string[], reconnectTimer: any, reconnectAttempts: number, phoneNumber: string }>} */
        this.sessions = new Map()
    }

    // ── Per-user log helper ──────────────────────────────────────────────────
    _log(username, message) {
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19)
        const entry = `[${ts}] ${message}`
        const session = this.sessions.get(username)
        if (session) {
            session.logs.push(entry)
            if (session.logs.length > MAX_LOGS) session.logs.shift()
        }
        if (this.io) {
            this.io.to(`user:${username}`).emit('bot-log', { message: entry })
        }
        console.log(chalk.cyan(`[${username}]`), message)
    }

    _setStatus(username, status, extra = {}) {
        const session = this.sessions.get(username)
        if (session) session.status = status
        if (this.io) {
            this.io.to(`user:${username}`).emit('bot-status', { status, ...extra })
            this.io.to('admins').emit('bot-status-update', { username, status, ...extra })
        }
    }

    // ── Start session for a user ─────────────────────────────────────────────
    async startSession(username, phoneNumber, forceFresh = true) {
        const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '')
        if (!cleanPhone || cleanPhone.length < 8) {
            throw new Error('Invalid phone number. Include country code without + or spaces (e.g. 237620323830)')
        }

        if (this.sessions.has(username)) {
            const existing = this.sessions.get(username)
            if (existing.status === 'connected') {
                return { message: 'Bot already connected and active', status: 'connected', phoneNumber: cleanPhone }
            }
            await this.stopSession(username, false)
        }

        const sessionDir = path.join(SESSIONS_DIR, username)
        const credsPath = path.join(sessionDir, 'creds.json')

        // If not already registered and requesting a new code, wipe stale keys
        if (forceFresh) {
            let isRegistered = false
            try {
                if (fs.existsSync(credsPath)) {
                    const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
                    isRegistered = !!parsed.registered
                }
            } catch {}

            if (!isRegistered && fs.existsSync(sessionDir)) {
                try {
                    fs.rmSync(sessionDir, { recursive: true, force: true })
                    this._log(username, '🧹 Cleaned stale un-registered keys for fresh pairing.')
                } catch {}
            }
        }

        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

        this.sessions.set(username, {
            sock: null,
            status: 'starting',
            pairingCode: null,
            pairingCodeTime: null,
            qrCode: null,
            logs: [],
            reconnectTimer: null,
            reconnectAttempts: 0,
            phoneNumber: cleanPhone,
        })

        this._log(username, `🚀 Initializing session for phone: +${cleanPhone}`)
        this._setStatus(username, 'starting', { phoneNumber: cleanPhone })

        this._connect(username, cleanPhone).catch(err => {
            this._log(username, `❌ Connection error: ${err.message}`)
            this._setStatus(username, 'error', { error: err.message })
        })

        return { message: 'Pairing session initialized', status: 'starting', phoneNumber: cleanPhone }
    }

    // ── Internal connect ─────────────────────────────────────────────────────
    async _connect(username, phoneNumber) {
        const sessionDir = path.join(SESSIONS_DIR, username)
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

        const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '')

        let { version } = await fetchLatestBaileysVersion()
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
        const msgRetryCounterCache = new NodeCache({ stdTTL: 60, checkperiod: 120 })
        const groupMetadataCache = new NodeCache({ stdTTL: 5 * 60, useClones: false })

        // Create isolated store for this user
        const { createStore } = require('./userStore')
        const userStore = createStore(username)

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.ubuntu('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            getMessage: async (key) => {
                const jid = jidNormalizedUser(key.remoteJid)
                const msg = await userStore.loadMessage(jid, key.id)
                return msg?.message || proto.Message.fromObject({})
            },
            cachedGroupMetadata: async (jid) => groupMetadataCache.get(jid),
            msgRetryCounterCache,
            defaultQueryTimeoutMs: 30000,
        })

        sock.public = true
        userStore.bind(sock.ev)

        const session = this.sessions.get(username)
        if (session) {
            session.sock = sock
            session.store = userStore
        }

        // ── Wrap sendMessage: robust delivery with automatic quote fallback ─
        const rawSend = sock.sendMessage.bind(sock)
        sock.sendMessage = async (...args) => {
            const sess = this.sessions.get(username)
            if (!sess) return null
            if (sess.status !== 'connected') {
                this._log(username, `ℹ️ Sending message while status is "${sess.status}" (attempting delivery)...`)
            }
            try {
                const result = await rawSend(...args)
                if (result?.key?.remoteJid && userStore?.saveMessage) {
                    userStore.saveMessage(result.key.remoteJid, result)
                }
                return result
            } catch (err) {
                // If sending with quoted message failed in groups (LID / malformed context), retry without quote
                if (args[2]?.quoted) {
                    try {
                        const { quoted, ...cleanOptions } = args[2] || {}
                        const result = await rawSend(args[0], args[1], cleanOptions)
                        if (result?.key?.remoteJid && userStore?.saveMessage) {
                            userStore.saveMessage(result.key.remoteJid, result)
                        }
                        return result
                    } catch (retryErr) {
                        this._log(username, `⚠️ Send retry without quote failed: ${retryErr.message}`)
                    }
                }
                const msg = String(err?.message || '')
                if (msg.includes('Connection Closed') || msg.includes('connection')) return null
                this._log(username, `❌ Send error: ${err.message}`)
                throw err
            }
        }

        // ── Helper methods ──────────────────────────────────────────────────
        sock.decodeJid = (jid) => {
            if (!jid) return jid
            if (/:\d+@/gi.test(jid)) {
                const decode = jidDecode(jid) || {}
                return (decode.user && decode.server && decode.user + '@' + decode.server) || jid
            }
            return jid
        }

        // Cache groupMetadata calls to prevent hanging or rate-limiting
        const rawGroupMetadata = sock.groupMetadata.bind(sock)
        sock.groupMetadata = async (jid) => {
            const cached = groupMetadataCache.get(jid)
            if (cached) return cached
            try {
                const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('groupMetadata timeout')), 8000))
                const data = await Promise.race([rawGroupMetadata(jid), timeout])
                if (data) groupMetadataCache.set(jid, data)
                return data
            } catch (err) {
                if (cached) return cached
                throw err
            }
        }

        sock.getName = (jid, withoutContact = false) => {
            const id = sock.decodeJid(jid)
            if (id.endsWith('@g.us')) return new Promise(async resolve => {
                let v = userStore.contacts[id] || {}
                if (!(v.name || v.subject)) v = await sock.groupMetadata(id).catch(() => ({}))
                resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
            })
            const v = id === '0@s.whatsapp.net' ? { name: 'WhatsApp' }
                : id === sock.decodeJid(sock.user?.id) ? sock.user
                : (userStore.contacts[id] || {})
            return (withoutContact ? '' : v.name) || v.subject || v.verifiedName ||
                PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
        }

        const { smsg } = require('../lib/myfunc')
        sock.serializeM = (m) => smsg(sock, m, userStore)

        // ── Request Pairing Code (stable once per session request) ──────────
        const sess = this.sessions.get(username)
        if (!sock.authState.creds.registered && cleanPhone && (!sess || !sess.pairingCode)) {
            setTimeout(async () => {
                const current = this.sessions.get(username)
                if (!current || current.status === 'connected' || current.pairingCode || sock.authState.creds.registered) return

                try {
                    this._log(username, `⏳ Requesting pairing code from WhatsApp Gateway for +${cleanPhone}...`)
                    let code = await sock.requestPairingCode(cleanPhone)
                    code = code?.match(/.{1,4}/g)?.join('-') || code

                    current.pairingCode = code
                    current.pairingCodeTime = Date.now()
                    current.status = 'waiting-pairing'

                    this._log(username, `🔑 PAIRING CODE ACTIVE: ${code}`)
                    this._log(username, `👉 Enter this 8-digit code in WhatsApp > Linked Devices now: ${code}`)
                    this._setStatus(username, 'waiting-pairing', { pairingCode: code, phone: cleanPhone })
                    if (this.io) {
                        this.io.to(`user:${username}`).emit('pairing-code', { code, phone: cleanPhone })
                    }
                } catch (err) {
                    this._log(username, `❌ Pairing code error: ${err.message}`)
                    this._setStatus(username, 'error', { error: err.message })
                }
            }, 3000)
        }

        // ── Connection update ────────────────────────────────────────────────
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update
            const current = this.sessions.get(username)
            if (!current) return

            // If QR code is emitted, save and send
            if (qr) {
                try {
                    const qrDataUrl = await QRCode.toDataURL(qr, { scale: 6, margin: 2 })
                    current.qrCode = qrDataUrl
                    if (this.io) {
                        this.io.to(`user:${username}`).emit('qr-code', { qr: qrDataUrl })
                    }
                    this._setStatus(username, 'waiting-pairing', { qrCode: qrDataUrl, pairingCode: current.pairingCode })
                } catch {}
            }

            if (connection === 'connecting') {
                this._log(username, '🌐 Connecting to WhatsApp Gateway...')
            }

            if (connection === 'open') {
                current.status = 'connected'
                current.reconnectAttempts = 0
                current.pairingCode = null
                current.pairingCodeTime = null
                current.qrCode = null
                this._log(username, `✅ WhatsApp linked successfully as ${sock.user?.id || 'Connected'}`)
                this._setStatus(username, 'connected', { jid: sock.user?.id })
            }

            if (connection === 'close') {
                current.status = 'disconnected'
                const code = lastDisconnect?.error?.output?.statusCode
                this._log(username, `🔌 Socket closed (code: ${code || 'unknown'})`)

                if (code === DisconnectReason.loggedOut || code === 401) {
                    this._log(username, '🚫 Logged out from WhatsApp. Session cleared.')
                    this._setStatus(username, 'logged-out')
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch {}
                    return
                }

                const delay = Math.min(3000 * Math.pow(1.5, current.reconnectAttempts), 20000)
                current.reconnectAttempts++
                this._log(username, `🔄 Reconnecting in ${Math.round(delay / 1000)}s...`)
                this._setStatus(username, 'reconnecting')

                clearTimeout(current.reconnectTimer)
                current.reconnectTimer = setTimeout(() => {
                    const latest = this.sessions.get(username)
                    if (latest && latest.status !== 'stopped') {
                        this._connect(username, latest.phoneNumber).catch(() => {})
                    }
                }, delay)
            }
        })

        // ── Message handler ──────────────────────────────────────────────────
        sock.ev.on('messages.upsert', async (chatUpdate) => {
            try {
                const mek = chatUpdate.messages?.[0]
                if (!mek?.message) return

                const { handleMessages, handleStatus } = require('../main')

                if (mek.key?.remoteJid === 'status@broadcast') {
                    await handleStatus(sock, chatUpdate).catch(() => {})
                    return
                }

                await handleMessages(sock, chatUpdate, true).catch(err => {
                    const msg = String(err?.message || '')
                    if (msg.includes('Connection Closed') || msg.includes('Bad MAC') || msg.includes('not-authorized')) return
                    this._log(username, `⚠️ Message error: ${err.message}`)
                })
            } catch (err) {
                this._log(username, `❌ Upsert error: ${err.message}`)
            }
        })

        // ── Group events ──────────────────────────────────────────────────────
        sock.ev.on('group-participants.update', async (update) => {
            try {
                if (update.id) groupMetadataCache.del(update.id)
                const { handleGroupParticipantUpdate } = require('../main')
                await handleGroupParticipantUpdate(sock, update)
            } catch {}
        })

        sock.ev.on('groups.update', updates => {
            for (const u of updates) {
                if (u.id) groupMetadataCache.del(u.id)
            }
        })

        sock.ev.on('contacts.update', update => {
            for (const contact of update) {
                const id = sock.decodeJid(contact.id)
                if (userStore?.contacts) userStore.contacts[id] = { id, name: contact.notify }
            }
        })

        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds()
            } catch (e) {
                console.error(`[${username}] Error saving creds:`, e.message)
            }
        })
    }

    // ── Stop session ─────────────────────────────────────────────────────────
    async stopSession(username, markStopped = true) {
        const sess = this.sessions.get(username)
        if (!sess) return

        clearTimeout(sess.reconnectTimer)
        if (sess.sock) {
            try { sess.sock.ev.removeAllListeners() } catch {}
            try { await sess.sock.end() } catch {}
            try { await sess.sock.ws?.close() } catch {}
        }

        if (markStopped) {
            this._log(username, '⏹️ Bot session stopped.')
            this._setStatus(username, 'stopped')
            this.sessions.delete(username)
        }
    }

    // ── Reset session ────────────────────────────────────────────────────────
    async resetSession(username) {
        await this.stopSession(username, true)
        const sessionDir = path.join(SESSIONS_DIR, username)
        try {
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true })
            }
        } catch (e) {
            console.error(`[${username}] Error removing session:`, e.message)
        }
        this._log(username, '🧹 Session cleared. Ready for fresh pairing.')
        this._setStatus(username, 'stopped', { pairingCode: null, qrCode: null })
        return { message: 'Session reset successfully. You can request a fresh code.' }
    }

    // ── Getters ──────────────────────────────────────────────────────────────
    getStatus(username) {
        const sess = this.sessions.get(username)
        if (!sess) return { status: 'stopped', pairingCode: null, qrCode: null, phone: null }
        return {
            status: sess.status,
            pairingCode: sess.pairingCode,
            pairingCodeTime: sess.pairingCodeTime,
            qrCode: sess.qrCode,
            phone: sess.phoneNumber
        }
    }

    getLogs(username) {
        return this.sessions.get(username)?.logs || []
    }

    getPairingCode(username) {
        return this.sessions.get(username)?.pairingCode || null
    }

    getQRCode(username) {
        return this.sessions.get(username)?.qrCode || null
    }

    getActiveSessions() {
        return [...this.sessions.entries()]
            .filter(([, s]) => s.status === 'connected')
            .map(([username, s]) => ({ username, phone: s.phoneNumber }))
    }
}

module.exports = { BotSessionManager }
