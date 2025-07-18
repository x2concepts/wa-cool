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

client.on('qr', (qr) => {
    console.log('QR Code ontvangen, scan met WhatsApp:');
    qrcode.generate(qr, {small: true});
});

client.on('ready', () => {
    console.log('WhatsApp client is klaar!');
});

client.on('message', msg => {
    console.log('Bericht ontvangen:', msg.body);
    
    if (msg.body == '!ping') {
        msg.reply('pong');
    }
    
    if (msg.body == '!info') {
        msg.reply('WhatsApp bot is actief!');
    }
});

client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
});

const PORT = process.env.PORT || 3000;

// Eenvoudige health check endpoint
const http = require('http');
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
});

client.initialize();