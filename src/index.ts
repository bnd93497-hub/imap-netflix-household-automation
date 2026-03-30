import 'dotenv/config';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { JWT } from 'google-auth-library';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { MongoClient } from 'mongodb';
import { useMongoDBAuthState } from 'mongo-baileys';
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
    // 1. Connect to your permanent database
    const mongoClient = new MongoClient("mongodb+srv://bnd93497_db_user:FeCyajWaKx1tvugf@cluster0.r4mgag3.mongodb.net/?appName=Cluster0");
    await mongoClient.connect();
    const collection = mongoClient.db("whatsapp_bot").collection("auth_info");

    // 2. Tell Baileys to save the login here (using "as any" to bypass TypeScript strict errors)
    const { state, saveCreds } = await useMongoDBAuthState(collection as any);
    const { version } = await fetchLatestBaileysVersion();
    
    // 3. Start the socket (also bypassing the state type check)
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
    // Smashes both email versions together and strips out all HTML tags
    const fullContent = (text + " " + html).replace(/<[^>]*>?/gm, '');
    
    // 1. Priority: Looks for the Requester
    const requestedMatch = fullContent.match(/Requested by[^A-Za-z]*([A-Za-z]+)/i);
    if (requestedMatch) return requestedMatch[1];
    
    // 2. Fallback: Looks for the Account Owner
    const hiMatch = fullContent.match(/Hi[^A-Za-z]*([A-Za-z]+)/i);
    if (hiMatch) return hiMatch[1];
    
    return null; 
}

function extractNetflixLink(text: string): string | null {
    // 1. Find all Netflix links
    const matches = text.match(/https:\/\/(www\.)?netflix\.com\/[^\s"'>]+/gi);
    
    // 🛑 SAFETY NET: If no links exist at all, return null
    if (!matches || matches.length === 0) return null;

    // 2. ONLY return if it matches the Household update path
    const householdLink = matches.find(link => 
        link.includes('/account/update-primary-location')
    );
    if (householdLink) return householdLink;

    // 3. ONLY return if it matches the standard temporary access code path
    const loginCodeLink = matches.find(link => link.includes('/account/travel'));
    if (loginCodeLink) return loginCodeLink;

    // 🛑 STRICT FINISH: If none of the above matched, return null.
    // This satisfies TypeScript and ensures no "random" links are sent.
    return null;
}
// --- MULTIPLE EMAIL SCANNERS ---
// This function acts like a blueprint. We call it once for every email in your list.
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
// 🛡️ THE ZOMBIE KILLER
    const zombieKiller = setTimeout(() => {
        console.log(`♻️ HEARTBEAT: Force restarting ${emailUser} to prevent silent disconnect...`);
        imap.destroy(); 
        reconnect(); 
    }, 45 * 60 * 1000); // 45 minutes
    const reconnect = () => {
        clearTimeout(zombieKiller);
    console.log(`🔄 Reconnecting for ${emailUser} in 30s...`);
    imap.destroy(); // 1. Ensure the old zombie connection is dead
    setTimeout(() => { 
        startEmailListener(emailUser, emailPass); // 2. Restart the whole process fresh
    }, 30000);
};
    imap.once('ready', () => {
        console.log(`✅ GMAIL LISTENER ONLINE FOR: ${emailUser}`);
        imap.openBox('INBOX', false, (err, box) => {
            if (err) { imap.destroy(); reconnect(); return; }
            
            imap.on('mail', () => {
                const fetch = imap.seq.fetch(box.messages.total + ':*', { bodies: '' });
                fetch.on('message', (msg) => {
                    msg.on('body', (stream) => {
                        // YOUR EXISTING simpleParser STARTS RIGHT HERE...
                        simpleParser(stream, async (err: any, parsed: any) => {
// 🚨 PASTE THIS HERE so it rings immediately
    console.log(`\n--- 🕵️ NEW EMAIL INTERCEPTED FOR ${emailUser} ---`);
    console.log(`RAW SUBJECT: ${parsed.subject}`);
                            
                            if (parsed.text?.includes('netflix.com')) {
                                const link = extractNetflixLink(parsed.text || '');
                               const profileName = extractProfileName(parsed.text || '', parsed.html || '');
                                
                                // We capture exactly which bot listener heard this email
                                const receivingEmail = emailUser; 
                                
                                if (link && waSocket) {
                                    const fetchedNumber = await getCustomerNumber(receivingEmail, profileName || "");
                                    const target = fetchedNumber || "96181123343@s.whatsapp.net"; 
                                    
                                    const fullSubject = parsed.subject || "";
                                    let message = "";

console.log(`EXTRACTED LINK: ${link}\n`);

     // --- THE SWITCHBOARD ---
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
                                }
                            }
                        });
                    });
                });
            });
        });
    });
    
   imap.on('error', (err: any) => {
       clearTimeout(zombieKiller);
        console.log(`❌ IMAP Connection Error for ${emailUser}`);
        reconnect(); // <-- This tells the bot to actually restart!
    });

    // We are adding this to catch silent disconnects from Google
    imap.on('end', () => {
        clearTimeout(zombieKiller);
        console.log(`📡 Connection dropped for ${emailUser}.`);
        reconnect(); // <-- This tells the bot to actually restart!
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

