    async function isAdmin(sock, chatId, senderId, message, senderPhone) {
        try {
            const groupMetadata = await sock.groupMetadata(chatId);
            
            const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

            // Build a set of all possible sender identifiers to match against
            // This handles both LID format and phone-based JID format
            const senderCandidates = new Set([senderId]);
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
                p.id === botId || 
                p.id === botId.replace('@s.whatsapp.net', '@lid') ||
                (p.lid && p.lid === botId)
            );
            
            const isBotAdmin = bot && (bot.admin === 'admin' || bot.admin === 'superadmin');
            const isSenderAdmin = participant && (participant.admin === 'admin' || participant.admin === 'superadmin');

            if (!bot) {
                return { isSenderAdmin, isBotAdmin: true };
            }

            return { isSenderAdmin, isBotAdmin };
        } catch (error) {
            console.error('Error in isAdmin:', error);
            return { isSenderAdmin: false, isBotAdmin: false };
        }
    }

    module.exports = isAdmin;
