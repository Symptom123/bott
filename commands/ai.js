const axios = require('axios');

async function aiCommand(sock, chatId, message) {
    try {
        const rawText = message.message?.conversation?.trim() ||
            message.message?.extendedTextMessage?.text?.trim() ||
            message.message?.imageMessage?.caption?.trim() ||
            '';

        if (!rawText) {
            return await sock.sendMessage(chatId, {
                text: "🤖 *AI Assistant*\nPlease provide a prompt or question.\n*Example:* .ai Explain quantum computing in simple terms\n*Aliases:* .ai, .gpt, .gemini"
            }, { quoted: message });
        }

        const parts = rawText.split(/\s+/);
        const command = parts[0].toLowerCase();
        const query = parts.slice(1).join(' ').trim();

        if (!query) {
            return await sock.sendMessage(chatId, {
                text: "🤖 Please ask a question after the command.\n*Example:* " + command + " write a poem about the ocean"
            }, { quoted: message });
        }

        // Send reaction indicator
        await sock.sendMessage(chatId, {
            react: { text: '🧠', key: message.key }
        });

        // Determine model based on command
        let modelParam = '';
        if (command === '.gemini') {
            modelParam = '?model=gemini';
        } else if (command === '.gpt') {
            modelParam = '?model=openai';
        }

        const systemPrompt = encodeURIComponent('You are Knight Bot AI, a helpful, friendly, and intelligent AI assistant on WhatsApp. Answer concisely and clearly.');
        const url = `https://text.pollinations.ai/${encodeURIComponent(query)}${modelParam ? modelParam + '&' : '?'}system=${systemPrompt}`;

        const response = await axios.get(url, {
            timeout: 25000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const replyText = typeof response.data === 'string' ? response.data.trim() : JSON.stringify(response.data);

        if (!replyText) {
            throw new Error('Empty response from AI engine');
        }

        await sock.sendMessage(chatId, {
            text: replyText
        }, { quoted: message });

    } catch (error) {
        console.error('Error in AI command:', error?.message || error);
        await sock.sendMessage(chatId, {
            text: "❌ AI service is temporarily unavailable. Please try again in a moment."
        }, { quoted: message });
    }
}

module.exports = aiCommand;