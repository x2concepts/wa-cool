const { Client, LocalAuth } = require('whatsapp-web.js');
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
            from: message.from, // e.g., 447123456789@c.us
            text: message.body
        }, {
            headers: { 'X-API-Key': GATEWAY_API_KEY } // Secure the webhook
        });
    } catch (error) {
        console.error("Error forwarding message to n8n:", error.message);
    }
});

client.initialize();


// --- API Endpoint for n8n to send messages ---
app.post('/send-message', async (req, res) => {
    // Secure the endpoint with the same API key
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

app.listen(PORT, () => {
    console.log(`Gateway is listening on port ${PORT}`);
});
