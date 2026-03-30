import 'dotenv/config';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import makeWASocket, { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { JWT } from 'google-auth-library';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { MongoClient } from 'mongodb';
import { useMongoDBAuthState } from 'mongo-baileys';

// --- GOOGLE SHEETS SETUP ---
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
    const mongoClient = new MongoClient("mongodb+srv://bnd93497_db_user:FeCyajWaKx1tvugf@cluster0.r4mgag3.mongodb.net/?appName=Cluster0");
    await mongoClient.connect();
    const collection = mongoClient.db("whatsapp_bot").collection("auth_info");

    const { state, saveCreds } = await useMongoDBAuthState(collection as any);
    const { version } = await fetchLatestBaileysVersion();
    
    waSocket = makeWASocket({ version, auth: state as any, printQRInTerminal: false, browser: ['Windows', 'Chrome', '120.0.0'] });
    
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
function extractProfileName(text: string, html: string): string | null {
    const fullContent = (text + " " + html).replace(/<[^>]*>?/gm, '');
    const requestedMatch = fullContent.match(/Requested by[^A-Za-z]*([A-Za-z]+)/i);
    if (requestedMatch) return requestedMatch[1];
    const hiMatch = fullContent.match(/Hi[^A-Za-z]*([A-Za-z]+)/i);
    if (hiMatch) return hiMatch[1];
    return null; 
}

function extractNetflixLink(text: string): string | null {
    const matches = text.match(/https:\/\/(www\.)?netflix\.com\/[^\s"'>]+/gi);
    if (!matches || matches.length === 0) return null;

    const householdLink = matches.find(link => link.includes('/account/update-primary-location'));
    if (householdLink) return householdLink;

    const loginCodeLink = matches.find(link => link.includes('/account/travel'));
    if (loginCodeLink) return loginCodeLink;

    return null;
}

// --- MULTIPLE EMAIL SCANNERS (STABLE ENGINE) ---
function startEmailListener(emailUser: string, emailPass: string) {
    const imap = new Imap({
        user: emailUser,
        password: emailPass,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        keepalive: { interval: 10000, idleInterval: 30000, forceNoKeepAlive: false },
        tlsOptions: { rejectUnauthorized: false }
    });

    let isReconnecting = false;
    
    const zombieKiller = setTimeout(() => {
        console.log(`♻️ HEARTBEAT: Force restarting ${emailUser} to prevent silent disconnect...`);
        reconnect(); 
    }, 45 * 60 * 1000); 

    const reconnect = () => {
        if (isReconnecting) return; 
        isReconnecting = true;
        clearTimeout(zombieKiller);
        
        console.log(`🔄 Reconnecting for ${emailUser} in 30s...`);
        imap.destroy(); 
        setTimeout(() => { 
            startEmailListener(emailUser, emailPass); 
        }, 30000);
    };

    imap.once('ready', () => {
        console.log(`✅ GMAIL LISTENER ONLINE FOR: ${emailUser}`);
        imap.openBox('INBOX', false, (err, box) => {
            if (err) { reconnect(); return; }
            
            // Wait passively for an email to arrive
            imap.on('mail', () => {
                // When an email arrives, ONLY look for unread emails and mark them read immediately
                imap.search(['UNSEEN'], (searchErr, results) => {
                    if (searchErr || !results || results.length === 0) return; 

                    const fetch = imap.fetch(results, { bodies: '', markSeen: true }); 
                    
                    fetch.on('message', (msg) => {
                        msg.on('body', (stream) => {
                            simpleParser(stream, async (err: any, parsed: any) => {
                                console.log(`\n--- 🕵️ NEW EMAIL INTERCEPTED FOR ${emailUser} ---`);
                                console.log(`RAW SUBJECT: ${parsed.subject}`);
                                
                                if (parsed.text?.includes('netflix.com')) {
                                    const link = extractNetflixLink(parsed.text || '');
                                    const profileName = extractProfileName(parsed.text || '', parsed.html || '') || "Admin";
                                    const receivingEmail = emailUser; 
                                    
                                    console.log(`EXTRACTED LINK: ${link}\n`);

                                    if (link && waSocket) {
                                        // 🛑 SAFETY MODE: HARDCODED TO YOUR NUMBER ONLY
                                        const target = "96181123343@s.whatsapp.net"; 
                                        
                                        const fullSubject = parsed.subject || "";
                                        let message = "";

                                        if (fullSubject.includes("Important: How to update your Netflix Household")) {
                                            message = `Hey *${profileName}*,\n\n` +
                                                      `Netflix needs to verify your TV.\n\n` +
                                                      `Click the link below, then click *'Confirm Update'* to continue watching:\n\n` +
                                                      ` ${link}\n\n` +
                                                      `_*Enjoy your time on Netflix.*_`;
                                        } 
                                        else if (fullSubject.includes("Your Netflix temporary access code")) {
                                            message = `Hey *${profileName}*,\n\n` +
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
                                    } else if (!link) {
                                        console.log(`⚠️ WARNING: Email found, but NO LINK extracted.`);
                                    }
                                }
                            });
                        });
                    });
                });
            });
        });
    });

    imap.on('error', (err: any) => {
        console.log(`❌ IMAP Connection Error for ${emailUser}`);
        reconnect(); 
    });

    imap.on('end', () => {
        console.log(`📡 Connection dropped for ${emailUser}.`);
        reconnect(); 
    });

    imap.connect();
}

// --- LAUNCH EVERYTHING ---
startWhatsApp();

const emailUsers = (process.env.IMAP_USERS || process.env.IMAP_USER || "").split(',').map(u => u.trim());
const emailPasses = (process.env.IMAP_PASSWORDS || process.env.IMAP_PASSWORD || "").split(',').map(p => p.trim());

if (emailUsers.length === emailPasses.length && emailUsers[0] !== "") {
    for (let i = 0; i < emailUsers.length; i++) {
        startEmailListener(emailUsers[i], emailPasses[i]);
    }
} else {
    console.log("❌ ERROR: Check your IMAP_USERS and IMAP_PASSWORDS in Render. They must have the same number of items.");
}

http.createServer((req, res) => { res.writeHead(200); res.end('Bot Running'); }).listen(process.env.PORT || 3000);
