const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const qrcodeLib = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Configuration via Environment Variables ---
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const PORT = process.env.PORT || 3000;
const SESSION_PATH = process.env.SESSION_PATH || './wweb_session';

if (!N8N_WEBHOOK_URL || !GATEWAY_API_KEY) {
    console.error("Error: N8N_WEBHOOK_URL and GATEWAY_API_KEY must be set as environment variables.");
    process.exit(1);
}

// Ensure session directory exists
if (!fs.existsSync(SESSION_PATH)) {
    fs.mkdirSync(SESSION_PATH, { recursive: true });
    console.log(`📁 Created session directory: ${SESSION_PATH}`);
}

// --- Express Setup ---
const app = express();
app.use(bodyParser.json());

// --- QR Code State Management ---
let currentQRCode = null;
let isAuthenticated = false;
let clientReady = false;
let authenticationAttempts = 0;
const MAX_AUTH_ATTEMPTS = 5;

// --- Typing State Management ---
const activeTypingStates = new Map();

function scheduleTypingClear(chatId, duration) {
    if (activeTypingStates.has(chatId)) {
        clearTimeout(activeTypingStates.get(chatId));
    }
    
    const timeoutId = setTimeout(async () => {
        try {
            const chat = await client.getChatById(chatId);
            await chat.clearState();
            activeTypingStates.delete(chatId);
            console.log(`🔇 Cleared typing state for ${chatId}`);
        } catch (error) {
            console.error(`Error clearing typing state for ${chatId}:`, error.message);
        }
    }, duration);
    
    activeTypingStates.set(chatId, timeoutId);
}

function calculateTypingDuration(text, context = {}) {
    const baseSpeed = 40;
    let duration = Math.max(1000, text.length * baseSpeed);
    
    const {
        message_type = 'normal',
        complexity = 'low',
        urgency = 'normal'
    } = context;
    
    switch(message_type) {
        case 'search':
        case 'research':
            duration = Math.max(2500, duration + 1500);
            break;
        case 'quick_response':
        case 'confirmation':
            duration = Math.min(1200, duration * 0.6);
            break;
        case 'complex_analysis':
        case 'detailed_explanation':
            duration = Math.max(3500, duration + 2000);
            break;
        case 'error':
            duration = 800;
            break;
    }
    
    switch(complexity) {
        case 'high':
            duration *= 1.5;
            break;
        case 'medium':
            duration *= 1.2;
            break;
    }
    
    switch(urgency) {
        case 'high':
        case 'urgent':
            duration *= 0.7;
            break;
        case 'low':
            duration *= 1.3;
            break;
    }
    
    return Math.min(6000, Math.max(800, duration));
}

// --- WhatsApp Client Setup ---
const client = new Client({
    authStrategy: new LocalAuth({ 
        dataPath: SESSION_PATH,
        clientId: "whatsapp-gateway"
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-extensions',
            '--no-first-run',
            '--disable-default-apps'
        ],
    }
});

// --- Enhanced WhatsApp Event Handlers ---

client.on('qr', async (qr) => {
    authenticationAttempts++;
    console.log(`\n🔄 QR Code Generated (Attempt ${authenticationAttempts}/${MAX_AUTH_ATTEMPTS})`);
    console.log(`📅 Time: ${new Date().toLocaleString()}`);
    
    // Store current QR for web endpoint
    currentQRCode = qr;
    
    try {
        // Generate terminal QR
        console.log('\n📱 Scan this QR code with your WhatsApp:');
        console.log('=' .repeat(50));
        qrcode.generate(qr, { small: true });
        console.log('=' .repeat(50));
        
        // Also generate QR as image file for debugging
        const qrPath = path.join(__dirname, 'current-qr.png');
        await qrcodeLib.toFile(qrPath, qr);
        console.log(`💾 QR code saved to: ${qrPath}`);
        
        // Show QR as URL too (for containers without terminal)
        console.log(`🌐 QR URL: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
        
    } catch (error) {
        console.error('❌ Error generating QR code:', error.message);
        // Fallback: just show the QR string
        console.log('📝 Raw QR Code:', qr);
    }
    
    if (authenticationAttempts >= MAX_AUTH_ATTEMPTS) {
        console.log(`⚠️  Reached maximum authentication attempts. Check if:`);
        console.log(`   - WhatsApp Web is working in your browser`);
        console.log(`   - No other WhatsApp Web session is active`);
        console.log(`   - Your phone has internet connection`);
        console.log(`   - Try deleting session folder: ${SESSION_PATH}`);
    }
});

client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
});

client.on('authenticated', (session) => {
    console.log('✅ Authentication successful!');
    isAuthenticated = true;
    authenticationAttempts = 0;
    currentQRCode = null;
    
    // Clear any existing QR file
    const qrPath = path.join(__dirname, 'current-qr.png');
    if (fs.existsSync(qrPath)) {
        fs.unlinkSync(qrPath);
        console.log('🗑️  Removed QR code file');
    }
});

client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    isAuthenticated = false;
    currentQRCode = null;
    
    // Clear session and restart
    if (authenticationAttempts >= MAX_AUTH_ATTEMPTS) {
        console.log('🔄 Clearing session and restarting...');
        setTimeout(() => {
            if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
                console.log('🗑️  Session cleared');
            }
            process.exit(1); // Let Docker/PM2 restart the process
        }, 5000);
    }
});

client.on('ready', async () => {
    console.log('🚀 WhatsApp Gateway is ready!');
    clientReady = true;
    
    try {
        const info = client.info;
        console.log(`📱 Connected as: ${info.wid.user}`);
        console.log(`💻 Platform: ${info.platform}`);
        console.log(`🌐 WhatsApp Version: ${info.wa_version}`);
    } catch (error) {
        console.log('ℹ️  Client info not available yet');
    }
    
    // Clear typing states on restart
    activeTypingStates.clear();
});

client.on('disconnected', (reason) => {
    console.log(`💔 Client disconnected: ${reason}`);
    clientReady = false;
    isAuthenticated = false;
    
    // Clear all active typing states
    for (const [chatId, timeoutId] of activeTypingStates) {
        clearTimeout(timeoutId);
    }
    activeTypingStates.clear();
    
    // Restart after disconnect
    console.log('🔄 Attempting to reconnect in 10 seconds...');
    setTimeout(() => {
        client.initialize();
    }, 10000);
});

client.on('message', async message => {
    if (message.from === 'status@broadcast' || message.author) return;

    console.log(`📨 Message received from ${message.from}: "${message.body}"`);

    try {
        await axios.post(N8N_WEBHOOK_URL, {
            from: message.from,
            text: message.body,
            messageId: message.id._serialized,
            timestamp: message.timestamp,
            hasMedia: message.hasMedia,
            type: message.type
        }, {
            headers: { 'X-API-Key': GATEWAY_API_KEY },
            timeout: 10000 // 10 second timeout
        });
        
        console.log(`📤 Message forwarded to n8n successfully`);
    } catch (error) {
        console.error("❌ Error forwarding message to n8n:", error.message);
        if (error.response) {
            console.error("Response status:", error.response.status);
            console.error("Response data:", error.response.data);
        }
    }
});

// Initialize client
console.log('🔧 Initializing WhatsApp client...');
client.initialize();

// ===================================================================================
// --- API ENDPOINTS ---
// ===================================================================================

// QR Code endpoint for web viewing
app.get('/qr', async (req, res) => {
    if (!currentQRCode) {
        return res.status(404).json({
            status: 'error',
            message: isAuthenticated ? 'Already authenticated' : 'No QR code available'
        });
    }
    
    try {
        // Generate QR as SVG for web display
        const qrSvg = await qrcodeLib.toString(currentQRCode, { type: 'svg', width: 300 });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qrSvg);
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to generate QR code',
            error: error.message
        });
    }
});

// QR Code as JSON
app.get('/qr-data', (req, res) => {
    res.json({
        qr_available: !!currentQRCode,
        authenticated: isAuthenticated,
        ready: clientReady,
        attempts: authenticationAttempts,
        qr_url: currentQRCode ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(currentQRCode)}` : null
    });
});

// Enhanced send message with typing
app.post('/send-message', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ 
            status: 'error', 
            message: 'WhatsApp client not ready',
            authenticated: isAuthenticated,
            ready: clientReady
        });
    }

    const { 
        to, 
        text, 
        typing_duration,
        enable_typing = true,
        message_delay = 0,
        message_type = 'normal',
        urgency = 'normal'
    } = req.body;

    if (!to || !text) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to" and "text" are required.' 
        });
    }

    try {
        const startTime = Date.now();
        
        if (enable_typing) {
            const calculatedDuration = typing_duration || calculateTypingDuration(text, {
                message_type,
                urgency,
                complexity: text.length > 200 ? 'high' : text.length > 100 ? 'medium' : 'low'
            });
            
            console.log(`💬 Starting typing for ${calculatedDuration}ms to ${to}`);
            
            const chat = await client.getChatById(to);
            await chat.sendStateTyping();
            
            scheduleTypingClear(to, calculatedDuration);
            await new Promise(resolve => setTimeout(resolve, calculatedDuration));
            
            if (message_delay > 0) {
                await new Promise(resolve => setTimeout(resolve, message_delay));
            }
        }
        
        const message = await client.sendMessage(to, text);
        const totalTime = Date.now() - startTime;
        
        console.log(`✅ Message sent to ${to} in ${totalTime}ms`);
        
        res.json({ 
            status: 'success', 
            message: 'Message sent successfully.',
            messageId: message.id._serialized,
            typing_enabled: enable_typing,
            typing_duration: enable_typing ? (typing_duration || calculateTypingDuration(text)) : 0,
            total_time: totalTime,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error("❌ Error sending message:", error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to send message.',
            error_details: error.message 
        });
    }
});

// Send typing state
app.post('/send-typing', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ 
            status: 'error', 
            message: 'WhatsApp client not ready' 
        });
    }

    const { chatId, duration = 3000, state = 'typing' } = req.body;
    
    if (!chatId) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameter "chatId" is required.' 
        });
    }

    try {
        const chat = await client.getChatById(chatId);
        
        if (state === 'recording') {
            await chat.sendStateRecording();
            console.log(`🎤 Started recording state for ${duration}ms to ${chatId}`);
        } else {
            await chat.sendStateTyping();
            console.log(`💬 Started typing state for ${duration}ms to ${chatId}`);
        }
        
        if (duration > 0) {
            scheduleTypingClear(chatId, duration);
        }
        
        res.json({ 
            status: 'success', 
            message: `${state} state started`,
            chatId: chatId,
            state: state,
            duration: duration,
            will_auto_clear: duration > 0
        });
        
    } catch (error) {
        console.error(`❌ Error setting ${state} state:`, error.message);
        res.status(500).json({ 
            status: 'error', 
            message: `Failed to set ${state} state.`,
            error_details: error.message 
        });
    }
});

// Keep your existing endpoints...
app.post('/reply-to-message', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { messageId, text } = req.body;
    if (!messageId || !text) {
        return res.status(400).json({ status: 'error', message: 'Parameters "messageId" and "text" are required.' });
    }

    try {
        const messageToReply = await client.getMessageById(messageId);
        if (messageToReply) {
            await messageToReply.reply(text);
            res.json({ status: 'success', message: 'Reply sent successfully.' });
        } else {
            res.status(404).json({ status: 'error', message: 'Original message not found.' });
        }
    } catch (error) {
        console.error("❌ Error sending reply:", error.message);
        res.status(500).json({ status: 'error', message: 'Failed to send reply.' });
    }
});

app.post('/send-image', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { to, imageUrl, caption } = req.body;
    if (!to || !imageUrl) {
        return res.status(400).json({ status: 'error', message: '"to" and "imageUrl" are required.' });
    }

    try {
        const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
        await client.sendMessage(to, media, { caption: caption || '' });
        res.json({ status: 'success', message: 'Image sent successfully.' });
    } catch (error) {
        console.error("❌ Error sending image:", error.message);
        res.status(500).json({ status: 'error', message: 'Failed to send image.' });
    }
});

// Health check with detailed status
app.get('/health', (req, res) => {
    res.json({
        status: clientReady ? 'ready' : (isAuthenticated ? 'authenticated' : 'waiting_for_qr'),
        authenticated: isAuthenticated,
        ready: clientReady,
        qr_available: !!currentQRCode,
        auth_attempts: authenticationAttempts,
        active_typing_states: activeTypingStates.size,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Status endpoint with client info
app.get('/status', async (req, res) => {
    try {
        let clientInfo = null;
        if (clientReady && client.info) {
            clientInfo = {
                phone_number: client.info.wid.user,
                platform: client.info.platform,
                wa_version: client.info.wa_version
            };
        }
        
        res.json({
            status: clientReady ? 'connected' : 'disconnected',
            authenticated: isAuthenticated,
            ready: clientReady,
            client_info: clientInfo,
            active_typing_chats: activeTypingStates.size,
            uptime: process.uptime(),
            session_path: SESSION_PATH
        });
    } catch (error) {
        res.json({
            status: 'error',
            error: error.message,
            authenticated: isAuthenticated,
            ready: clientReady,
            active_typing_chats: activeTypingStates.size,
            uptime: process.uptime()
        });
    }
});

// Legacy compatibility
app.post('/set-typing-status', async (req, res) => {
    req.body.duration = 3000;
    req.body.state = 'typing';
    // Forward to new endpoint
    return await app.handle({ ...req, url: '/send-typing', method: 'POST' }, res);
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Enhanced WhatsApp Gateway listening on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 Status: http://localhost:${PORT}/status`);
    console.log(`📱 QR Code: http://localhost:${PORT}/qr (when available)`);
    console.log(`📋 QR Data: http://localhost:${PORT}/qr-data`);
});
