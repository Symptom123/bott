const { downloadMp4, searchYouTube } = require('../lib/ytDownloader');

async function videoCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            message.message?.videoMessage?.caption?.trim() ||
            '';

        const used = (rawText || '').split(/\s+/)[0] || '.video';
        const searchQuery = rawText.slice(used.length).trim();

        if (!searchQuery) {
            return await sock.sendMessage(chatId, {
                text: "🎬 What video do you want to download?\n*Usage:* .video <title or YouTube URL>\n*Example:* .video Rick Astley Never Gonna Give You Up"
            }, { quoted: message });
        }

        let searchInfo = null;
        try {
            searchInfo = await searchYouTube(searchQuery);
            if (searchInfo?.thumbnail) {
                await sock.sendMessage(chatId, {
                    image: { url: searchInfo.thumbnail },
                    caption: `🎬 *Title:* ${searchInfo.title}\n⏱ *Duration:* ${searchInfo.timestamp || 'N/A'}\n👤 *Channel:* ${searchInfo.author?.name || 'N/A'}\n\n⏳ *Downloading video in HD, please wait...*`
                }, { quoted: message });
            }
        } catch {
            await sock.sendMessage(chatId, {
                text: `⏳ Searching and downloading *"${searchQuery}"*...`
            }, { quoted: message });
        }

        const media = await downloadMp4(searchInfo?.url || searchQuery, '720');
        const safeTitle = (media.title || 'video').replace(/[\\/:*?"<>|]/g, '');

        await sock.sendMessage(chatId, {
            video: { url: media.downloadUrl },
            mimetype: "video/mp4",
            fileName: `${safeTitle}.mp4`,
            caption: `*🎬 ${media.title}*\n⏱ Duration: ${media.duration || 'N/A'}\n\n> *_Downloaded by Knight Bot MD_*`
        }, { quoted: message });

    } catch (error) {
        console.error('Error in video command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: `❌ Video download failed: ${error?.message || 'Please try again later.'}`
        }, { quoted: message });
    }
}

module.exports = videoCommand;