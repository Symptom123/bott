const axios = require('axios');
const { fbdl } = require('ruhend-scraper');

async function facebookCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            '';

        const used = (rawText || '').split(/\s+/)[0] || '.fb';
        const url = rawText.slice(used.length).trim();

        if (!url) {
            return await sock.sendMessage(chatId, {
                text: "📹 Please provide a Facebook video URL.\n*Usage:* .fb <facebook video link>\n*Example:* .fb https://www.facebook.com/watch/?v=123456"
            }, { quoted: message });
        }

        if (!url.includes('facebook.com') && !url.includes('fb.watch')) {
            return await sock.sendMessage(chatId, {
                text: "❌ Invalid URL. Please provide a valid Facebook video or reel link."
            }, { quoted: message });
        }

        await sock.sendMessage(chatId, {
            react: { text: '🔄', key: message.key }
        });

        let videoUrl = null;

        // 1. Try ruhend-scraper fbdl
        try {
            const data = await fbdl(url);
            if (data?.data?.length) {
                const vid = data.data.find(d => d.resolution === '720p (HD)' || d.resolution === 'HD') || data.data[0];
                if (vid?.url) videoUrl = vid.url;
            }
        } catch {}

        // 2. Fallback to API
        if (!videoUrl) {
            try {
                const res = await axios.get(`https://api.princetechn.com/api/download/facebook?apikey=prince&url=${encodeURIComponent(url)}`, {
                    timeout: 25000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                if (res.data?.success && res.data?.result) {
                    videoUrl = res.data.result.hd_video || res.data.result.sd_video;
                }
            } catch {}
        }

        if (!videoUrl) {
            return await sock.sendMessage(chatId, {
                text: "❌ Could not retrieve Facebook video. The video may be private, restricted, or deleted."
            }, { quoted: message });
        }

        await sock.sendMessage(chatId, {
            video: { url: videoUrl },
            mimetype: "video/mp4",
            caption: "🎥 *Downloaded by Knight Bot MD*"
        }, { quoted: message });

    } catch (error) {
        console.error('Error in Facebook command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: `❌ Facebook download failed: ${error?.message || 'Please try another link.'}`
        }, { quoted: message });
    }
}

module.exports = facebookCommand;