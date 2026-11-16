const { isJidGroup } = require('@whiskeysockets/baileys');
const { getAntilink, incrementWarningCount, resetWarningCount, isSudo } = require('../lib/index');
const isAdmin = require('../lib/isAdmin');
const config = require('../config');

const WARN_COUNT = config.WARN_COUNT || 3;

/**
 * Checks if a string contains a URL.
 *
 * @param {string} str - The string to check.
 * @returns {boolean} - True if the string contains a URL, otherwise false.
 */
function containsURL(str) {
	const urlRegex = /(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?/i;
	return urlRegex.test(str);
}

/**
 * Handles the Antilink functionality for group chats.
 *
 * @param {object} msg - The message object to process.
 * @param {object} sock - The socket object to use for sending messages.
 */
async function Antilink(msg, sock) {
	const jid = msg.key?.remoteJid;
	if (!jid || !isJidGroup(jid)) return;

	// 1. Fast check: is antilink enabled for this group? (local data read, no network call)
	const antilinkConfig = await getAntilink(jid, 'on');
	if (!antilinkConfig) return;

	// 2. Fast check: does message have text?
	const SenderMessage = msg.message?.conversation || 
						 msg.message?.extendedTextMessage?.text || '';
	if (!SenderMessage || typeof SenderMessage !== 'string') return;

	// 3. Fast check: does text contain a URL?
	if (!containsURL(SenderMessage.trim())) return;

	// 4. Only if it's a URL in an antilink-enabled group: check permissions
	const sender = msg.key.participantPn || msg.key.participant;
	if (!sender) return;
	
	const senderIsSudo = await isSudo(sender);
	if (senderIsSudo) return;

	try {
		const { isSenderAdmin } = await isAdmin(sock, jid, sender, msg);
		if (isSenderAdmin) return;
	} catch (_) {}

	const action = antilinkConfig.action;
	
	try {
		// Delete message first
		await sock.sendMessage(jid, { delete: msg.key });

		switch (action) {
			case 'delete':
				await sock.sendMessage(jid, { 
					text: `\`\`\`@${sender.split('@')[0]} link are not allowed here\`\`\``,
					mentions: [sender] 
				});
				break;

			case 'kick':
				await sock.groupParticipantsUpdate(jid, [sender], 'remove');
				await sock.sendMessage(jid, {
					text: `\`\`\`@${sender.split('@')[0]} has been kicked for sending links\`\`\``,
					mentions: [sender]
				});
				break;

			case 'warn':
				const warningCount = await incrementWarningCount(jid, sender);
				if (warningCount >= WARN_COUNT) {
					await sock.groupParticipantsUpdate(jid, [sender], 'remove');
					await resetWarningCount(jid, sender);
					await sock.sendMessage(jid, {
						text: `\`\`\`@${sender.split('@')[0]} has been kicked after ${WARN_COUNT} warnings\`\`\``,
						mentions: [sender]
					});
				} else {
					await sock.sendMessage(jid, {
						text: `\`\`\`@${sender.split('@')[0]} warning ${warningCount}/${WARN_COUNT} for sending links\`\`\``,
						mentions: [sender]
					});
				}
				break;
		}
	} catch (error) {
		console.error('Error in Antilink:', error);
	}
}

module.exports = { Antilink };