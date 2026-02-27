// Force a server reboot every 25 minutes to keep Gmail connected
setTimeout(() => {
  console.log("Refreshing IMAP connection...");
  process.exit(1);
}, 25 * 60 * 1000);

import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

async function connectToWhatsApp () {
    const { state, saveCreds } = await useMultiFileAuthState('whatsapp_auth');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, qr } = update;
        if (qr) {
            console.log('📱 SCAN THIS QR CODE WITH YOUR WHATSAPP 📱');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('✅ WhatsApp is officially connected!');
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

import http from 'http';
const port = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Netflix Bot is awake!\n');
}).listen(port, () => {
  console.log(`Dummy server listening on port ${port} to keep Render happy`);
});


import Imap from 'imap';
import Errorlogger from './Errorlogger';
import playwrightAutomation from './playwrightAutomation';

const imap = new Imap({
  user: process.env.IMAP_USER ?? '',
  password: process.env.IMAP_PASSWORD ?? '',
  host: process.env.IMAP_HOST ?? '',
  port: Number(process.env.IMAP_PORT) ?? 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
  connTimeout: 3_600_000, // set to 1 Hour to reconnect, if Connection is lost
  keepalive: {
    interval: 10000, // Send NOOP commands every 10 seconds
    idleInterval: 300000, // Re-send IDLE command every 5 minutes
  },
});

async function handleEmails() {
  imap.search([
    'UNSEEN',
    ['HEADER', 'FROM', process.env.TARGET_EMAIL_ADDRESS],
    ['HEADER', 'SUBJECT', process.env.TARGET_EMAIL_SUBJECT],
  ], (err, results) => {
    if (err) {
      new Errorlogger(err);
    }

    // No E-Mails found => skip
    if (!results || !results.length) {
      return;
    }

    // https://github.com/mscdex/node-imap#:~:text=currently%20open%20mailbox.-,Valid%20options%20properties%20are%3A,-*%20**markSeen**%20%2D%20_boolean_%20%2D%20Mark
    const fetchingData = imap.fetch(results, { bodies: 'TEXT', markSeen: true });
    fetchingData.on('message', (msg) => {
      let body = '';
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => {
          body += chunk.toString('utf-8');
        });

        stream.on('end', async () => {
          // we're removing all new line before (quoted-printable)
          const quotedPrintable = body.replace(/=(\r?\n|$)/g, '').replace(/=([a-f0-9]{2})/ig, (m, code) => String.fromCharCode(parseInt(code, 16)));
          // Search specific link, open and click
          const regex = /"(https:\/\/www\.netflix\.com\/account\/update-primary-location[^"]*)"/;
          const match = quotedPrintable.match(regex);

          if (match && match[1]) {
            try {
              const updatePrimaryLink = new URL(match[1]);
              await playwrightAutomation(updatePrimaryLink.toString());
            } catch (e) {
              new Errorlogger(e);
            }
          } else {
            new Errorlogger('no specific Netflix link in E-Mail found');
          }
        });
      });
    });

    fetchingData.on('error', (fetchingError) => {
      new Errorlogger(`Fetching Error: ${fetchingError}`);
    });
  });
}

(function main() {
  // Connect to the IMAP server
  imap.connect();

  // start listening to Inbox
  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err) => {
      if (err) {
        throw new Errorlogger(`open INBOX Error => ${err}`);
      }

      console.log('IMAP connection is ready, start listening Emails on INBOX');
      imap.on('mail', () => handleEmails());
    });
  });

  // Handle Imap errors
  imap.once('error', (err: Error) => {
    throw new Errorlogger(`make sure you E-Mail Provider enabled IMAP and you IMAP Username and Password are correct: ${err}`);
  });

  // End connection on close
  imap.once('end', () => {
    console.log('IMAP connection ended');
  });
}());
