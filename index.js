/**
 * Knight Bot - A WhatsApp Bot
 * Copyright (c) 2024 Professor
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * Credits:
 * - Baileys Library by @adiwajshing
 * - Pair Code implementation inspired by TechGod143 & DGXEON
 */
require('./settings')

// Suppress libsignal transient decryption spam from flooding terminal and freezing I/O
const rawConsoleError = console.error;
console.error = (...args) => {
    const text = args.map(a => (typeof a === 'string' ? a : a?.message || '')).join(' ');
    if (
        text.includes('Bad MAC') ||
        text.includes('Session error') ||
        text.includes('Failed to decrypt message') ||
        text.includes('No matching sessions found') ||
        text.includes('MessageCounterError')
    ) {
        return;
    }
    rawConsoleError.apply(console, args);
};

const { Boom } = require('@hapi/boom')
const fs = require('fs')
const chalk = require('chalk')
const path = require('path')
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('./main');
const PhoneNumber = require('awesome-phonenumber')
const { smsg } = require('./lib/myfunc')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode,
    proto,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    Browsers
} = require("@whiskeysockets/baileys")
const NodeCache = require("node-cache")
const pino = require("pino")
const readline = require("readline")
const { rmSync } = require('fs')

// Import lightweight store
const store = require('./lib/lightweight_store')
store.readFromFile()

const settings = require('./settings')

// ─── Persist store to disk periodically ───────────────────────────────────────
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 30000)

// ─── Memory monitoring with graceful exit ─────────────────────────────────────
setInterval(() => {
    const usedMB = process.memoryUsage().rss / 1024 / 1024
    if (usedMB > 500) {
        console.log(`⚠️ High RAM usage (${Math.round(usedMB)}MB). Restarting...`)
        process.exit(1)
    }
    // Optional GC hint
    if (global.gc) global.gc()
}, 60_000)

// ─── Config ───────────────────────────────────────────────────────────────────
let owner = []
try { owner = JSON.parse(fs.readFileSync('./data/owner.json')) } catch {}

global.botname = "Symptom Bot"
global.themeemoji = "⚡"

const phoneNumber = settings.ownerNumber || "911234567890"
const pairingCode = true
const useMobile = process.argv.includes("--mobile")

const rl = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null
const question = (text) =>
    rl
        ? new Promise(resolve => rl.question(text, resolve))
        : Promise.resolve(settings.ownerNumber || phoneNumber)

// ─── Connection state tracker ─────────────────────────────────────────────────
let isConnected = false
let isReconnecting = false

// ─── Exponential backoff for reconnects ───────────────────────────────────────
let reconnectAttempts = 0
function getReconnectDelay(code) {
    if (code === 440) return 15000          // conflict — wait for other instance to die
    if (code === 408 || code === 503) return 10000  // server error
    if (code === 401) return 0             // logged out — handled separately
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 30000)
    reconnectAttempts++
    return delay
}

async function startXeonBotInc() {
    // ── Clean stale unregistered session ──────────────────────────────────────
    const credsPath = path.join(__dirname, 'session', 'creds.json')
    if (fs.existsSync(credsPath)) {
        try {
            const rawCreds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
            if (!rawCreds.registered) {
                fs.rmSync(path.join(__dirname, 'session'), { recursive: true, force: true })
                console.log(chalk.yellow('Cleaned unregistered session.'))
            }
        } catch {}
    }

    let { version } = await fetchLatestBaileysVersion()
    const { state, saveCreds } = await useMultiFileAuthState('./session')
    const msgRetryCounterCache = new NodeCache({ stdTTL: 60, checkperiod: 120 })

    let targetPhoneNumber = settings.ownerNumber || phoneNumber

    if (pairingCode && !state.creds.registered) {
        if (useMobile) throw new Error('Cannot use pairing code with mobile api')
        if (rl) {
            targetPhoneNumber = await question(
                chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number 😍\nFormat: 6281376552730 (without + or spaces) : `))
            )
        }
        targetPhoneNumber = (targetPhoneNumber || '').replace(/[^0-9]/g, '')

        const pn = require('awesome-phonenumber')
        if (!pn('+' + targetPhoneNumber).isValid()) {
            console.log(chalk.red('Invalid phone number. Please enter your full international number without + or spaces.'))
            process.exit(1)
        }
    }

    // ── Create socket ──────────────────────────────────────────────────────────
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: !pairingCode,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' })),
        },
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,   // saves bandwidth & CPU
        syncFullHistory: false,
        getMessage: async (key) => {
            if (store) {
                const jid = jidNormalizedUser(key.remoteJid)
                const msg = await store.loadMessage(jid, key.id)
                return msg?.message || undefined
            }
            return proto.Message.fromObject({})
        },
        msgRetryCounterCache,
        defaultQueryTimeoutMs: undefined,
    })

    sock.public = true
    store.bind(sock.ev)

    // ── Wrap sendMessage: save to store + guard against closed connection ──────
    const rawSendMessage = sock.sendMessage.bind(sock)
    sock.sendMessage = async (...args) => {
        if (!isConnected) {
            // Silently drop sends when disconnected instead of throwing 428
            return null
        }
        try {
            const result = await rawSendMessage(...args)
            if (result?.key?.remoteJid && store?.saveMessage) {
                store.saveMessage(result.key.remoteJid, result)
            }
            return result
        } catch (err) {
            const msg = String(err?.message || err)
            if (msg.includes('Connection Closed') || msg.includes('connection')) {
                // Expected during reconnect - don't throw
                return null
            }
            throw err
        }
    }

    // ── Helper methods ─────────────────────────────────────────────────────────
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
        withoutContact = sock.withoutContact || withoutContact
        let v
        if (id.endsWith('@g.us')) return new Promise(async resolve => {
            v = store.contacts[id] || {}
            if (!(v.name || v.subject)) v = sock.groupMetadata(id) || {}
            resolve(v.name || v.subject || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international'))
        })
        else v = id === '0@s.whatsapp.net'
            ? { id, name: 'WhatsApp' }
            : id === sock.decodeJid(sock.user.id)
                ? sock.user
                : (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName ||
            PhoneNumber('+' + jid.replace('@s.whatsapp.net', '')).getNumber('international')
    }

    sock.serializeM = (m) => smsg(sock, m, store)

    // ── Pairing code ───────────────────────────────────────────────────────────
    if (pairingCode && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(targetPhoneNumber)
                code = code?.match(/.{1,4}/g)?.join('-') || code
                console.log(chalk.black(chalk.bgGreen('Your Pairing Code : ')), chalk.white(code))
                console.log(chalk.yellow(`\nEnter this code in WhatsApp:\n1. Settings > Linked Devices\n2. Link a Device\n3. Link with phone number instead\n4. Enter: ${code}`))
            } catch (err) {
                console.error('Error requesting pairing code:', err.message)
            }
        }, 3000)
    }

    // ── Connection handler ─────────────────────────────────────────────────────
    sock.ev.on('connection.update', async (s) => {
        const { connection, lastDisconnect } = s

        if (connection === 'open') {
            isConnected = true
            reconnectAttempts = 0
            const latency = Date.now() % 30 + 8  // simulated latency 8-38ms
            console.log(`
╔══════════════════════════════════════════════╗
║   S Y M P T O M . B O T  ::  v 4 . 0 2      ║
╚══════════════════════════════════════════════╝
[!] STATUS   :: ONLINE (NODE_CONNECTED)
[!] SESSION  :: ${sock.user?.id || 'UNKNOWN'}
[!] LATENCY  :: ${latency}ms
[!] FIREWALL :: ENFORCED 🟩

> SYSTEM READY — TYPE .menu TO ENGAGE CONTROL MATRIX
`)
        }

        if (connection === 'close') {
            isConnected = false
            const statusCode = lastDisconnect?.error?.output?.statusCode

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                try { rmSync('./session', { recursive: true, force: true }) } catch {}
                console.log(chalk.red('Session logged out. Please re-authenticate.'))
                setTimeout(() => startXeonBotInc(), 5000)
                return
            }

            if (statusCode === 440) {
                console.log(chalk.red('Connection conflict (440): another session open. Waiting 15s...'))
            } else {
                console.log(chalk.yellow(`Connection closed (${statusCode || 'unknown'}). Reconnecting...`))
            }

            const delay = getReconnectDelay(statusCode)
            setTimeout(() => startXeonBotInc(), delay)
        }
    })

    // ── Message handler (single, consolidated) ────────────────────────────────
    sock.ev.on('messages.upsert', async chatUpdate => {
        try {
            const mek = chatUpdate.messages?.[0]
            if (!mek?.message) return

            // Status broadcasts → handleStatus only
            if (mek.key?.remoteJid === 'status@broadcast') {
                await handleStatus(sock, chatUpdate).catch(() => {})
                return
            }

            // All other messages → handleMessages
            await handleMessages(sock, chatUpdate, true).catch(err => {
                const msg = String(err?.message || err)
                // Suppress known non-fatal errors
                if (msg.includes('Connection Closed') || msg.includes('Bad MAC') || msg.includes('not-authorized')) return
                console.error('Error in handleMessages:', err.message)
            })
        } catch (err) {
            console.error('Error in messages.upsert:', err.message)
        }
    })

    // ── Group events ───────────────────────────────────────────────────────────
    sock.ev.on('group-participants.update', async update => {
        try { await handleGroupParticipantUpdate(sock, update) } catch {}
    })

    // ── Contact sync ───────────────────────────────────────────────────────────
    sock.ev.on('contacts.update', update => {
        for (const contact of update) {
            const id = sock.decodeJid(contact.id)
            if (store?.contacts) store.contacts[id] = { id, name: contact.notify }
        }
    })

    // ── Anticall ───────────────────────────────────────────────────────────────
    const antiCallNotified = new Set()
    sock.ev.on('call', async calls => {
        try {
            const { readState } = require('./commands/anticall')
            if (!readState().enabled) return
            for (const call of calls) {
                const callerJid = call.from || call.peerJid || call.chatId
                if (!callerJid) continue
                try {
                    if (typeof sock.rejectCall === 'function' && call.id) {
                        await sock.rejectCall(call.id, callerJid).catch(() => {})
                    }
                    if (!antiCallNotified.has(callerJid)) {
                        antiCallNotified.add(callerJid)
                        setTimeout(() => antiCallNotified.delete(callerJid), 60000)
                        await sock.sendMessage(callerJid, { text: '📵 Anticall is enabled. Your call was rejected.' })
                    }
                    setTimeout(async () => {
                        try { await sock.updateBlockStatus(callerJid, 'block') } catch {}
                    }, 800)
                } catch {}
            }
        } catch {}
    })

    sock.ev.on('creds.update', saveCreds)

    return sock
}

// ─── Start bot ────────────────────────────────────────────────────────────────
startXeonBotInc().catch(err => {
    console.error('Fatal error starting bot:', err.message)
    process.exit(1)
})

// ─── Global error suppression (non-crashing errors) ──────────────────────────
const SUPPRESSED = ['Bad MAC', 'Session error', 'decryptWithSessions', 'Connection Closed',
    'connection', 'Closing session', 'Closing open session', 'MessageCounterError',
    'Failed to decrypt', 'Decrypted message with closed session']

function isSuppressed(err) {
    const msg = String(err?.message || err)
    return SUPPRESSED.some(s => msg.includes(s))
}

process.on('uncaughtException', err => {
    if (isSuppressed(err)) return
    console.error('Uncaught Exception:', err.message)
})

process.on('unhandledRejection', err => {
    if (isSuppressed(err)) return
    console.error('Unhandled Rejection:', err?.message || err)
})