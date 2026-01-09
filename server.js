const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
require('dotenv').config();

// --- 1. SETUP APP & MIDDLEWARE ---
const app = express(); // <--- THIS LINE WAS MISSING OR MOVED
const PORT = process.env.PORT || 5000;

app.use(bodyParser.json());
app.use(express.static(__dirname)); // Serve HTML files

// --- CONFIG: EMAILJS KEYS ---
const EMAIL_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || "service_6daew9c";
const EMAIL_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID || "template_xkttl3m";
const EMAIL_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || "vvYwIpaail917c6nW";
const EMAIL_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || "pWYiVCzWozZLyFZ7V2ILK";

// --- 2. INITIALIZE DATABASE (The Hybrid Fix) ---
let db;
try {
    let serviceAccount;
    
    // Priority 1: Check Environment Variable (For Render)
    if (process.env.FIREBASE_SERVICE_KEY) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_KEY);
    } 
    // Priority 2: Check Local File (For AfeesHost / Local Testing)
    else {
        try {
            serviceAccount = require('./service-account.json');
        } catch (err) {
            // File not found, ignore
        }
    }

    if (serviceAccount) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        console.log("✅ Database Connected");
    } else { 
        console.warn("⚠️ DB Key Missing. Ensure 'service-account.json' is in the folder or ENV vars are set."); 
    }
} catch (e) { console.error("❌ DB Error:", e.message); }

// --- 3. HELPER: SEND EMAIL ---
async function sendEmail(email, name, subject, message) {
    try {
        await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
            service_id: EMAIL_SERVICE_ID,
            template_id: EMAIL_TEMPLATE_ID,
            user_id: EMAIL_PUBLIC_KEY,
            accessToken: EMAIL_PRIVATE_KEY,
            template_params: {
                to_email: email,
                to_name: name || "User",
                subject: subject,
                message: message
            }
        });
        console.log(`📧 Email Sent to ${email}: ${subject}`);
    } catch (error) {
        console.error("❌ Email Failed:", error.response?.data || error.message);
    }
}

// --- 4. HELPER: BANK CODES ---
const getBankCode = (input) => {
    if (!input) return null;
    const name = input.toLowerCase().replace(/\s/g, '');
    const map = {
        "gtb": "058", "gtbank": "058", "access": "044", "zenith": "057", 
        "uba": "033", "opay": "999992", "kuda": "50211", "wema": "035", 
        "first": "011", "sterling": "232", "fcmb": "214", "palmpay": "999991",
        "moniepoint": "50515" 
    };
    return map[name] || null;
};

// --- 5. HELPER: SEND MONEY ---
async function sendMoney(amount, bankName, accountNumber, reason) {
    if (!process.env.PAYSTACK_SECRET) return `❌ Failed: Paystack Key Missing`;
    
    const config = { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` } };
    const bankCode = getBankCode(bankName);
    if (!bankCode) return `❌ Failed: Unknown Bank (${bankName})`;

    try {
        const r1 = await axios.post('https://api.paystack.co/transferrecipient', {
            type: "nuban", name: "F8FU Beneficiary", account_number: accountNumber, bank_code: bankCode, currency: "NGN"
        }, config);
        
        await axios.post('https://api.paystack.co/transfer', {
            source: "balance", amount: Math.floor(amount * 100), recipient: r1.data.data.recipient_code, reason: reason
        }, config);
        
        return `✅ Sent ₦${amount} to ${bankName}`;
    } catch (e) {
        return `❌ Failed to ${bankName}: ${e.response?.data?.message || e.message}`;
    }
}

// --- ROUTES ---

// Create Wallet Route
app.post('/api/create-wallet', async (req, res) => {
    const { firstName, lastName, email, phone, bvn } = req.body;
    if (!process.env.PAYSTACK_SECRET) return res.status(500).json({ error: "Server Error: Paystack Key Missing" });

    try {
        const config = { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` } };
        
        const r1 = await axios.post('https://api.paystack.co/customer', { email, first_name: firstName, last_name: lastName, phone }, config);
        const code = r1.data.data.customer_code;
        
        if (bvn) { 
            try { 
                await axios.post(`https://api.paystack.co/customer/${code}/identification`, { country: "NG", type: "bank_verification_number", value: bvn, first_name: firstName, last_name: lastName }, config); 
            } catch(e){ console.log("BVN Validation skipped/failed", e.message); } 
        }
        
        let acct = phone;
        if (r1.data.data.dedicated_account) {
            acct = r1.data.data.dedicated_account.account_number;
        } else { 
            try { 
                const r2 = await axios.post('https://api.paystack.co/dedicated_account', { customer: code, preferred_bank: "wema-bank" }, config); 
                acct = r2.data.data.account_number; 
            } catch(e){
                const fetchRes = await axios.get(`https://api.paystack.co/customer/${email}`, config);
                if(fetchRes.data.data.dedicated_account) {
                   acct = fetchRes.data.data.dedicated_account.account_number;
                } else {
                   throw new Error("Could not generate account number. Try again later.");
                }
            } 
        }
        
        sendEmail(email, firstName, "Welcome to F8FU!", `Your automated wallet is ready. Account Number: ${acct} (Wema Bank)`);
        
        res.json({ status: 'success', data: { customer_code: code, account_number: acct } });

    } catch (e) {
        console.error("Create Wallet Error:", e.response?.data || e.message);
        res.status(500).json({ error: e.response?.data?.message || e.message });
    }
});

// Dynamic Webhook Route
app.post('/api/webhook', async (req, res) => {
    const secret = process.env.PAYSTACK_SECRET;
    if(!secret) return res.status(500).send("Secret missing");

    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Invalid Signature'); 

    const event = req.body;
    
    if (event.event === 'charge.success') {
        const amount = event.data.amount / 100;
        const email = event.data.customer.email;
        const firstName = event.data.customer.first_name || "User";

        console.log(`💰 Credit Alert: ₦${amount} from ${email}`);
        
        sendEmail(email, firstName, `Credit Alert: ₦${amount}`, 
            `We received ₦${amount}. Your custom split will execute in 4 minutes.`);

        setTimeout(async () => {
            if (!db) return;
            try {
                const snapshot = await db.collection('users').where('wallet.email', '==', email).limit(1).get();
                if (snapshot.empty) return console.log("User not found");

                const userDoc = snapshot.docs[0].data();
                const config = userDoc.splitConfig;
                
                if (!config || !Array.isArray(config)) {
                     sendEmail(email, firstName, "Setup Required", "Please configure your split template in the app.");
                     return;
                }

                let report = "Funds Distributed:\n";
                
                for (const item of config) {
                    const splitAmount = Math.floor(amount * (item.percent / 100));
                    const status = await sendMoney(splitAmount, item.bank, item.number, item.name);
                    report += `- ${item.name} (${item.percent}%): ₦${splitAmount} [${status}]\n`;
                }

                sendEmail(email, firstName, `Transaction Report: ₦${amount}`, report);
                console.log("✅ Dynamic Split Complete");

            } catch (err) { console.error("Auto-Split Error:", err.message); }
        }, 4 * 60 * 1000);
    }
    
    res.sendStatus(200);
});

// Serve frontend pages
app.get('*', (req, res) => {
    if(req.path === '/setup') return res.sendFile(path.join(__dirname, 'setup.html'));
    if(req.path === '/wallet') return res.sendFile(path.join(__dirname, 'wallet.html'));
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });