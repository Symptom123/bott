const os = require('os');
const settings = require('../settings.js');

function formatTime(seconds) {
    const d = Math.floor(seconds / 86400);
    seconds %= 86400;
    const h = Math.floor(seconds / 3600);
    seconds %= 3600;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${d > 0 ? d + 'd ' : ''}${h}h ${m}m ${s}s`.trim();
}

async function pingCommand(sock, chatId, message) {
    try {
        const start = Date.now();
        await sock.sendMessage(chatId, { text: '```\n[■■■■■■■■■■■■■■■■■■■■] PINGING...\n```' }, { quoted: message });
        const ping = Math.round((Date.now() - start) / 2);
        const uptime = formatTime(process.uptime());
        const memUsed = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const memTotal = Math.round(os.totalmem() / 1024 / 1024);

        const botInfo =
`\`\`\`
[+] EXECUTING TASK: /ping
[■■■■■■■■■■■■■■■■■■■■] 100% COMPLETE

┌─────────────┬────────────────────────┐
│ METRIC      │ VALUE                  │
├─────────────┼────────────────────────┤
│ LATENCY     │ ${String(ping + 'ms').padEnd(22)}│
│ UPTIME      │ ${uptime.padEnd(22)}│
│ MEMORY      │ ${(memUsed + 'MB / ' + memTotal + 'MB').padEnd(22)}│
│ VERSION     │ ${'v' + settings.version.padEnd(21)}│
│ FIREWALL    │ ENFORCED 🟩            │
│ THREAT_LVL  │ ZERO                   │
└─────────────┴────────────────────────┘

[!] SYMPTOM_BOT :: ALL SYSTEMS NOMINAL
\`\`\``;

        await sock.sendMessage(chatId, { text: botInfo }, { quoted: message });
    } catch (error) {
        console.error('Error in ping command:', error);
        await sock.sendMessage(chatId, { text: '```\n❌ PING FAILED — RETRY\n```' });
    }
}

module.exports = pingCommand;
