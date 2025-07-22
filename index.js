const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

// --- Configuration via Environment Variables ---
// Secure and flexible for deployment
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const PORT = process.env.PORT || 3000;

if (!N8N_WEBHOOK_URL || !GATEWAY_API_KEY) {
    console.error("Error: N8N_WEBHOOK_URL and GATEWAY_API_KEY must be set as environment variables.");
    process.exit(1);
}

// --- Set up Express Server ---
// For receiving commands from n8n
const app = express();
app.use(bodyParser.json());

// --- Initialize WhatsApp Client ---
const client = new Client({
    // Use LocalAuth to save the session locally.
    // The 'dataPath' refers to a folder that we make persistent with Docker.
    authStrategy: new LocalAuth({ dataPath: './wweb_session' }),
    puppeteer: {
        // Essential for running in a Docker container
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }
});

// --- WhatsApp Event Handlers ---

// 1. Generate QR code for the initial login
client.on('qr', qr => {
    console.log("Scan the QR code with your phone:");
    qrcode.generate(qr, { small: true });
});

// 2. Confirmation after successful authentication
client.on('authenticated', () => {
    console.log('✅ Authenticated!');
});

// 3. Client is ready for use
client.on('ready', () => {
    console.log('🚀 WhatsApp Gateway is ready!');
});

// 4. Receive incoming message and forward it to n8n
client.on('message', async message => {
    // Prevent the bot from replying to itself or processing status updates
    if (message.from === 'status@broadcast' || message.author) return;

    console.log(`Message received from ${message.from}: "${message.body}"`);

    try {
        // Forward the relevant data to the n8n webhook
        await axios.post(N8N_WEBHOOK_URL, {
            from: message.from, // e.g., 31612345678@c.us
            text: message.body,
            messageId: message.id._serialized // IMPORTANT: Forward the messageId for replies/reactions
        }, {
            headers: { 'X-API-Key': GATEWAY_API_KEY } // Secure the webhook
        });
    } catch (error) {
        console.error("Error forwarding message to n8n:", error.message);
    }
});

client.initialize();


// ===================================================================================
// --- API Endpoints for n8n ---
// ===================================================================================

/**
 * @description Sends a simple text message.
 * @param {string} to - The chat ID (e.g., 31612345678@c.us)
 * @param {string} text - The message content.
 */
app.post('/send-message', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).send({ status: 'error', message: 'Unauthorized' });
    }

    const { to, text } = req.body;
    if (!to || !text) {
        return res.status(400).send({ status: 'error', message: 'Parameters "to" and "text" are required.' });
    }

    try {
        await client.sendMessage(to, text);
        res.status(200).send({ status: 'success', message: 'Message sent successfully.' });
    } catch (error) {
        console.error("Error sending message:", error.message);
        res.status(500).send({ status: 'error', message: 'Failed to send message.' });
    }
});

/**
 * @description Sends a reply to a specific message.
 * @param {string} messageId - The serialized ID of the message to reply to.
 * @param {string} text - The reply content.
 */
app.post('/reply-to-message', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).send({ status: 'error', message: 'Unauthorized' });
    }

    const { messageId, text } = req.body;
    if (!messageId || !text) {
        return res.status(400).send({ status: 'error', message: 'Parameters "messageId" and "text" are required.' });
    }

    try {
        const messageToReply = await client.getMessageById(messageId);
        if (messageToReply) {
            await messageToReply.reply(text);
            res.status(200).send({ status: 'success', message: 'Reply sent successfully.' });
        } else {
            res.status(404).send({ status: 'error', message: 'Original message not found.' });
        }
    } catch (error) {
        console.error("Error sending reply:", error.message);
        res.status(500).send({ status: 'error', message: 'Failed to send reply.' });
    }
});


/**
 * @description Sends an image from a URL with an optional caption.
 * @param {string} to - The chat ID.
 * @param {string} imageUrl - The public URL of the image to send.
 * @param {string} [caption] - Optional text to send with the image.
 */
app.post('/send-image', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).send({ status: 'error', message: 'Unauthorized' });
    }

    const { to, imageUrl, caption } = req.body;
    if (!to || !imageUrl) {
        return res.status(400).send({ status: 'error', message: '"to" and "imageUrl" are required.' });
    }

    try {
        const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
        await client.sendMessage(to, media, { caption: caption || '' });
        res.status(200).send({ status: 'success', message: 'Image sent successfully.' });
    } catch (error) {
        console.error("Error sending image:", error.message);
        res.status(500).send({ status: 'error', message: 'Failed to send image.' });
    }
});

/**
 * @description Reacts to a specific message with an emoji.
 * @param {string} messageId - The serialized ID of the message to react to.
 * @param {string} emoji - The emoji to react with.
 */
app.post('/react-to-message', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).send({ status: 'error', message: 'Unauthorized' });
    }

    const { messageId, emoji } = req.body;
    if (!messageId || !emoji) {
        return res.status(400).send({ status: 'error', message: '"messageId" and "emoji" are required.' });
    }

    try {
        const messageToReact = await client.getMessageById(messageId);
        if (messageToReact) {
            await messageToReact.react(emoji);
            res.status(200).send({ status: 'success', message: 'Reaction sent.' });
        } else {
            res.status(404).send({ status: 'error', message: 'Original message not found.' });
        }
    } catch (error) {
        console.error("Error sending reaction:", error.message);
        res.status(500).send({ status: 'error', message: 'Failed to send reaction.' });
    }
});

/**
 * @description Sets the chat state to "typing...".
 * @param {string} chatId - The chat ID where the typing state should be shown.
 */
app.post('/set-typing-status', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).send({ status: 'error', message: 'Unauthorized' });
    }

    const { chatId } = req.body;
    if (!chatId) {
        return res.status(400).send({ status: 'error', message: 'Parameter "chatId" is required.' });
    }

    try {
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        res.status(200).send({ status: 'success', message: 'Typing status set.' });
    } catch (error) {
        console.error("Error setting typing state:", error.message);
        res.status(500).send({ status: 'error', message: 'Failed to set typing status.' });
    }
});


// --- Start the Gateway Server ---
app.listen(PORT, () => {
    console.log(`Gateway is listening on port ${PORT}`);
});
