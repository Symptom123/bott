/**
 * Per-user store factory — wraps lightweight_store to give each user their own isolated store
 */
const path = require('path')
const fs = require('fs')

// We reuse the same store logic but with per-user data
class UserStore {
    constructor(username) {
        this.username = username
        this.messages = {}
        this.contacts = {}
        this.chats = {}
        this.MAX_MESSAGES = 100

        this.dataFile = path.join(__dirname, '..', 'sessions', username, 'store.json')
        this._readFromFile()

        // Persist every 20s
        this._interval = setInterval(() => this._writeToFile(), 20000)
    }

    _readFromFile() {
        try {
            if (fs.existsSync(this.dataFile)) {
                const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'))
                this.messages = data.messages || {}
                this.contacts = data.contacts || {}
                this.chats = data.chats || {}
            }
        } catch {}
    }

    _writeToFile() {
        try {
            fs.writeFileSync(this.dataFile, JSON.stringify({
                messages: this.messages,
                contacts: this.contacts,
                chats: this.chats,
            }))
        } catch {}
    }

    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages) {
                if (msg.key?.remoteJid) this.saveMessage(msg.key.remoteJid, msg)
            }
        })
        ev.on('contacts.upsert', contacts => {
            for (const c of contacts) {
                this.contacts[c.id] = c
            }
        })
        ev.on('chats.upsert', chats => {
            for (const c of chats) {
                this.chats[c.id] = c
            }
        })
    }

    saveMessage(jid, msg) {
        if (!jid || !msg?.key?.id) return
        if (!this.messages[jid]) this.messages[jid] = []
        // Remove old duplicate
        const idx = this.messages[jid].findIndex(m => m?.key?.id === msg.key.id)
        if (idx !== -1) this.messages[jid].splice(idx, 1)
        this.messages[jid].push(msg)
        if (this.messages[jid].length > this.MAX_MESSAGES) {
            this.messages[jid] = this.messages[jid].slice(-this.MAX_MESSAGES)
        }
    }

    async loadMessage(jid, id) {
        return this.messages[jid]?.find(m => m?.key?.id === id) || null
    }

    destroy() {
        clearInterval(this._interval)
        this._writeToFile()
    }
}

// Cache store instances
const storeCache = new Map()

function createStore(username) {
    if (storeCache.has(username)) return storeCache.get(username)
    const store = new UserStore(username)
    storeCache.set(username, store)
    return store
}

function destroyStore(username) {
    const store = storeCache.get(username)
    if (store) {
        store.destroy()
        storeCache.delete(username)
    }
}

module.exports = { createStore, destroyStore, UserStore }
