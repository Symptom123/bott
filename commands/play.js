const { downloadMp3, searchYouTube } = require('../lib/ytDownloader');

async function playCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            '';

        const used = (rawText || '').split(/\s+/)[0] || '.play';
        const searchQuery = rawText.slice(used.length).trim();

        if (!searchQuery) {
            return await sock.sendMessage(chatId, {
                text: "🎵 What song do you want to play?\n*Usage:* .play <song name or YouTube URL>\n*Example:* .play Faded Alan Walker"
            }, { quoted: message });
        }

        // Search first to give instant feedback with thumbnail
        let searchInfo = null;
        try {
            searchInfo = await searchYouTube(searchQuery);
            if (searchInfo?.thumbnail) {
                await sock.sendMessage(chatId, {
                    image: { url: searchInfo.thumbnail },
                    caption: `🎵 *Title:* ${searchInfo.title}\n⏱ *Duration:* ${searchInfo.timestamp || 'N/A'}\n👤 *Channel:* ${searchInfo.author?.name || 'N/A'}\n\n⏳ *Downloading audio, please wait...*`
                }, { quoted: message });
            }
        } catch {
            await sock.sendMessage(chatId, {
                text: `⏳ Searching and downloading *"${searchQuery}"*...`
            }, { quoted: message });
        }

        // Download MP3 using reliable converter
        const media = await downloadMp3(searchInfo?.url || searchQuery);

        const safeTitle = (media.title || 'audio').replace(/[\\/:*?"<>|]/g, '');

        await sock.sendMessage(chatId, {
            audio: { url: media.downloadUrl },
            mimetype: "audio/mpeg",
            fileName: `${safeTitle}.mp3`,
            ptt: false
        }, { quoted: message });

    } catch (error) {
        console.error('Error in play command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: `❌ Download failed: ${error?.message || 'Please try again with a different song name.'}`
        }, { quoted: message });
    }
}

module.exports = playCommand;