const settings = require('../settings');
const fs = require('fs');
const path = require('path');

async function helpCommand(sock, chatId, message) {

    const header =
`\`\`\`
╔══════════════════════════════════════════════╗
║   S Y M P T O M . B O T  ::  v${settings.version}         ║
║   ROOT_ID :: #0x7F_SYMPTOM                   ║
║   STATUS  :: ONLINE (NODE_CONNECTED)         ║
╚══════════════════════════════════════════════╝
\`\`\``;

    const helpMessage =
`${header}

\`\`\`
┌───[ SYMPTOM_BOT :: CORE_MODULES ]────────────┐
│                                              │
│  ⚡ GENERAL_MODULE                           │
│  ├── .ping      → System Diagnostics        │
│  ├── .alive     → Node Status Check         │
│  ├── .owner     → Root Admin Info           │
│  ├── .joke      → Random Joke Feed          │
│  ├── .quote     → Quote Injection           │
│  ├── .fact      → Fact Database             │
│  ├── .weather   → Geo-Weather Query         │
│  ├── .news      → Live News Feed            │
│  ├── .tts       → Text-to-Speech           │
│  ├── .attp      → Animated Text Sticker     │
│  ├── .lyrics    → Track Lyrics Scan         │
│  ├── .8ball     → Prediction Module         │
│  ├── .groupinfo → Group Node Data           │
│  ├── .staff     → Admin Node List           │
│  ├── .vv        → View-Once Decrypt         │
│  ├── .trt       → Language Translate        │
│  └── .ss        → URL Screenshot            │
│                                              │
│  🛡️  ADMIN_MODULE                            │
│  ├── .ban       → Blacklist Node            │
│  ├── .kick      → Eject Node               │
│  ├── .promote   → Elevate Privileges        │
│  ├── .demote    → Revoke Privileges         │
│  ├── .mute      → Silence Channel           │
│  ├── .unmute    → Restore Channel           │
│  ├── .delete    → Purge Message             │
│  ├── .warn      → Issue Warning             │
│  ├── .warnings  → View Warning Log          │
│  ├── .tag       → Broadcast to Node         │
│  ├── .tagall    → Mass Broadcast            │
│  ├── .hidetag   → Silent Broadcast          │
│  ├── .antilink  → Link Filter Toggle        │
│  ├── .antibadword → Profanity Filter        │
│  ├── .chatbot   → AI Chatbot Toggle         │
│  ├── .resetlink → Rotate Invite Link        │
│  ├── .welcome   → Entry Alert Toggle        │
│  └── .goodbye   → Exit Alert Toggle         │
│                                              │
│  🔐 OWNER_MODULE                             │
│  ├── .mode      → Public/Private Toggle     │
│  ├── .antidelete→ Message Recovery          │
│  ├── .anticall  → Call Shield               │
│  ├── .pmblocker → DM Shield                 │
│  ├── .autostatus→ Status Watcher            │
│  ├── .autotyping→ Typing Emulator           │
│  ├── .autoread  → Read Receipt Auto         │
│  ├── .setpp     → Update Bot Avatar         │
│  └── .cleartmp  → Clear Cache               │
│                                              │
└──────────────────────────────────────────────┘
\`\`\`

\`\`\`
┌───[ SYMPTOM_BOT :: MEDIA_MODULES ]───────────┐
│                                              │
│  🎵 AUDIO_MODULE                             │
│  ├── .play      → Stream to MP3             │
│  ├── .song      → Track Download            │
│  └── .spotify   → Spotify Query             │
│                                              │
│  🎬 VIDEO_MODULE                             │
│  ├── .video     → YouTube MP4               │
│  ├── .tiktok    → TikTok Download           │
│  ├── .instagram → IG Media Extract          │
│  └── .facebook  → FB Video Download         │
│                                              │
│  🖼️  IMAGE_MODULE                            │
│  ├── .sticker   → Image → Sticker           │
│  ├── .blur      → Image Blur Filter         │
│  ├── .removebg  → Background Remove         │
│  ├── .remini    → AI Enhance Image          │
│  └── .simage    → Sticker → Image           │
│                                              │
└──────────────────────────────────────────────┘
\`\`\`

\`\`\`
┌───[ SYMPTOM_BOT :: AI_MODULES ]──────────────┐
│                                              │
│  🤖 AI_ENGINE                                │
│  ├── .ai        → GPT Neural Query          │
│  ├── .gpt       → GPT-4 Interface           │
│  ├── .gemini    → Gemini Pro Interface       │
│  ├── .imagine   → AI Image Generate         │
│  └── .flux      → Flux AI Render            │
│                                              │
└──────────────────────────────────────────────┘
\`\`\`

\`\`\`
┌───[ SYMPTOM_BOT :: FUN_MODULES ]─────────────┐
│                                              │
│  🎮 GAME_CORE                                │
│  ├── .tictactoe → Launch TicTacToe          │
│  ├── .hangman   → Hangman Protocol          │
│  ├── .trivia    → Trivia Database Query     │
│  ├── .truth     → Truth Matrix              │
│  └── .dare      → Dare Generator            │
│                                              │
│  💬 SOCIAL_MODULE                            │
│  ├── .compliment → Social Boost             │
│  ├── .insult    → Social Strike             │
│  ├── .flirt     → Charm Protocol            │
│  ├── .ship      → Compatibility Scan        │
│  └── .wasted    → Wasted Frame              │
│                                              │
└──────────────────────────────────────────────┘
\`\`\`

\`\`\`
> TYPE .ping FOR SYSTEM DIAGNOSTICS
> TYPE .alive FOR NODE STATUS
> SYMPTOM_BOT v${settings.version} :: ALL MODULES LOADED ✅
\`\`\``;

    try {
        const imagePath = path.join(__dirname, '../assets/bot_image.jpg');
        if (fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);
            try {
                await sock.sendMessage(chatId, { image: imageBuffer, caption: helpMessage }, { quoted: message });
            } catch (_) {
                await sock.sendMessage(chatId, { image: imageBuffer, caption: helpMessage });
            }
        } else {
            try {
                await sock.sendMessage(chatId, { text: helpMessage }, { quoted: message });
            } catch (_) {
                await sock.sendMessage(chatId, { text: helpMessage });
            }
        }
    } catch (error) {
        console.error('Error in help command:', error);
        await sock.sendMessage(chatId, { text: helpMessage });
    }
}

module.exports = helpCommand;
