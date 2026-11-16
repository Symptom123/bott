const fs = require('fs');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const VO_DIR = path.join(__dirname, '../tmp/viewonce');
if (!fs.existsSync(VO_DIR)) {
    fs.mkdirSync(VO_DIR, { recursive: true });
}

// In-memory index of cached view-once messages: msgId -> metadata
const voCache = new Map();

// Periodic cleanup of cached files older than 12 hours
function cleanupOldCache() {
    try {
        const now = Date.now();
        const maxAge = 12 * 60 * 60 * 1000;
        for (const [id, item] of voCache.entries()) {
            if (now - item.timestamp > maxAge) {
                if (item.filePath && fs.existsSync(item.filePath)) {
                    try { fs.unlinkSync(item.filePath); } catch {}
                }
                voCache.delete(id);
            }
        }
    } catch {}
}
setInterval(cleanupOldCache, 30 * 60 * 1000);

// Helper to normalize mediaKey to a real Buffer
function normalizeMediaObject(media) {
    if (!media) return null;
    const clone = { ...media };
    if (clone.mediaKey) {
        if (clone.mediaKey.type === 'Buffer' && Array.isArray(clone.mediaKey.data)) {
            clone.mediaKey = Buffer.from(clone.mediaKey.data);
        } else if (clone.mediaKey instanceof Uint8Array && !Buffer.isBuffer(clone.mediaKey)) {
            clone.mediaKey = Buffer.from(clone.mediaKey);
        } else if (typeof clone.mediaKey === 'string') {
            clone.mediaKey = Buffer.from(clone.mediaKey, 'base64');
        }
    }
    return clone;
}

// Helper to extract view-once media from any wrapping layers
function extractViewOnceMedia(msg) {
    if (!msg) return null;
    let actual = msg;
    if (actual.ephemeralMessage?.message) actual = actual.ephemeralMessage.message;
    if (actual.viewOnceMessageV2?.message) actual = actual.viewOnceMessageV2.message;
    if (actual.viewOnceMessage?.message) actual = actual.viewOnceMessage.message;
    if (actual.viewOnceMessageV2Extension?.message) actual = actual.viewOnceMessageV2Extension.message;
    if (actual.documentWithCaptionMessage?.message) actual = actual.documentWithCaptionMessage.message;

    if (actual.imageMessage) {
        return {
            type: 'image',
            media: actual.imageMessage,
            caption: actual.imageMessage.caption || '',
            mimetype: actual.imageMessage.mimetype || 'image/jpeg'
        };
    }
    if (actual.videoMessage) {
        return {
            type: 'video',
            media: actual.videoMessage,
            caption: actual.videoMessage.caption || '',
            mimetype: actual.videoMessage.mimetype || 'video/mp4'
        };
    }
    if (actual.audioMessage) {
        return {
            type: 'audio',
            media: actual.audioMessage,
            caption: '',
            mimetype: actual.audioMessage.mimetype || 'audio/mp4',
            ptt: actual.audioMessage.ptt ?? true
        };
    }
    return null;
}

// Send unlocked media back to chat
async function sendUnlockedMedia(sock, chatId, quotedMsg, type, buffer, caption, mimetype, ptt) {
    if (type === 'image') {
        const text = caption ? `*🔓 View-Once Image:*\n${caption}` : '*🔓 View-Once Image*';
        await sock.sendMessage(chatId, {
            image: buffer,
            caption: text,
            mimetype: mimetype || 'image/jpeg'
        }, { quoted: quotedMsg });
    } else if (type === 'video') {
        const text = caption ? `*🔓 View-Once Video:*\n${caption}` : '*🔓 View-Once Video*';
        await sock.sendMessage(chatId, {
            video: buffer,
            caption: text,
            mimetype: mimetype || 'video/mp4'
        }, { quoted: quotedMsg });
    } else if (type === 'audio') {
        await sock.sendMessage(chatId, {
            audio: buffer,
            mimetype: mimetype || 'audio/mp4',
            ptt: ptt ?? true
        }, { quoted: quotedMsg });
    }
}

// Cache incoming view-once messages as soon as received
async function cacheViewOnce(message) {
    try {
        if (!message?.key?.id || !message?.message) return;
        const msgId = message.key.id;

        const raw = message.message;
        const isVO = !!(
            raw.viewOnceMessage ||
            raw.viewOnceMessageV2 ||
            raw.viewOnceMessageV2Extension ||
            raw.ephemeralMessage?.message?.viewOnceMessage ||
            raw.ephemeralMessage?.message?.viewOnceMessageV2 ||
            raw.ephemeralMessage?.message?.viewOnceMessageV2Extension
        );
        if (!isVO) return;

        const extracted = extractViewOnceMedia(raw);
        if (!extracted?.media) return;

        const normalized = normalizeMediaObject(extracted.media);
        if (!normalized.mediaKey || normalized.mediaKey.length === 0) return;

        const ext = extracted.type === 'image' ? 'jpg' : extracted.type === 'video' ? 'mp4' : 'mp3';
        const filePath = path.join(VO_DIR, `${msgId}.${ext}`);

        try {
            const stream = await downloadContentFromMessage(normalized, extracted.type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

            await fs.promises.writeFile(filePath, buffer);
            voCache.set(msgId, {
                filePath,
                buffer,
                type: extracted.type,
                caption: extracted.caption,
                mimetype: extracted.mimetype,
                ptt: extracted.ptt,
                timestamp: Date.now()
            });

            if (voCache.size > 150) {
                const oldestKey = voCache.keys().next().value;
                const oldest = voCache.get(oldestKey);
                if (oldest?.filePath && fs.existsSync(oldest.filePath)) {
                    try { fs.unlinkSync(oldest.filePath); } catch {}
                }
                voCache.delete(oldestKey);
            }
        } catch {
            // Keep metadata with mediaKey in cache for on-demand retry
            voCache.set(msgId, {
                media: normalized,
                type: extracted.type,
                caption: extracted.caption,
                mimetype: extracted.mimetype,
                ptt: extracted.ptt,
                timestamp: Date.now()
            });
        }
    } catch {}
}

// Main command handler for .vv / .viewonce
async function viewonceCommand(sock, chatId, message) {
    try {
        const store = require('../lib/lightweight_store');
        const contextInfo = message.message?.extendedTextMessage?.contextInfo;
        const stanzaId = contextInfo?.stanzaId;
        const quoted = contextInfo?.quotedMessage;

        // 1. Check if the message itself is a view-once
        let targetMedia = extractViewOnceMedia(message.message);

        // 2. Check quoted message
        if (!targetMedia && quoted) {
            targetMedia = extractViewOnceMedia(quoted);
        }

        if (!targetMedia && !stanzaId) {
            return await sock.sendMessage(chatId, {
                text: '❌ Please reply to a view-once image, video, or voice note with *.vv*'
            }, { quoted: message });
        }

        // 3. Check memory cache for pre-downloaded buffer
        if (stanzaId && voCache.has(stanzaId)) {
            const cached = voCache.get(stanzaId);
            let buffer = cached.buffer;
            if (!buffer && cached.filePath && fs.existsSync(cached.filePath)) {
                try { buffer = await fs.promises.readFile(cached.filePath); } catch {}
            }

            if (buffer && buffer.length > 0) {
                return await sendUnlockedMedia(sock, chatId, message, cached.type, buffer, cached.caption, cached.mimetype, cached.ptt);
            }

            if (cached.media) {
                targetMedia = {
                    type: cached.type,
                    media: cached.media,
                    caption: cached.caption,
                    mimetype: cached.mimetype,
                    ptt: cached.ptt
                };
            }
        }

        // 4. Check disk cache
        if (stanzaId) {
            for (const ext of ['jpg', 'mp4', 'mp3']) {
                const diskPath = path.join(VO_DIR, `${stanzaId}.${ext}`);
                if (fs.existsSync(diskPath)) {
                    try {
                        const buf = await fs.promises.readFile(diskPath);
                        if (buf && buf.length > 0) {
                            const type = ext === 'jpg' ? 'image' : ext === 'mp4' ? 'video' : 'audio';
                            const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'mp4' ? 'video/mp4' : 'audio/mp4';
                            return await sendUnlockedMedia(sock, chatId, message, type, buf, '', mime, type === 'audio');
                        }
                    } catch {}
                }
            }
        }

        // 5. Check store for original message (which has mediaKey)
        if (stanzaId && store?.loadMessage) {
            const originalMsg = await store.loadMessage(chatId, stanzaId);
            if (originalMsg?.message) {
                const fromStore = extractViewOnceMedia(originalMsg.message);
                if (fromStore?.media) {
                    const norm = normalizeMediaObject(fromStore.media);
                    if (norm.mediaKey && norm.mediaKey.length > 0) {
                        targetMedia = {
                            type: fromStore.type,
                            media: norm,
                            caption: fromStore.caption,
                            mimetype: fromStore.mimetype,
                            ptt: fromStore.ptt
                        };
                    }
                }
            }
        }

        if (!targetMedia || !targetMedia.media) {
            return await sock.sendMessage(chatId, {
                text: '❌ Please reply to a valid view-once image, video, or voice note.'
            }, { quoted: message });
        }

        const normalizedMedia = normalizeMediaObject(targetMedia.media);
        if (!normalizedMedia.mediaKey || normalizedMedia.mediaKey.length === 0) {
            return await sock.sendMessage(chatId, {
                text: '❌ Cannot retrieve this view-once media: WhatsApp omitted the decryption key in this quote, and the message was sent before the bot was online to cache it.\n\n💡 *Tip:* View-once messages received while the bot is running can always be opened with *.vv*.'
            }, { quoted: message });
        }

        // 6. Download content using the valid mediaKey
        const stream = await downloadContentFromMessage(normalizedMedia, targetMedia.type);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        if (!buffer || buffer.length === 0) {
            return await sock.sendMessage(chatId, { text: '❌ Failed to download media content.' }, { quoted: message });
        }

        await sendUnlockedMedia(sock, chatId, message, targetMedia.type, buffer, targetMedia.caption, targetMedia.mimetype, targetMedia.ptt);

    } catch (error) {
        console.error('Error in viewonceCommand:', error.message);
        await sock.sendMessage(chatId, {
            text: `❌ Error downloading view-once media: ${error.message || 'Unknown error'}`
        }, { quoted: message });
    }
}

module.exports = {
    viewonceCommand,
    cacheViewOnce
};