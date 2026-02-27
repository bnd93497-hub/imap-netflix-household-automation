import 'dotenv/config';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import http from 'http';

// --- PHONEBOOK: MATCH NETFLIX PROFILE NAMES TO WHATSAPP NUMBERS ---
// Write the names exactly as they appear in the Netflix emails.
// Numbers must be: 961 + Number + @s.whatsapp.net (No spaces, no plus sign)
const customerPhonebook: { [key: string]: string } = {
    "Ahmed": "96181123343@s.whatsapp.net",
    "Dad": "9613000000@s.whatsapp.net",
    // Add more customers here...
};

// --- WHATSAPP SETUP ---
let waSocket: any = null;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('whatsapp_auth');
    const { version } = await fetchLatestBaileysVersion();
    
    waSocket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['Windows', 'Chrome', '120.0.0']
    });

    waSocket.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('📱 SCAN THE LINK BELOW FOR A CLEAN QR CODE 📱');
            // This creates a clickable link that opens a perfect QR image
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            console.log('👉 CLICK HERE:', qrUrl);
            
            // Keeps the terminal version just in case
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'open') {
            console.log('✅ WHATSAPP IS ONLINE AND READY TO SEND LINKS!');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            if (shouldReconnect) startWhatsApp();
        }
    });
    
    waSocket.ev.on('creds.update', saveCreds);
}

// --- EMAIL SETUP ---
const imap = new Imap({
    user: process.env.IMAP_USER as string,
    password: process.env.IMAP_PASSWORD as string,
    host: process.env.IMAP_HOST as string,
    port: parseInt(process.env.IMAP_PORT as string, 10),
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
});

function extractNetflixLink(text: string): string | null {
    const match = text.match(/https:\/\/netflix\.com\/[^\s"'>]+/i);
    return match ? match[0] : null;
}

function extractProfileName(text: string): string | null {
    const match = text.match(/(?:Hi|Hello)\s+([A-Za-z]+)/i);
    return match ? match[1] : null;
}

function openInbox(cb: any) {
    imap.openBox('INBOX', false, cb);
}

imap.once('ready', function() {
    console.log('✅ GMAIL LISTENER IS ONLINE!');
    openInbox(function(err: any, box: any) {
        if (err) throw err;
        
        imap.on('mail', function(numNewMsgs: number) {
            console.log(`📧 Detected ${numNewMsgs} new email(s).`);
            const fetch = imap.seq.fetch(box.messages.total + ':*', { bodies: '' });
            
            fetch.on('message', function(msg: any) {
                msg.on('body', function(stream: any) {
                    simpleParser(stream, async (err: any, parsed: any) => {
                        if (parsed.from?.text.includes('netflix.com')) {
                            const emailText = parsed.text || '';
                            const link = extractNetflixLink(emailText);
                            const profileName = extractProfileName(emailText);

                            console.log(`🔥 Netflix Update Email Found for profile: ${profileName}`);

                            if (link && profileName && waSocket) {
                                const customerNumber = customerPhonebook[profileName];
                                
                                if (customerNumber) {
                                    const message = `Hey ${profileName}, Netflix needs an update for your TV! Click here from your phone while on your home WiFi: ${link}`;
                                    
                                    try {
                                        await waSocket.sendMessage(customerNumber, { text: message });
                                        console.log(`✅ LINK SENT VIA WHATSAPP TO ${profileName} (${customerNumber})`);
                                    } catch (e) {
                                        console.log(`❌ Failed to send WhatsApp message:`, e);
                                    }
                                } else {
                                    console.log(`⚠️ Profile '${profileName}' not found in the phonebook code.`);
                                }
                            }
                        }
                    });
                });
            });
        });
    });
});

imap.once('error', function(err: any) {
    console.log('❌ IMAP Error:', err);
});

// --- START EVERYTHING ---
startWhatsApp();
imap.connect();

// Dummy server to keep Render awake
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Netflix Bot is running\n');
}).listen(process.env.PORT || 3000, () => {
    console.log('✅ DUMMY SERVER ONLINE');
});
