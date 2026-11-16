/**
 * BotSessionManager — manages one Baileys socket per user
 * Each user gets their own session folder: sessions/<username>/
 */

const path = require('path')
const fs = require('fs')
const chalk = require('chalk')
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
        /** @type {Map<string, { sock: any, status: string, pairingCode: string|null, logs: string[], reconnectTimer: any, reconnectAttempts: number }>} */
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
        // Emit to user's socket room
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
    async startSession(username, phoneNumber) {
        if (this.sessions.has(username)) {
            const existing = this.sessions.get(username)
            if (existing.status === 'connected') {
                return { message: 'Bot already running', status: 'connected' }
            }
            // Clean up stale session object
            await this.stopSession(username)
        }

        const sessionDir = path.join(SESSIONS_DIR, username)
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

        // Initialize session record
        this.sessions.set(username, {
            sock: null,
            status: 'starting',
            pairingCode: null,
            logs: [],
            reconnectTimer: null,
            reconnectAttempts: 0,
            phoneNumber,
        })

        this._log(username, `🚀 Starting bot for phone: +${phoneNumber}`)
        this._setStatus(username, 'starting')

        await this._connect(username, phoneNumber)
        return { message: 'Bot starting...', status: 'starting' }
    }

    // ── Internal connect ─────────────────────────────────────────────────────
    async _connect(username, phoneNumber) {
        const sessionDir = path.join(SESSIONS_DIR, username)

        // Clean unregistered creds
        const credsPath = path.join(sessionDir, 'creds.json')
        if (fs.existsSync(credsPath)) {
            try {
                const rawCreds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
                if (!rawCreds.registered) {
                    fs.rmSync(sessionDir, { recursive: true, force: true })
                    fs.mkdirSync(sessionDir, { recursive: true })
                    this._log(username, '🧹 Cleaned unregistered session')
                }
            } catch {}
        }

        let { version } = await fetchLatestBaileysVersion()
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
        const msgRetryCounterCache = new NodeCache({ stdTTL: 60, checkperiod: 120 })

        // Create store for this user
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
            msgRetryCounterCache,
            defaultQueryTimeoutMs: undefined,
        })

        sock.public = true
        userStore.bind(sock.ev)

        const session = this.sessions.get(username)
        if (session) {
            session.sock = sock
            session.store = userStore
        }

        // ── Wrap sendMessage ────────────────────────────────────────────────
        const rawSend = sock.sendMessage.bind(sock)
        sock.sendMessage = async (...args) => {
            const sess = this.sessions.get(username)
            if (!sess || sess.status !== 'connected') return null
            try {
                const result = await rawSend(...args)
                if (result?.key?.remoteJid && userStore?.saveMessage) {
                    userStore.saveMessage(result.key.remoteJid, result)
                }
                return result
            } catch (err) {
                const msg = String(err?.message || '')
                if (msg.includes('Connection Closed') || msg.includes('connection')) return null
                throw err
            }
        }

        // ── Add helper methods ──────────────────────────────────────────────
        sock.decodeJid = (jid) => {
            if (!jid) return jid
            if (/:\d+@/gi.test(jid)) {
                const decode = jidDecode(jid) || {}
                return (decode.user && decode.server && decode.user + '@' + decode.server) || jid
            }
            return jid
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

        // ── Pairing code ────────────────────────────────────────────────────
        if (!sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''))
                    code = code?.match(/.{1,4}/g)?.join('-') || code
                    const sess = this.sessions.get(username)
                    if (sess) sess.pairingCode = code
                    this._log(username, `🔑 Pairing code: ${code}`)
                    this._setStatus(username, 'waiting-pairing', { pairingCode: code })
                    if (this.io) {
                        this.io.to(`user:${username}`).emit('pairing-code', { code })
                    }
                } catch (err) {
                    this._log(username, `❌ Pairing code error: ${err.message}`)
                }
            }, 3000)
        }

        // ── Connection update ────────────────────────────────────────────────
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update
            const sess = this.sessions.get(username)
            if (!sess) return

            if (connection === 'open') {
                sess.status = 'connected'
                sess.reconnectAttempts = 0
                sess.pairingCode = null
                this._log(username, `✅ Connected as ${sock.user?.id}`)
                this._setStatus(username, 'connected', { jid: sock.user?.id })
            }

            if (connection === 'close') {
                sess.status = 'disconnected'
                const code = lastDisconnect?.error?.output?.statusCode
                this._log(username, `🔌 Disconnected (code: ${code || 'unknown'})`)

                if (code === DisconnectReason.loggedOut || code === 401) {
                    this._log(username, '🚫 Logged out. Session cleared.')
                    this._setStatus(username, 'logged-out')
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch {}
                    return
                }

                // Exponential backoff reconnect
                const delay = Math.min(5000 * Math.pow(2, sess.reconnectAttempts), 30000)
                sess.reconnectAttempts++
                this._log(username, `🔄 Reconnecting in ${delay / 1000}s...`)
                this._setStatus(username, 'reconnecting')

                clearTimeout(sess.reconnectTimer)
                sess.reconnectTimer = setTimeout(() => {
                    const current = this.sessions.get(username)
                    if (current) this._connect(username, current.phoneNumber).catch(() => {})
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
                this._log(username, `❌ upsert error: ${err.message}`)
            }
        })

        // ── Group events ──────────────────────────────────────────────────────
        sock.ev.on('group-participants.update', async (update) => {
            try {
                const { handleGroupParticipantUpdate } = require('../main')
                await handleGroupParticipantUpdate(sock, update)
            } catch {}
        })

        sock.ev.on('contacts.update', update => {
            for (const contact of update) {
                const id = sock.decodeJid(contact.id)
                if (userStore?.contacts) userStore.contacts[id] = { id, name: contact.notify }
            }
        })

        sock.ev.on('creds.update', saveCreds)
    }

    // ── Stop session ─────────────────────────────────────────────────────────
    async stopSession(username) {
        const sess = this.sessions.get(username)
        if (!sess) return

        clearTimeout(sess.reconnectTimer)
        if (sess.sock) {
            try { sess.sock.ev.removeAllListeners() } catch {}
            try { await sess.sock.end() } catch {}
            try { await sess.sock.ws?.close() } catch {}
        }

        this._log(username, '⏹️ Bot stopped by request')
        this._setStatus(username, 'stopped')
        this.sessions.delete(username)
    }

    // ── Getters ──────────────────────────────────────────────────────────────
    getStatus(username) {
        const sess = this.sessions.get(username)
        if (!sess) return { status: 'stopped', pairingCode: null }
        return { status: sess.status, pairingCode: sess.pairingCode, phone: sess.phoneNumber }
    }

    getLogs(username) {
        return this.sessions.get(username)?.logs || []
    }

    getPairingCode(username) {
        return this.sessions.get(username)?.pairingCode || null
    }

    getActiveSessions() {
        return [...this.sessions.entries()]
            .filter(([, s]) => s.status === 'connected')
            .map(([username, s]) => ({ username, phone: s.phoneNumber }))
    }
}

module.exports = { BotSessionManager }
