const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: process.env.SESSION_PATH || './session'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// n8n webhook URL - dit wordt je eigen n8n instantie
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://your-n8n.com/webhook/whatsapp-ai-agent';
const N8N_AUTH_HEADER = process.env.N8N_AUTH_HEADER || '';
const N8N_AUTH_VALUE = process.env.N8N_AUTH_VALUE || '';

// Functie om berichten naar n8n AI agent te sturen
async function sendToAIAgent(messageData) {
    try {
        // Prepare headers
        const headers = {
            'Content-Type': 'application/json',
        };
        
        // Add n8n authentication if configured
        if (N8N_AUTH_HEADER && N8N_AUTH_VALUE) {
            headers[N8N_AUTH_HEADER] = N8N_AUTH_VALUE;
            console.log(`🔑 Adding n8n auth: ${N8N_AUTH_HEADER}`);
        }
        
        console.log('📤 Sending to n8n:', JSON.stringify(messageData, null, 2));
        console.log('🌐 Headers:', JSON.stringify(headers, null, 2));
        
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(messageData)
        });
        
        console.log('📥 Response status:', response.status);
        console.log('📥 Response headers:', Object.fromEntries(response.headers.entries()));
        
        if (response.ok) {
            const result = await response.json();
            console.log('✅ Bericht verwerkt door AI agent');
            console.log('📥 Response data:', JSON.stringify(result, null, 2));
            return result;
        } else {
            const errorText = await response.text();
            console.error('❌ AI agent error:', response.status, response.statusText);
            console.error('❌ Error body:', errorText);
            return null;
        }
    } catch (error) {
        console.error('❌ AI agent fout:', error.message);
        return null;
    }
}

// Functie om contact info te extraheren
function parseContact(from) {
    const isGroup = from.includes('@g.us');
    const cleanNumber = from.split('@')[0];
    
    return {
        phoneNumber: cleanNumber,
        isGroup: isGroup,
        contactId: from,
        displayNumber: isGroup ? `Groep: ${cleanNumber}` : `+${cleanNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')}`
    };
}

// Functie om berichten te versturen (wordt aangeroepen door n8n)
async function sendWhatsAppMessage(phoneNumber, message) {
    try {
        const chatId = `${phoneNumber}@c.us`;
        await client.sendMessage(chatId, message);
        console.log(`✅ Bericht succesvol verzonden naar ${phoneNumber}`);
        return true;
    } catch (error) {
        console.error(`❌ Fout bij verzenden naar ${phoneNumber}:`, error.message);
        return false;
    }
}

client.on('qr', (qr) => {
    console.log('🔗 QR Code ontvangen, scan met WhatsApp:');
    qrcode.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('✅ WhatsApp AI Agent is klaar!');
    console.log('🤖 AI Agent webhook:', N8N_WEBHOOK_URL);
    console.log('⚡ Alleen berichten die beginnen met ! worden doorgestuurd');
    console.log('📱 Groepsberichten met ! commands zijn toegestaan');
});

client.on('message', async msg => {
    // Negeer berichten van jezelf
    if (msg.fromMe) return;
    
    // ALLEEN berichten die beginnen met ! worden doorgestuurd
    if (!msg.body.startsWith('!')) {
        console.log(`📝 Normaal bericht genegeerd: "${msg.body.substring(0, 20)}..."`);
        return;
    }
    
    const contact = parseContact(msg.from);
    const timestamp = new Date().toISOString();
    
    console.log('⚡ COMMAND BERICHT ONTVANGEN');
    console.log('Van:', contact.displayNumber);
    console.log('Type:', contact.isGroup ? 'Groepsbericht' : 'Privébericht');
    console.log('Command:', msg.body);
    console.log('Tijd:', new Date().toLocaleString('nl-NL'));
    console.log('→ Doorsturen naar AI agent...');
    
    // Bereid data voor AI agent voor
    const messageData = {
        message: msg.body,
        command: msg.body,
        contact: contact,
        timestamp: timestamp,
        messageId: msg.id,
        messageType: msg.type,
        source: 'whatsapp-ai-agent',
        isCommand: true
    };
    
    // Verstuur naar AI agent in n8n
    const aiResponse = await sendToAIAgent(messageData);
    
    // n8n zal zelf berichten terugsturen via onze /send-message endpoint
    if (aiResponse) {
        console.log('✅ AI agent heeft bericht verwerkt');
    } else {
        console.log('❌ AI agent kon bericht niet verwerken');
        // Fallback bericht
        try {
            await msg.reply('Sorry, er ging iets mis. Probeer het later opnieuw.');
        } catch (error) {
            console.error('❌ Fout bij fallback bericht:', error.message);
        }
    }
});

// Security configuration
const SECURITY_ENABLED = process.env.SECURITY_ENABLED === 'true';
const API_KEY = process.env.API_KEY;
const ALLOWED_IPS = process.env.ALLOWED_IPS ? process.env.ALLOWED_IPS.split(',').map(ip => ip.trim()) : [];

// Security middleware functions
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

function isIPAllowed(clientIP) {
    if (!SECURITY_ENABLED || ALLOWED_IPS.length === 0) return true;
    
    // Remove IPv6 prefix if present
    const cleanIP = clientIP?.replace(/^::ffff:/, '');
    return ALLOWED_IPS.includes(cleanIP) || ALLOWED_IPS.includes('127.0.0.1');
}

function isAPIKeyValid(req) {
    if (!SECURITY_ENABLED || !API_KEY) return true;
    
    const providedKey = req.headers['x-api-key'];
    return providedKey === API_KEY;
}

function validateSecurity(req, res) {
    const clientIP = getClientIP(req);
    
    // Check IP whitelist
    if (!isIPAllowed(clientIP)) {
        console.log(`🚫 IP blocked: ${clientIP}`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'IP not allowed' }));
        return false;
    }
    
    // Check API key
    if (!isAPIKeyValid(req)) {
        console.log(`🔑 Invalid API key from IP: ${clientIP}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing API key' }));
        return false;
    }
    
    return true;
}

// HTTP server voor n8n om berichten terug te sturen
const http = require('http');
const url = require('url');
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    if (req.method === 'POST' && parsedUrl.pathname === '/send-message') {
        // Validate security for protected endpoint
        if (!validateSecurity(req, res)) return;
        
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const { phoneNumber, message } = JSON.parse(body);
                
                console.log(`📤 n8n wil bericht sturen naar ${phoneNumber}:`, message);
                
                const success = await sendWhatsAppMessage(phoneNumber, message);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success, 
                    timestamp: new Date().toISOString(),
                    phoneNumber: phoneNumber
                }));
                
            } catch (error) {
                console.error('❌ Fout bij /send-message:', error.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    }
    else if (req.method === 'GET' && parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            aiAgent: N8N_WEBHOOK_URL,
            mode: 'AI Agent Mode - ! commands only (Groups enabled)',
            security: {
                enabled: SECURITY_ENABLED,
                ipWhitelist: SECURITY_ENABLED ? ALLOWED_IPS.length > 0 : false,
                apiKey: SECURITY_ENABLED ? !!API_KEY : false
            },
            endpoints: {
                health: '/health',
                sendMessage: '/send-message (protected)'
            }
        }));
    }
    else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint not found' }));
    }
});

server.listen(PORT, () => {
    console.log(`🚀 WhatsApp AI Agent server draait op poort ${PORT}`);
    console.log(`📡 n8n kan berichten sturen naar: https://wa.theagentfactory.nl/send-message`);
    console.log(`🔧 Health check: https://wa.theagentfactory.nl/health`);
    
    // Security status logging
    if (SECURITY_ENABLED) {
        console.log(`🔒 Security ENABLED`);
        console.log(`🔑 API Key: ${API_KEY ? 'Configured' : 'Missing'}`);
        console.log(`🌐 Allowed IPs: ${ALLOWED_IPS.length > 0 ? ALLOWED_IPS.join(', ') : 'None configured'}`);
    } else {
        console.log(`⚠️  Security DISABLED - Set SECURITY_ENABLED=true to enable`);
    }
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
});

client.initialize();
