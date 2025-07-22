// Enhanced WhatsApp service met typing support
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const app = express();

app.use(express.json());

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let isReady = false;

client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    isReady = true;
});

client.on('disconnected', (reason) => {
    console.log('Client was disconnected', reason);
    isReady = false;
});

// Enhanced send message endpoint met typing support
app.post('/send-message', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(503).json({ 
                error: 'WhatsApp client not ready',
                status: 'not_ready' 
            });
        }

        const { 
            to, 
            text, 
            typing_duration = 2000,  // Default 2 seconden typing
            enable_typing = true,
            message_delay = 0        // Extra delay na typing
        } = req.body;

        if (!to || !text) {
            return res.status(400).json({ 
                error: 'Missing required fields: to, text' 
            });
        }

        // Format number voor WhatsApp
        let chatId = to;
        if (!to.includes('@')) {
            chatId = to + '@c.us';
        }

        console.log(`Sending message to ${chatId}: ${text}`);

        // Get chat object
        const chat = await client.getChatById(chatId);
        
        if (!chat) {
            return res.status(404).json({ 
                error: 'Chat not found',
                chatId: chatId
            });
        }

        let typingPromise = null;

        // Start typing indicator als enabled
        if (enable_typing && typing_duration > 0) {
            console.log(`Starting typing indicator for ${typing_duration}ms`);
            
            // Send typing state
            await chat.sendStateTyping();
            
            // Create promise dat na X tijd stopt
            typingPromise = new Promise(resolve => {
                setTimeout(() => {
                    console.log('Typing duration completed');
                    resolve();
                }, typing_duration);
            });

            // Wait for typing duration
            await typingPromise;
        }

        // Extra delay na typing (voor realisme)
        if (message_delay > 0) {
            await new Promise(resolve => setTimeout(resolve, message_delay));
        }

        // Send actual message
        const message = await chat.sendMessage(text);
        
        console.log('Message sent successfully:', message.id._serialized);

        res.json({ 
            success: true,
            messageId: message.id._serialized,
            chatId: chatId,
            typing_used: enable_typing,
            typing_duration: enable_typing ? typing_duration : 0,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error sending message:', error);
        
        res.status(500).json({ 
            error: 'Failed to send message',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Endpoint voor alleen typing indicator (zonder bericht)
app.post('/send-typing', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(503).json({ 
                error: 'WhatsApp client not ready' 
            });
        }

        const { to, duration = 3000, state = 'typing' } = req.body;

        if (!to) {
            return res.status(400).json({ 
                error: 'Missing required field: to' 
            });
        }

        let chatId = to;
        if (!to.includes('@')) {
            chatId = to + '@c.us';
        }

        const chat = await client.getChatById(chatId);

        if (!chat) {
            return res.status(404).json({ 
                error: 'Chat not found' 
            });
        }

        // Choose state type
        if (state === 'recording') {
            await chat.sendStateRecording();
        } else {
            await chat.sendStateTyping();
        }

        console.log(`Sent ${state} state for ${duration}ms to ${chatId}`);

        // Auto-clear na duration
        if (duration > 0) {
            setTimeout(async () => {
                try {
                    await chat.clearState();
                    console.log(`Cleared ${state} state for ${chatId}`);
                } catch (err) {
                    console.error('Error clearing state:', err.message);
                }
            }, duration);
        }

        res.json({ 
            success: true,
            chatId: chatId,
            state: state,
            duration: duration,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error sending typing state:', error);
        res.status(500).json({ 
            error: 'Failed to send typing state',
            details: error.message 
        });
    }
});

// Bulk send met typing indicators
app.post('/send-bulk-messages', async (req, res) => {
    try {
        if (!isReady) {
            return res.status(503).json({ 
                error: 'WhatsApp client not ready' 
            });
        }

        const { 
            messages, 
            delay_between = 3000,     // Delay tussen berichten
            typing_duration = 2000,   // Typing duration per bericht
            enable_typing = true 
        } = req.body;

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ 
                error: 'Messages must be a non-empty array' 
            });
        }

        const results = [];

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            
            if (!msg.to || !msg.text) {
                results.push({
                    index: i,
                    error: 'Missing to or text field',
                    success: false
                });
                continue;
            }

            try {
                let chatId = msg.to;
                if (!msg.to.includes('@')) {
                    chatId = msg.to + '@c.us';
                }

                const chat = await client.getChatById(chatId);

                // Typing indicator
                if (enable_typing) {
                    await chat.sendStateTyping();
                    await new Promise(resolve => 
                        setTimeout(resolve, typing_duration)
                    );
                }

                // Send message
                const message = await chat.sendMessage(msg.text);

                results.push({
                    index: i,
                    success: true,
                    messageId: message.id._serialized,
                    chatId: chatId
                });

                console.log(`Bulk message ${i + 1}/${messages.length} sent to ${chatId}`);

                // Delay tussen berichten (behalve laatste)
                if (i < messages.length - 1 && delay_between > 0) {
                    await new Promise(resolve => 
                        setTimeout(resolve, delay_between)
                    );
                }

            } catch (error) {
                results.push({
                    index: i,
                    success: false,
                    error: error.message,
                    chatId: msg.to
                });
            }
        }

        const successCount = results.filter(r => r.success).length;
        
        res.json({
            success: true,
            total_messages: messages.length,
            successful: successCount,
            failed: messages.length - successCount,
            results: results,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error in bulk send:', error);
        res.status(500).json({ 
            error: 'Bulk send failed',
            details: error.message 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: isReady ? 'ready' : 'not_ready',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WhatsApp service running on port ${PORT}`);
});

client.initialize();
