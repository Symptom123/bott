const axios = require('axios');
const yts = require('yt-search');

const HOSTS = [
    {
        init: 'https://p.savenow.to/ajax/download.php',
        progress: 'https://p.savenow.to/api/progress'
    },
    {
        init: 'https://loader.to/ajax/download.php',
        progress: 'https://loader.to/api/progress'
    }
];

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function searchYouTube(query) {
    if (!query) throw new Error('Search query is required');
    const result = await yts(query);
    if (!result?.videos?.length) throw new Error('No videos found for query: ' + query);
    return result.videos[0];
}

async function convertWithHost(host, videoUrl, format) {
    const initRes = await axios.get(`${host.init}?format=${format}&url=${encodeURIComponent(videoUrl)}`, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 15000
    });

    if (!initRes.data?.success || !initRes.data?.id) {
        throw new Error('Host init failed');
    }

    const id = initRes.data.id;
    for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const progRes = await axios.get(`${host.progress}?id=${id}`, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });

        if (progRes.data?.download_url) {
            return progRes.data.download_url;
        }

        if (progRes.data?.success === -1 || progRes.data?.error) {
            throw new Error('Conversion failed on server');
        }
    }
    throw new Error('Conversion timed out');
}

async function downloadMp3(queryOrUrl) {
    let videoUrl = queryOrUrl.trim();
    let videoInfo = null;

    if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) {
        videoInfo = await searchYouTube(queryOrUrl);
        videoUrl = videoInfo.url;
    } else {
        try {
            const parsed = await yts({ videoId: (videoUrl.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/) || [])[1] });
            videoInfo = parsed;
        } catch {}
    }

    let lastError = null;
    for (const host of HOSTS) {
        try {
            const dlUrl = await convertWithHost(host, videoUrl, 'mp3');
            return {
                downloadUrl: dlUrl,
                title: videoInfo?.title || 'Unknown Title',
                author: videoInfo?.author?.name || 'Unknown Artist',
                duration: videoInfo?.timestamp || '',
                thumbnail: videoInfo?.thumbnail || '',
                url: videoUrl
            };
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('All download hosts failed');
}

async function downloadMp4(queryOrUrl, quality = '720') {
    let videoUrl = queryOrUrl.trim();
    let videoInfo = null;

    if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) {
        videoInfo = await searchYouTube(queryOrUrl);
        videoUrl = videoInfo.url;
    } else {
        try {
            const parsed = await yts({ videoId: (videoUrl.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/) || [])[1] });
            videoInfo = parsed;
        } catch {}
    }

    let lastError = null;
    for (const host of HOSTS) {
        try {
            const dlUrl = await convertWithHost(host, videoUrl, quality);
            return {
                downloadUrl: dlUrl,
                title: videoInfo?.title || 'Unknown Video',
                author: videoInfo?.author?.name || '',
                duration: videoInfo?.timestamp || '',
                thumbnail: videoInfo?.thumbnail || '',
                url: videoUrl
            };
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('All download hosts failed');
}

module.exports = {
    searchYouTube,
    downloadMp3,
    downloadMp4
};
