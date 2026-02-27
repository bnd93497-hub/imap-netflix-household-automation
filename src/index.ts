import 'dotenv/config';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { JWT } from 'google-auth-library';
import { GoogleSpreadsheet } from 'google-spreadsheet';

// --- GOOGLE SHEETS SETUP ---
// We use regex to replace "\\n" so Render's vault doesn't break the private key format
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID as string, serviceAccountAuth);

async function getCustomerNumber(receivingEmail: string, profileName: string): Promise<string | null> {
    try {
        await doc.loadInfo(); 
        const sheet = doc.sheetsByIndex[0]; // Grabs the first tab of your sheet
        const rows = await sheet.getRows();
        
        for (const row of rows) {
            const sheetEmail = row.get('EmailAccount')?.trim().toLowerCase();
            const sheetName = row.get('ProfileName')?.trim().toLowerCase();
            
            if (sheetEmail === receivingEmail.toLowerCase() && sheetName === profileName.toLowerCase()) {
                const phone = row.get('Phone')?.trim();
                return `${phone}@s.whatsapp.net`;
            }
        }
    } catch (error) {
        console.log("❌ Google Sheets Error:", error);
    }
    return null; // Returns null if no match is found
}

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
                            const profileName = extractProfileName(parsed.text || ''); 
                            
                            // Finds exactly which email address received this notification
                            const receivingEmail = parsed.to?.value?.[0]?.address || process.env.IMAP_USER || "";
                            
                            if (link && waSocket) {
                                // Calls Google Sheets to find the match!
                                const fetchedNumber = await getCustomerNumber(receivingEmail, profileName || "");
                                const target = fetchedNumber || "96181123343@s.whatsapp.net"; // Failsafe to your number
                                
                                const fullSubject = parsed.subject || "";
                                let message = "";

                                // --- THE SWITCHBOARD ---
                                if (fullSubject.includes("Important: How to update your Netflix Household")) {
                                    message = `Hey *${profileName}*,\n\n` +
                                              `Netflix needs to verify your TV. Click the link below, then click 'Update Netflix Household' to continue watching:\n\n` +
                                              `🔗 ${link}\n\n` +
                                              `_*Enjoy your time on Netflix.*_`;
                                } 
                                else if (fullSubject.includes("Your Netflix temporary access code")) {
                                    message = `Hey *${profileName}*,\n\n` +
                                              `Click the link below to get the 4-digit code to continue watching:\n\n` +
                                              `🔗 ${link}\n\n` +
                                              `_*Enjoy your time on Netflix.*_`;
                                }
                                
                                if (message !== "") {
                                    try {
                                        await waSocket.sendMessage(target, { text: message });
                                        console.log(`✅ SENT TO: ${target} | PROFILE: ${profileName} | GMAIL: ${receivingEmail}`);
                                    } catch (e) {
                                        console.log(`❌ WhatsApp Error:`, e);
                                    }
                                }
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
