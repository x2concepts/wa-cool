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
    // Negeer berichten van jezelf
    if (msg.fromMe) return;
    
    // Alleen berichten die beginnen met ! worden geregistreerd en verwerkt
    if (msg.body.startsWith('!')) {
        console.log('=== COMMAND ONTVANGEN ===');
        console.log('Van:', msg.from);
        console.log('Command:', msg.body);
        console.log('Tijd:', new Date().toLocaleString('nl-NL'));
        console.log('========================');
        
        // Verwerk de verschillende commands
        if (msg.body === '!ping') {
            console.log('Ping command → verstuur pong');
            msg.reply('pong');
        }
        else if (msg.body === '!info') {
            console.log('Info command → verstuur status');
            msg.reply('WhatsApp bot is actief!');
        }
        else if (msg.body === '!tijd') {
            console.log('Tijd command → verstuur huidige tijd');
            msg.reply(`Het is nu: ${new Date().toLocaleString('nl-NL')}`);
        }
        else if (msg.body === '!help') {
            console.log('Help command → verstuur help tekst');
            msg.reply('Beschikbare commands:\n!ping - Test de bot\n!info - Bot status\n!tijd - Huidige tijd\n!help - Deze hulp');
        }
        else {
            console.log('Onbekend command:', msg.body);
            msg.reply('Onbekend command. Typ !help voor beschikbare commands.');
        }
    }
    // Normale berichten (zonder !) worden volledig genegeerd - geen logging
});

client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
});

// Health check server
const http = require('http');
const PORT = process.env.PORT || 3000;

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
