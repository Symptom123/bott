const { downloadMp3, searchYouTube } = require('../lib/ytDownloader');

async function spotifyCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            '';

        const used = (rawText || '').split(/\s+/)[0] || '.spotify';
        const query = rawText.slice(used.length).trim();

        if (!query) {
            return await sock.sendMessage(chatId, {
                text: "🟢 *Spotify Music Search*\n*Usage:* .spotify <song title or artist>\n*Example:* .spotify Shape of You Ed Sheeran"
            }, { quoted: message });
        }

        let searchInfo = null;
        try {
            searchInfo = await searchYouTube(query + ' audio');
            if (searchInfo?.thumbnail) {
                await sock.sendMessage(chatId, {
                    image: { url: searchInfo.thumbnail },
                    caption: `🟢 *Spotify Track:* ${searchInfo.title}\n👤 *Artist:* ${searchInfo.author?.name || 'N/A'}\n⏱ *Duration:* ${searchInfo.timestamp || 'N/A'}\n\n⏳ *Fetching high-quality audio...*`
                }, { quoted: message });
            }
        } catch {
            await sock.sendMessage(chatId, {
                text: `⏳ Searching and downloading *"${query}"*...`
            }, { quoted: message });
        }

        const media = await downloadMp3(searchInfo?.url || query);
        const safeTitle = (media.title || 'track').replace(/[\\/:*?"<>|]/g, '');

        await sock.sendMessage(chatId, {
            audio: { url: media.downloadUrl },
            mimetype: "audio/mpeg",
            fileName: `${safeTitle}.mp3`,
            ptt: false
        }, { quoted: message });

    } catch (error) {
        console.error('Error in spotify command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: `❌ Spotify download failed: ${error?.message || 'Please try another song title.'}`
        }, { quoted: message });
    }
}

module.exports = spotifyCommand;
