const fs = require('fs')
const STORE_FILE = './baileys_store.json'

// Config: keep last 100 messages per chat
let MAX_MESSAGES = 100

// Try to read config from settings
try {
    const settings = require('../settings.js')
    if (settings.maxStoreMessages && typeof settings.maxStoreMessages === 'number') {
        MAX_MESSAGES = settings.maxStoreMessages
    }
} catch (e) {
    // Use default if settings not available
}

const store = {
    messages: {},
    contacts: {},
    chats: {},

    readFromFile(filePath = STORE_FILE) {
        try {
            if (fs.existsSync(filePath)) {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
                this.contacts = data.contacts || {}
                this.chats = data.chats || {}
                this.messages = data.messages || {}
                
                // Clean up any existing data to match new format
                this.cleanupData()
            }
        } catch (e) {
            console.warn('Failed to read store file:', e.message)
        }
    },

    writeToFile(filePath = STORE_FILE) {
        try {
            const data = JSON.stringify({
                contacts: this.contacts,
                chats: this.chats,
                messages: this.messages
            })
            fs.writeFileSync(filePath, data)
        } catch (e) {
            console.warn('Failed to write store file:', e.message)
        }
    },

    cleanupData() {
        // Convert old format messages to new format if needed
        if (this.messages) {
            Object.keys(this.messages).forEach(jid => {
                if (typeof this.messages[jid] === 'object' && !Array.isArray(this.messages[jid])) {
                    // Old format - convert to new format
                    const messages = Object.values(this.messages[jid])
                    this.messages[jid] = messages.slice(-MAX_MESSAGES)
                }
            })
        }
    },

    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            if (!Array.isArray(messages)) return
            messages.forEach(msg => {
                if (!msg?.key?.remoteJid) return
                this.saveMessage(msg.key.remoteJid, msg)
            })
        })

        ev.on('contacts.update', (contacts) => {
            contacts.forEach(contact => {
                if (contact.id) {
                    this.contacts[contact.id] = {
                        id: contact.id,
                        name: contact.notify || contact.name || ''
                    }
                }
            })
        })

        ev.on('chats.set', (chats) => {
            this.chats = {}
            chats.forEach(chat => {
                this.chats[chat.id] = { id: chat.id, subject: chat.subject || '' }
            })
        })
    },

    saveMessage(jid, msg) {
        if (!jid || !msg || !msg.key?.id) return
        this.messages[jid] = this.messages[jid] || []
        const existsIndex = this.messages[jid].findIndex(m => m.key?.id === msg.key?.id)
        if (existsIndex >= 0) {
            this.messages[jid][existsIndex] = msg
        } else {
            this.messages[jid].push(msg)
            if (this.messages[jid].length > MAX_MESSAGES) {
                this.messages[jid] = this.messages[jid].slice(-MAX_MESSAGES)
            }
        }
    },

    async loadMessage(jid, id) {
        if (!id) return null
        if (jid && this.messages[jid]) {
            const found = this.messages[jid].find(m => m.key?.id === id)
            if (found) return found
        }
        // Fallback: search in all chats in case jid format differs (e.g., normalized jid vs device jid)
        for (const key of Object.keys(this.messages)) {
            const found = this.messages[key]?.find(m => m.key?.id === id)
            if (found) return found
        }
        return null
    },

    // Get store statistics
    getStats() {
        let totalMessages = 0
        let totalContacts = Object.keys(this.contacts).length
        let totalChats = Object.keys(this.chats).length
        
        Object.values(this.messages).forEach(chatMessages => {
            if (Array.isArray(chatMessages)) {
                totalMessages += chatMessages.length
            }
        })
        
        return {
            messages: totalMessages,
            contacts: totalContacts,
            chats: totalChats,
            maxMessagesPerChat: MAX_MESSAGES
        }
    }
}

module.exports = store
