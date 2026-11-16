const { downloadMp3, searchYouTube } = require('../lib/ytDownloader');

async function songCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            '';

        const used = (rawText || '').split(/\s+/)[0] || '.song';
        const searchQuery = rawText.slice(used.length).trim();

        if (!searchQuery) {
            return await sock.sendMessage(chatId, {
                text: "🎵 Please provide a song name or YouTube link.\n*Usage:* .song <name or URL>\n*Example:* .song Let Her Go Passenger"
            }, { quoted: message });
        }

        let searchInfo = null;
        try {
            searchInfo = await searchYouTube(searchQuery);
            if (searchInfo?.thumbnail) {
                await sock.sendMessage(chatId, {
                    image: { url: searchInfo.thumbnail },
                    caption: `🎵 *Title:* ${searchInfo.title}\n⏱ *Duration:* ${searchInfo.timestamp || 'N/A'}\n👤 *Channel:* ${searchInfo.author?.name || 'N/A'}\n\n⏳ *Downloading audio...*`
                }, { quoted: message });
            }
        } catch {
            await sock.sendMessage(chatId, {
                text: `⏳ Searching and downloading *"${searchQuery}"*...`
            }, { quoted: message });
        }

        const media = await downloadMp3(searchInfo?.url || searchQuery);
        const safeTitle = (media.title || 'audio').replace(/[\\/:*?"<>|]/g, '');

        await sock.sendMessage(chatId, {
            audio: { url: media.downloadUrl },
            mimetype: "audio/mpeg",
            fileName: `${safeTitle}.mp3`,
            ptt: false
        }, { quoted: message });

    } catch (error) {
        console.error('Error in song command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: `❌ Failed to download song: ${error?.message || 'Please try again later.'}`
        }, { quoted: message });
    }
}

module.exports = songCommand;
