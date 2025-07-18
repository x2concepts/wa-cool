const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './session'
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

// Functie om berichten naar n8n AI agent te sturen
async function sendToAIAgent(messageData) {
    try {
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(messageData)
        });
        
        if (response.ok) {
            const result = await response.json();
            console.log('✅ Bericht verwerkt door AI agent');
            return result;
        } else {
            console.error('❌ AI agent error:', response.status, response.statusText);
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
        displayNumber: `+${cleanNumber.replace(/(\d{2})(\d{3})(\d{3})(\d{3})/, '$1 $2 $3 $4')}`
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
});

client.on('message', async msg => {
    // Negeer berichten van jezelf
    if (msg.fromMe) return;
    
    // Negeer groepsberichten (optioneel)
    if (msg.from.includes('@g.us')) {
        console.log('⚠️ Groepsbericht genegeerd');
        return;
    }
    
    // ALLEEN berichten die beginnen met ! worden doorgestuurd
    if (!msg.body.startsWith('!')) {
        console.log(`📝 Normaal bericht genegeerd: "${msg.body.substring(0, 20)}..."`);
        return;
    }
    
    const contact = parseContact(msg.from);
    const timestamp = new Date().toISOString();
    
    console.log('⚡ COMMAND BERICHT ONTVANGEN');
    console.log('Van:', contact.displayNumber);
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
            mode: 'AI Agent Mode - ! commands only',
            endpoints: {
                health: '/health',
                sendMessage: '/send-message'
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
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
});

client.initialize();
