import 'dotenv/config';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import http from 'http';

// --- PHONEBOOK: MATCH NAMES TO NUMBERS ---
const customerPhonebook: { [key: string]: string } = {
    "Maguy": "961XXXXXXXX@s.whatsapp.net", 
    "Ahmed": "96181123343@s.whatsapp.net", 
    // Add more customers here...
};

// --- WHATSAPP SETUP ---
let waSocket: any = null;
async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('whatsapp_auth');
    const { version } = await fetchLatestBaileysVersion();
    waSocket = makeWASocket({ version, auth: state, printQRInTerminal: false, browser: ['Windows', 'Chrome', '120.0.0'] });
    waSocket.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('🔗 CLEAN QR LINK:', `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`);
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') console.log('✅ WHATSAPP ONLINE');
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) startWhatsApp();
    });
    waSocket.ev.on('creds.update', saveCreds);
}

// --- EXTRACTION LOGIC ---
function extractProfileName(text: string): string | null {
    const match = text.match(/Hi\s+([A-Za-z]+),?/i);
    return match ? match[1] : null;
}

function extractNetflixLink(text: string): string | null {
    // Grabs any Netflix URL (Travel, Update, or Verify)
    const match = text.match(/https:\/\/(www\.)?netflix\.com\/[^\s"'>]+/i);
    return match ? match[0] : null;
}

// --- EMAIL SCANNER ---
const imap = new Imap({
    user: process.env.IMAP_USER as string,
    password: process.env.IMAP_PASSWORD as string,
    host: process.env.IMAP_HOST as string,
    port: parseInt(process.env.IMAP_PORT as string, 10),
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
});

imap.once('ready', () => {
    console.log('✅ GMAIL LISTENER ONLINE');
    imap.openBox('INBOX', false, (err, box) => {
        imap.on('mail', () => {
            const fetch = imap.seq.fetch(box.messages.total + ':*', { bodies: '' });
            fetch.on('message', (msg) => {
                msg.on('body', (stream) => {
                    simpleParser(stream, async (err: any, parsed: any) => {
                        if (parsed.text?.includes('netflix.com')) {
                            const link = extractNetflixLink(parsed.text || '');
                            const name = extractProfileName(parsed.text || '');
                            
                            if (link && waSocket) {
    const target = (name ? customerPhonebook[name] : null) || "96181123343@s.whatsapp.net";
    
    let message = "";
    const subject = parsed.subject?.toLowerCase() || "";
    const body = parsed.text?.toLowerCase() || "";

    // 1. Check if it's a LOGIN CODE email
    if (subject.includes("code") || body.includes("temporary access code")) {
        message = `🔢 *Netflix Login Code*\n\nHi *${name || 'there'}*,\n\nHere is your requested login code. Please click the link to view it:\n\n🔗 ${link}`;
    } 
    // 2. Otherwise, treat it as a HOUSEHOLD UPDATE
    else {
        message = `📺 *Netflix Household Update*\n\nHi *${name || 'there'}*,\n\nNetflix needs to verify your TV household. Click the link below while on home WiFi:\n\n🔗 ${link}`;
    }

    try {
        await waSocket.sendMessage(target, { text: message });
        console.log(`✅ CORRECT TEMPLATE SENT TO: ${target}`);
    } catch (e) { console.log(`❌ Error:`, e); }
}
                        }
                    });
                });
            });
        });
    });
});

startWhatsApp();
imap.connect();

http.createServer((req, res) => { res.writeHead(200); res.end('Bot Running'); }).listen(process.env.PORT || 3000);
