    const groupCache = new Map();
    const CACHE_TTL = 3 * 60 * 1000; // 3 minutes cache

    async function getGroupMetadataSafely(sock, chatId) {
        const cached = groupCache.get(chatId);
        if (cached && Date.now() - cached.time < CACHE_TTL) {
            return cached.data;
        }

        // 6 second timeout to prevent hanging the message thread forever
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('groupMetadata request timed out after 6000ms')), 6000)
        );

        const data = await Promise.race([sock.groupMetadata(chatId), timeout]);
        if (data && data.participants) {
            groupCache.set(chatId, { data, time: Date.now() });
        }
        return data;
    }

    async function isAdmin(sock, chatId, senderId, message, senderPhone) {
        try {
            const groupMetadata = await getGroupMetadataSafely(sock, chatId);
            if (!groupMetadata || !groupMetadata.participants) {
                return { isSenderAdmin: false, isBotAdmin: false };
            }
            
            const rawBotId = sock.user?.id || '';
            const botId = rawBotId ? (rawBotId.split(':')[0] + '@s.whatsapp.net') : '';

            // Build a set of all possible sender identifiers to match against
            // This handles both LID format and phone-based JID format
            const senderCandidates = new Set();
            if (senderId) senderCandidates.add(senderId);
            if (senderPhone) senderCandidates.add(senderPhone);
            // Extract raw participant from message (may be LID even if senderId is phone-based)
            if (message && message.key) {
                if (message.key.participant) senderCandidates.add(message.key.participant);
                if (message.key.participantPn) senderCandidates.add(message.key.participantPn);
            }
            // Add cross-suffix variants as last resort
            for (const c of [...senderCandidates]) {
                if (c.endsWith('@lid')) senderCandidates.add(c.replace('@lid', '@s.whatsapp.net'));
                if (c.endsWith('@s.whatsapp.net')) senderCandidates.add(c.replace('@s.whatsapp.net', '@lid'));
            }

            const participant = groupMetadata.participants.find(p => {
                if (senderCandidates.has(p.id)) return true;
                // Check participant's lid property
                if (p.lid && senderCandidates.has(p.lid)) return true;
                return false;
            });
            
            const bot = groupMetadata.participants.find(p => 
                (botId && p.id === botId) || 
                (botId && p.id === botId.replace('@s.whatsapp.net', '@lid')) ||
                (botId && p.lid && p.lid === botId)
            );
            
            const isBotAdmin = bot ? (bot.admin === 'admin' || bot.admin === 'superadmin') : false;
            const isSenderAdmin = participant ? (participant.admin === 'admin' || participant.admin === 'superadmin') : false;

            if (!bot) {
                return { isSenderAdmin, isBotAdmin: true };
            }

            return { isSenderAdmin, isBotAdmin };
        } catch (error) {
            console.error('Error in isAdmin:', error.message || error);
            // Fallback: check if we have older cached data
            const fallback = groupCache.get(chatId);
            if (fallback?.data?.participants) {
                const participant = fallback.data.participants.find(p => p.id === senderId);
                return {
                    isSenderAdmin: participant ? (participant.admin === 'admin' || participant.admin === 'superadmin') : false,
                    isBotAdmin: true
                };
            }
            return { isSenderAdmin: false, isBotAdmin: false };
        }
    }

    module.exports = isAdmin;
