const settings = require("../settings");

async function aliveCommand(sock, chatId, message) {
    try {
        const uptime = process.uptime();
        const d = Math.floor(uptime / 86400);
        const h = Math.floor((uptime % 86400) / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = Math.floor(uptime % 60);
        const uptimeStr = `${d > 0 ? d + 'd ' : ''}${h}h ${m}m ${s}s`;
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

        const msg =
`\`\`\`
╔══════════════════════════════════════════════╗
║   S Y M P T O M . B O T  ::  v${settings.version}         ║
╚══════════════════════════════════════════════╝
[!] STATUS   :: ONLINE (NODE_CONNECTED)
[!] ROOT_ID  :: #0x7F_SYMPTOM
[!] UPTIME   :: ${uptimeStr}
[!] MEMORY   :: ${memMB}MB ALLOCATED
[!] FIREWALL :: ENFORCED 🟩
[!] THREAT   :: ZERO — ALL CLEAR

> CORE MODULES ACTIVE — AWAITING COMMAND INPUT
\`\`\``;

        try {
            await sock.sendMessage(chatId, { text: msg }, { quoted: message });
        } catch (_) {
            await sock.sendMessage(chatId, { text: msg });
        }
    } catch (error) {
        console.error('Error in alive command:', error);
        await sock.sendMessage(chatId, { text: '```\n[!] SYMPTOM_BOT :: ONLINE\n```' }, { quoted: message });
    }
}

module.exports = aliveCommand;