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
        /** @type {Map<string, { sock: any, status: string, pairingCode: string|null, logs: string[], reconnectTimer: any, reconnectAttempts: number, phoneNumber: string }>} */
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
    async startSession(username, phoneNumber) {
        const cleanPhone = String(phoneNumber || '').replace(/[^0-9]/g, '')
        if (!cleanPhone || cleanPhone.length < 8) {
            throw new Error('Invalid phone number. Include country code without + or spaces (e.g. 237620323830)')
        }

        if (this.sessions.has(username)) {
            const existing = this.sessions.get(username)
            if (existing.status === 'connected') {
                return { message: 'Bot already running and connected', status: 'connected' }
            }
            await this.stopSession(username, false)
        }

        const sessionDir = path.join(SESSIONS_DIR, username)
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })

        this.sessions.set(username, {
            sock: null,
            status: 'starting',
            pairingCode: null,
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

        // ── Helper methods ──────────────────────────────────────────────────
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

        // ── Request Pairing Code ─────────────────────────────────────────────
        if (!sock.authState.creds.registered && cleanPhone) {
            const requestPairing = async (retries = 3) => {
                const sess = this.sessions.get(username)
                if (!sess || sess.status === 'connected' || sock.authState.creds.registered) return

                try {
                    this._log(username, `⏳ Requesting WhatsApp pairing code for +${cleanPhone}...`)
                    let code = await sock.requestPairingCode(cleanPhone)
                    code = code?.match(/.{1,4}/g)?.join('-') || code

                    if (sess) {
                        sess.pairingCode = code
                        sess.status = 'waiting-pairing'
                    }
                    this._log(username, `🔑 PAIRING CODE: ${code}`)
                    this._setStatus(username, 'waiting-pairing', { pairingCode: code })
                    if (this.io) {
                        this.io.to(`user:${username}`).emit('pairing-code', { code })
                    }
                } catch (err) {
                    this._log(username, `⚠️ Pairing attempt failed: ${err.message}`)
                    if (retries > 0 && !sock.authState.creds.registered) {
                        this._log(username, `🔄 Retrying pairing code in 3.5s (${retries} retries left)...`)
                        setTimeout(() => requestPairing(retries - 1), 3500)
                    } else {
                        this._log(username, `❌ Failed to obtain pairing code: ${err.message}`)
                        this._setStatus(username, 'error', { error: err.message })
                    }
                }
            }

            // Wait 3.5s for initial socket handshake to be ready
            setTimeout(() => requestPairing(3), 3500)
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
                this._log(username, `✅ WhatsApp linked successfully as ${sock.user?.id || 'Connected'}`)
                this._setStatus(username, 'connected', { jid: sock.user?.id })
            }

            if (connection === 'close') {
                sess.status = 'disconnected'
                const code = lastDisconnect?.error?.output?.statusCode
                this._log(username, `🔌 Disconnected (code: ${code || 'unknown'})`)

                if (code === DisconnectReason.loggedOut || code === 401) {
                    this._log(username, '🚫 Logged out from WhatsApp. Session cleared.')
                    this._setStatus(username, 'logged-out')
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }) } catch {}
                    return
                }

                // Never wipe sessionDir on connection drops/timeouts while pairing!
                // Reconnect with same credentials so pairing handshake can finalize
                const delay = Math.min(3000 * Math.pow(1.5, sess.reconnectAttempts), 20000)
                sess.reconnectAttempts++
                this._log(username, `🔄 Reconnecting in ${Math.round(delay / 1000)}s...`)
                this._setStatus(username, 'reconnecting')

                clearTimeout(sess.reconnectTimer)
                sess.reconnectTimer = setTimeout(() => {
                    const current = this.sessions.get(username)
                    if (current && current.status !== 'stopped') {
                        this._connect(username, current.phoneNumber).catch(() => {})
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
        this._setStatus(username, 'stopped', { pairingCode: null })
        return { message: 'Session reset successfully' }
    }

    // ── Getters ──────────────────────────────────────────────────────────────
    getStatus(username) {
        const sess = this.sessions.get(username)
        if (!sess) return { status: 'stopped', pairingCode: null, phone: null }
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
