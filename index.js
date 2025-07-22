const { Client, LocalAuth, MessageMedia, Location, Contact, Poll, Buttons, List } = require('whatsapp-web.js');
const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const qrcodeLib = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// --- Configuration via Environment Variables ---
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';  // Bind to all interfaces
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;  // External URL
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

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: (req, file, cb) => {
        // Allow all common media types
        const allowedTypes = [
            // Images
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 
            // Documents  
            'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain', 'text/csv',
            // Audio
            'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm',
            // Video
            'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/webm'
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}`));
        }
    }
});

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

    console.log(`📨 Message received from ${message.from}: "${message.body}" (hasMedia: ${message.hasMedia})`);

    try {
        let payload = {
            from: message.from,
            text: message.body,
            messageId: message.id._serialized,
            timestamp: message.timestamp,
            hasMedia: message.hasMedia,
            type: message.type
        };

        // Add media info if present
        if (message.hasMedia) {
            console.log(`🖼️ Downloading media for message ${message.id._serialized}`);
            try {
                const media = await message.downloadMedia();
                payload.mediaUrl = `data:${media.mimetype};base64,${media.data}`;
                payload.caption = message.body || '';
                payload.filename = media.filename || `media.${media.mimetype.split('/')[1]}`;
                payload.mimeType = media.mimetype;
                payload.mediaSize = media.data ? media.data.length : 0;
                
                console.log(`📎 Media downloaded: ${media.mimetype}, size: ${payload.mediaSize} bytes`);
            } catch (mediaError) {
                console.error('❌ Error downloading media:', mediaError);
                payload.mediaError = mediaError.message;
            }
        }

        await axios.post(N8N_WEBHOOK_URL, payload, {
            headers: { 'X-API-Key': GATEWAY_API_KEY },
            timeout: 30000 // Increased timeout for media downloads
        });
        
        console.log(`📤 Message ${message.hasMedia ? 'with media ' : ''}forwarded to n8n successfully`);
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

    const { 
        to, 
        imageUrl, 
        imageBase64,
        caption = '', 
        enable_typing = true,
        typing_duration = 2500,
        filename
    } = req.body;

    if (!to || (!imageUrl && !imageBase64)) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to" and either "imageUrl" or "imageBase64" are required.' 
        });
    }

    try {
        const startTime = Date.now();
        let media;

        // Show typing with recording state (more appropriate for media)
        if (enable_typing) {
            console.log(`🎥 Starting recording state for ${typing_duration}ms to ${to}`);
            const chat = await client.getChatById(to);
            await chat.sendStateRecording();
            await new Promise(resolve => setTimeout(resolve, typing_duration));
        }

        // Create MessageMedia object
        if (imageBase64) {
            // From base64 data
            const mimeType = imageBase64.includes('data:') ? 
                imageBase64.split(';')[0].split(':')[1] : 'image/jpeg';
            const base64Data = imageBase64.includes('base64,') ? 
                imageBase64.split('base64,')[1] : imageBase64;
            
            media = new MessageMedia(mimeType, base64Data, filename || 'image.jpg');
        } else {
            // From URL
            media = await MessageMedia.fromUrl(imageUrl, { 
                unsafeMime: true,
                filename: filename
            });
        }

        // Send the image
        const message = await client.sendMessage(to, media, { caption: caption });
        const totalTime = Date.now() - startTime;

        console.log(`✅ Image sent to ${to} in ${totalTime}ms`);

        res.json({ 
            status: 'success', 
            message: 'Image sent successfully.',
            messageId: message.id._serialized,
            media_type: media.mimetype,
            total_time: totalTime,
            caption_included: !!caption
        });

    } catch (error) {
        console.error("❌ Error sending image:", error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to send image.',
            error_details: error.message 
        });
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
    const newReq = {
        ...req,
        body: {
            ...req.body,
            duration: 3000,
            state: 'typing'
        }
    };
    
    // Forward to new endpoint logic
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

    const { chatId } = req.body;
    
    if (!chatId) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameter "chatId" is required.' 
        });
    }

    try {
        const chat = await client.getChatById(chatId);
        await chat.sendStateTyping();
        console.log(`💬 Started typing state for 3000ms to ${chatId}`);
        
        scheduleTypingClear(chatId, 3000);
        
        res.json({ 
            status: 'success', 
            message: 'Typing state started',
            chatId: chatId,
            duration: 3000
        });
        
    } catch (error) {
        console.error(`❌ Error setting typing state:`, error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to set typing state.',
            error_details: error.message 
        });
    }
});

/**
 * @description Send document (PDF, Word, Excel, etc.)
 * @param {string} to - Chat ID
 * @param {string} documentUrl - Document URL or base64 data
 * @param {string} filename - Document filename
 * @param {string} [caption] - Document caption
 */
app.post('/send-document', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { 
        to, 
        documentUrl, 
        documentBase64,
        filename,
        caption = '',
        enable_typing = true,
        typing_duration = 3000
    } = req.body;

    if (!to || (!documentUrl && !documentBase64) || !filename) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to", "filename" and either "documentUrl" or "documentBase64" are required.' 
        });
    }

    try {
        const startTime = Date.now();
        let media;

        // Show typing indicator
        if (enable_typing) {
            console.log(`📄 Preparing document for ${to}`);
            const chat = await client.getChatById(to);
            await chat.sendStateTyping();
            await new Promise(resolve => setTimeout(resolve, typing_duration));
        }

        // Create document media
        if (documentBase64) {
            // Determine MIME type from filename
            const ext = path.extname(filename).toLowerCase();
            const mimeTypes = {
                '.pdf': 'application/pdf',
                '.doc': 'application/msword',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                '.xls': 'application/vnd.ms-excel',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                '.ppt': 'application/vnd.ms-powerpoint',
                '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                '.txt': 'text/plain',
                '.csv': 'text/csv'
            };
            
            const mimeType = mimeTypes[ext] || 'application/octet-stream';
            const base64Data = documentBase64.includes('base64,') ? 
                documentBase64.split('base64,')[1] : documentBase64;
            
            media = new MessageMedia(mimeType, base64Data, filename);
        } else {
            // From URL
            media = await MessageMedia.fromUrl(documentUrl, { 
                unsafeMime: true,
                filename: filename
            });
        }

        // Send the document
        const message = await client.sendMessage(to, media, { 
            caption: caption,
            sendMediaAsDocument: true  // Force as document, not inline
        });
        
        const totalTime = Date.now() - startTime;
        console.log(`✅ Document "${filename}" sent to ${to} in ${totalTime}ms`);

        res.json({ 
            status: 'success', 
            message: 'Document sent successfully.',
            messageId: message.id._serialized,
            filename: filename,
            media_type: media.mimetype,
            total_time: totalTime
        });

    } catch (error) {
        console.error("❌ Error sending document:", error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to send document.',
            error_details: error.message 
        });
    }
});

/**
 * @description Send audio message (voice note or audio file)
 * @param {string} to - Chat ID  
 * @param {string} audioUrl - Audio URL or base64 data
 * @param {boolean} [as_voice_note=false] - Send as voice note (PTT)
 */
app.post('/send-audio', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { 
        to, 
        audioUrl, 
        audioBase64,
        as_voice_note = false,
        filename = 'audio.mp3',
        enable_typing = true
    } = req.body;

    if (!to || (!audioUrl && !audioBase64)) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to" and either "audioUrl" or "audioBase64" are required.' 
        });
    }

    try {
        const startTime = Date.now();
        let media;

        // Show recording state for audio
        if (enable_typing) {
            console.log(`🎤 Preparing audio for ${to}`);
            const chat = await client.getChatById(to);
            await chat.sendStateRecording();
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Create audio media
        if (audioBase64) {
            const mimeType = as_voice_note ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
            const base64Data = audioBase64.includes('base64,') ? 
                audioBase64.split('base64,')[1] : audioBase64;
            
            media = new MessageMedia(mimeType, base64Data, filename);
        } else {
            media = await MessageMedia.fromUrl(audioUrl, { 
                unsafeMime: true,
                filename: filename
            });
        }

        // Send audio
        const message = await client.sendMessage(to, media, { 
            sendAudioAsVoice: as_voice_note  // PTT voice note
        });
        
        const totalTime = Date.now() - startTime;
        console.log(`✅ Audio sent to ${to} as ${as_voice_note ? 'voice note' : 'audio file'} in ${totalTime}ms`);

        res.json({ 
            status: 'success', 
            message: `Audio sent successfully as ${as_voice_note ? 'voice note' : 'audio file'}.`,
            messageId: message.id._serialized,
            audio_type: as_voice_note ? 'voice_note' : 'audio_file',
            total_time: totalTime
        });

    } catch (error) {
        console.error("❌ Error sending audio:", error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to send audio.',
            error_details: error.message 
        });
    }
});

/**
 * @description Send video message
 * @param {string} to - Chat ID
 * @param {string} videoUrl - Video URL or base64 data
 * @param {string} [caption] - Video caption
 */
app.post('/send-video', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { 
        to, 
        videoUrl, 
        videoBase64,
        caption = '',
        filename = 'video.mp4',
        enable_typing = true
    } = req.body;

    if (!to || (!videoUrl && !videoBase64)) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to" and either "videoUrl" or "videoBase64" are required.' 
        });
    }

    try {
        const startTime = Date.now();
        let media;

        // Show recording state for video
        if (enable_typing) {
            console.log(`🎬 Preparing video for ${to}`);
            const chat = await client.getChatById(to);
            await chat.sendStateRecording();
            await new Promise(resolve => setTimeout(resolve, 3000)); // Videos take longer
        }

        // Create video media
        if (videoBase64) {
            const mimeType = 'video/mp4';
            const base64Data = videoBase64.includes('base64,') ? 
                videoBase64.split('base64,')[1] : videoBase64;
            
            media = new MessageMedia(mimeType, base64Data, filename);
        } else {
            media = await MessageMedia.fromUrl(videoUrl, { 
                unsafeMime: true,
                filename: filename
            });
        }

        // Send video
        const message = await client.sendMessage(to, media, { caption: caption });
        
        const totalTime = Date.now() - startTime;
        console.log(`✅ Video sent to ${to} in ${totalTime}ms`);

        res.json({ 
            status: 'success', 
            message: 'Video sent successfully.',
            messageId: message.id._serialized,
            total_time: totalTime,
            caption_included: !!caption
        });

    } catch (error) {
        console.error("❌ Error sending video:", error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to send video.',
            error_details: error.message 
        });
    }
});

/**
 * @description Upload and send file (multipart form upload)
 * @param {File} file - File to upload
 * @param {string} to - Chat ID
 * @param {string} [caption] - File caption
 * @param {boolean} [as_document=false] - Force send as document
 */
app.post('/upload-and-send', upload.single('file'), async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { to, caption = '', as_document = false } = req.body;
    
    if (!to || !req.file) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to" and file upload are required.' 
        });
    }

    try {
        const startTime = Date.now();
        const filePath = req.file.path;
        const filename = req.file.originalname;
        const mimeType = req.file.mimetype;

        console.log(`📤 Uploading ${filename} (${mimeType}) to ${to}`);

        // Show appropriate typing state
        const chat = await client.getChatById(to);
        if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
            await chat.sendStateRecording();
        } else {
            await chat.sendStateTyping();
        }
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Create media from uploaded file
        const media = MessageMedia.fromFilePath(filePath);
        media.filename = filename;

        // Send with appropriate options
        const options = { caption: caption };
        if (as_document || mimeType.startsWith('application/')) {
            options.sendMediaAsDocument = true;
        }

        const message = await client.sendMessage(to, media, options);
        
        // Cleanup uploaded file
        fs.unlink(filePath, (err) => {
            if (err) console.error('Error deleting uploaded file:', err);
        });

        const totalTime = Date.now() - startTime;
        console.log(`✅ File "${filename}" sent to ${to} in ${totalTime}ms`);

        res.json({ 
            status: 'success', 
            message: 'File uploaded and sent successfully.',
            messageId: message.id._serialized,
            filename: filename,
            file_size: req.file.size,
            mime_type: mimeType,
            sent_as_document: as_document,
            total_time: totalTime
        });

    } catch (error) {
        console.error("❌ Error uploading and sending file:", error.message);
        
        // Cleanup uploaded file on error
        if (req.file && req.file.path) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Error deleting uploaded file:', err);
            });
        }

        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to upload and send file.',
            error_details: error.message 
        });
    }
});

/**
 * @description Send location
 * @param {string} to - Chat ID
 * @param {number} latitude - Location latitude
 * @param {number} longitude - Location longitude
 * @param {string} [name] - Location name
 * @param {string} [address] - Location address
 */
app.post('/send-location', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { to, latitude, longitude, name, address } = req.body;

    if (!to || typeof latitude !== 'number' || typeof longitude !== 'number') {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to", "latitude" and "longitude" are required.' 
        });
    }

    try {
        const location = new Location(latitude, longitude, name, address);
        const message = await client.sendMessage(to, location);

        console.log(`📍 Location sent to ${to}: ${latitude}, ${longitude}`);

        res.json({ 
            status: 'success', 
            message: 'Location sent successfully.',
            messageId: message.id._serialized,
            coordinates: { latitude, longitude },
            name: name || null,
            address: address || null
        });

    } catch (error) {
        console.error("❌ Error sending location:", error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to send location.',
            error_details: error.message 
        });
    }
});

/**
 * @description Send contact card
 * @param {string} to - Chat ID
 * @param {Object} contact - Contact information
 */
app.post('/send-contact', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== GATEWAY_API_KEY) {
        return res.status(401).json({ status: 'error', message: 'Unauthorized' });
    }

    if (!clientReady) {
        return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready' });
    }

    const { to, contact } = req.body;

    if (!to || !contact || !contact.name || !contact.number) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameters "to" and contact object with "name" and "number" are required.' 
        });
    }

    try {
        // Create vCard format
        const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${contact.name}
TEL:${contact.number}
${contact.email ? `EMAIL:${contact.email}` : ''}
${contact.organization ? `ORG:${contact.organization}` : ''}
${contact.url ? `URL:${contact.url}` : ''}
END:VCARD`;

        const contactCard = new Contact(vcard);
        const message = await client.sendMessage(to, contactCard);

        console.log(`👤 Contact "${contact.name}" sent to ${to}`);

        res.json({ 
            status: 'success', 
            message: 'Contact sent successfully.',
            messageId: message.id._serialized,
            contact_name: contact.name
        });

    } catch (error) {
        console.error("❌ Error sending contact:", error.message);
        res.status(500).json({ 
            status: 'error', 
            message: 'Failed to send contact.',
            error_details: error.message 
        });
    }
});

// Media info endpoint
app.get('/media-info', (req, res) => {
    res.json({
        supported_formats: {
            images: ['JPEG', 'PNG', 'GIF', 'WebP'],
            documents: ['PDF', 'DOC', 'DOCX', 'XLS', 'XLSX', 'PPT', 'PPTX', 'TXT', 'CSV'],
            audio: ['MP3', 'MP4', 'WAV', 'OGG', 'WebM'],
            video: ['MP4', 'MOV', 'AVI', 'WebM']
        },
        size_limits: {
            images: '16 MB',
            documents: '100 MB', 
            audio: '16 MB',
            video: '16 MB'
        },
        special_features: {
            voice_notes: 'Send audio as PTT voice note',
            location: 'Send GPS coordinates with optional name/address',
            contacts: 'Send vCard contact information',
            typing_states: 'Show typing/recording indicators before sending'
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Enhanced WhatsApp Gateway listening on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 Status: http://localhost:${PORT}/status`);
    console.log(`📱 QR Code: http://localhost:${PORT}/qr (when available)`);
    console.log(`📋 QR Data: http://localhost:${PORT}/qr-data`);
    console.log('📎 Enhanced media endpoints loaded:');
    console.log('  📷 POST /send-image - Send images with captions');
    console.log('  📄 POST /send-document - Send PDF, Office docs, etc.');
    console.log('  🎵 POST /send-audio - Send audio files or voice notes');
    console.log('  🎬 POST /send-video - Send video files with captions');
    console.log('  📤 POST /upload-and-send - Upload file via form');
    console.log('  📍 POST /send-location - Send GPS location');
    console.log('  👤 POST /send-contact - Send contact card');
    console.log('  ℹ️  GET /media-info - Media format information');
});
