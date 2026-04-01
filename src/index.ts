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
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Running'); }).listen(process.env.PORT || 3000);
// This remembers the last time a customer got a text
const cooldownMap = new Map<string, number>();
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
        
        // 1. Force the email targets into clean strings
        const cleanSearchEmail = receivingEmail.toString().toLowerCase().trim();
        const cleanSearchName = profileName.toString().toLowerCase().trim();
        
        for (const row of rows) {
            // 2. Safely grab the raw data from the sheet
            const rawEmail = row.get('EmailAccount');
            const rawName = row.get('ProfileName');
            const rawPhone = row.get('Phone');

            // Skip empty rows to prevent crashes
            if (!rawEmail || !rawName || !rawPhone) continue;

            // 3. Force the sheet data into clean strings
            const sheetEmail = rawEmail.toString().toLowerCase().trim();
            const sheetName = rawName.toString().toLowerCase().trim();
            
            // 4. The absolute match
            if (sheetEmail === cleanSearchEmail && sheetName === cleanSearchName) {
                const finalPhone = rawPhone.toString().trim();
                return `${finalPhone}@s.whatsapp.net`;
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
   const mongoClient = new MongoClient("mongodb+srv://bnd93497_db_user:BotAdmin123@cluster1.hxqhlsq.mongodb.net/?appName=Cluster1&tls=true");
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
    // 1. Strip HTML tags and replace with spaces
    const fullContent = (text + " " + html).replace(/<[^>]*>?/gm, ' ');
    
    // 2. ONLY grab the text that sits exactly between "Requested by" and "from"
    const requestedMatch = fullContent.match(/Requested by\s+(.*?)\s+from/i);
    
    if (requestedMatch && requestedMatch[1]) {
        return requestedMatch[1].trim(); 
    }
    
    // 3. Strict fallback: if we don't find that exact sentence, return null
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
    }, 12 * 60 * 1000); 

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
                console.log(`🔔 DOORBELL RANG! Google says new mail arrived for ${emailUser}`);
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
// 🚨 THE FRONT DOOR BOUNCER 🚨
                                        // We track the Gmail address and the Subject.
                                       const fullSubject = parsed.subject || "";
                                        const spamKey = `${receivingEmail}-${fullSubject}`;
                                        const now = Date.now();
                                        const lastSent = cooldownMap.get(spamKey) || 0;

                                        // If this EXACT email hit this Gmail account in the last 60 secs, kill it.
                                        if (now - lastSent < 60000) {
                                            console.log(`🛑 ANTI-SPAM: Caught duplicate email for ${receivingEmail} at the front door. Killed.`);
                                            return; // <-- This magic word stops the code dead in its tracks.
                                        }
                                        
                                        // Instantly lock the door so the email arriving 1 millisecond later gets blocked
                                        cooldownMap.set(spamKey, now);
                                        // 🚨 END OF BOUNCER 🚨
                                       
                                        // 1. Get the Customer's number from the Sheet
                                        const customerNumber = await getCustomerNumber(receivingEmail, profileName || "");
                                        
                                        // 2. Your personal number (The "Shadow" copy)
                                        const myAdminNumber = "96181123343@s.whatsapp.net"; 

                                        
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
        // 1. Send the background log to YOU (Admin)
        await waSocket.sendMessage(myAdminNumber, { text: `🛡️ [ADMIN LOG]\nFrom: ${receivingEmail}\nTo: ${profileName}\n\n` + message });
        console.log(`✅ ADMIN COPY SENT`);

        // 2. Send the actual message to the CUSTOMER
        if (customerNumber) {
            await waSocket.sendMessage(customerNumber, { text: message });
            console.log(`✅ CUSTOMER COPY SENT TO: ${customerNumber}`);
        } else {
            console.log(`⚠️ No customer phone found in Sheet for ${profileName}.`);
        }
    } catch (e) {
        console.log(`❌ WhatsApp Error:`, e);
    }
 } else if (!link) {
                                        console.log(`⚠️ WARNING: Email found, but NO LINK extracted.`);
                                    }
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
