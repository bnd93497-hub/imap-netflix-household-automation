import 'dotenv/config';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { JWT } from 'google-auth-library';
import { GoogleSpreadsheet } from 'google-spreadsheet';

// --- GOOGLE SHEETS SETUP ---
// We use regex to replace "\\n" and strip out accidental quotation marks from the JSON copy-paste
const serviceAccountAuth = new JWT({
    email: (process.env.GOOGLE_CLIENT_EMAIL || '').replace(/"/g, ''),
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/"/g, ''),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID as string, serviceAccountAuth);

async function getCustomerNumber(receivingEmail: string, profileName: string): Promise<string | null> {
    try {
        await doc.loadInfo(); 
        const sheet = doc.sheetsByIndex[0]; 
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
    return null; 
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

/// --- EXTRACTION LOGIC ---
function extractProfileName(text: string): string | null {
    // 1. First, check if someone specific requested the link
    const requestedMatch = text.match(/Requested by\s+([A-Za-z]+)/i);
    if (requestedMatch) {
        return requestedMatch[1]; // Returns "Elias"
    }
}

function extractNetflixLink(text: string): string | null {
    const match = text.match(/https:\/\/(www\.)?netflix\.com\/[^\s"'>]+/i);
    return match ? match[0] : null;
}
// --- MULTIPLE EMAIL SCANNERS ---
// This function acts like a blueprint. We call it once for every email in your list.
function startEmailListener(emailUser: string, emailPass: string) {
    const imap = new Imap({
        user: emailUser,
        password: emailPass,
        host: process.env.IMAP_HOST as string || 'imap.gmail.com',
        port: parseInt(process.env.IMAP_PORT as string || '993', 10),
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
    });

    imap.once('ready', () => {
        console.log(`✅ GMAIL LISTENER ONLINE FOR: ${emailUser}`);
        imap.openBox('INBOX', false, (err, box) => {
            if (err) {
                console.log(`❌ Inbox error for ${emailUser}:`, err);
                return;
            }
            imap.on('mail', () => {
                const fetch = imap.seq.fetch(box.messages.total + ':*', { bodies: '' });
                fetch.on('message', (msg) => {
                    msg.on('body', (stream) => {
                        simpleParser(stream, async (err: any, parsed: any) => {
                            if (parsed.text?.includes('netflix.com')) {
                                const link = extractNetflixLink(parsed.text || '');
                                const profileName = extractProfileName(parsed.text || ''); 
                                
                                // We capture exactly which bot listener heard this email
                                const receivingEmail = emailUser; 
                                
                                if (link && waSocket) {
                                    const fetchedNumber = await getCustomerNumber(receivingEmail, profileName || "");
                                    const target = fetchedNumber || "96181123343@s.whatsapp.net"; 
                                    
                                    const fullSubject = parsed.subject || "";
                                    let message = "";

                                    // --- THE SWITCHBOARD ---
                                    if (fullSubject.includes("Important: How to update your Netflix Household")) {
                                        message = `Hey *${profileName}*,\n\n` +
                                                  `Netflix needs to verify your TV.,\n\n` +
                                                  `Click the link below, then click *'Update Netflix Household'* to continue watching:\n\n` +
                                                  ` ${link}\n\n` +
                                                  `_*Enjoy your time on Netflix.*_`;
                                    } 
                                    else if (fullSubject.includes("Your Netflix temporary access code")) {
                                        message = `Hey *${profileName || 'there'}*,\n\n` +
                                                  `Click the link below to get the 4-digit code to continue watching:\n\n` +
                                                  ` ${link}\n\n` +
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
    
    imap.on('error', (err: any) => {
        console.log(`❌ IMAP Connection Error for ${emailUser}`);
    });

    imap.connect();
}

// --- LAUNCH EVERYTHING ---
startWhatsApp();

// This grabs your comma-separated lists from Render and splits them into arrays
const emailUsers = (process.env.IMAP_USERS || process.env.IMAP_USER || "").split(',').map(u => u.trim());
const emailPasses = (process.env.IMAP_PASSWORDS || process.env.IMAP_PASSWORD || "").split(',').map(p => p.trim());

// Loops through the lists and starts a listener for each pair
if (emailUsers.length === emailPasses.length && emailUsers[0] !== "") {
    for (let i = 0; i < emailUsers.length; i++) {
        startEmailListener(emailUsers[i], emailPasses[i]);
    }
} else {
    console.log("❌ ERROR: Check your IMAP_USERS and IMAP_PASSWORDS in Render. They must have the same number of items.");
}

http.createServer((req, res) => { res.writeHead(200); res.end('Bot Running'); }).listen(process.env.PORT || 3000);
