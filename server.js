const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
require('dotenv').config();

// --- CONFIG: EMAILJS KEYS (Replace these with your actual keys later or use Env Vars) ---
const EMAIL_SERVICE_ID = "service_YOUR_ID_HERE"; // 🔴 REPLACE THIS
const EMAIL_TEMPLATE_ID = "template_YOUR_ID_HERE"; // 🔴 REPLACE THIS
const EMAIL_PUBLIC_KEY = "user_YOUR_PUBLIC_KEY"; // 🔴 REPLACE THIS
const EMAIL_PRIVATE_KEY = "YOUR_PRIVATE_KEY";   // 🔴 REPLACE THIS

// --- 1. INITIALIZE DATABASE ---
let db;
try {
    if (process.env.FIREBASE_SERVICE_KEY) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_KEY);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        db = admin.firestore();
        console.log("✅ Database Connected");
    } else { console.warn("⚠️ DB Key Missing"); }
} catch (e) { console.error("❌ DB Error:", e.message); }

const app = express();
const PORT = process.env.PORT || 3000;

// --- 2. HELPER: SEND EMAIL ---
async function sendEmail(email, name, subject, message) {
    if(EMAIL_SERVICE_ID === "service_YOUR_ID_HERE") {
        console.log("⚠️ Email Skipped: Keys not set in server.js");
        return;
    }
    try {
        await axios.post('https://api.emailjs.com/api/v1.0/email/send', {
            service_id: service_6daew9c,
            template_id: template_xkttl3m,
            user_id: vvYwIpaail917c6nW,
            accessToken: pWYiVCzWozZLyFZ7V2ILK,
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

// --- 3. HELPER: BANK CODES ---
const getBankCode = (input) => {
    if (!input) return null;
    const name = input.toLowerCase().replace(/\s/g, '');
    const map = {
        "gtb": "058", "gtbank": "058", "access": "044", "zenith": "057", 
        "uba": "033", "opay": "999992", "kuda": "50211", "wema": "035", 
        "first": "011", "sterling": "232", "fcmb": "214", "palmpay": "999991"
    };
    return map[name] || null;
};

// --- 4. HELPER: SEND MONEY ---
async function sendMoney(amount, bankName, accountNumber, reason) {
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

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ROUTES ---
app.post('/api/create-wallet', async (req, res) => {
    // ... (Your existing wallet creation code remains here - standard setup) ...
    // For brevity in this update, I'm focusing on the Webhook below.
    // Ensure you keep your Create Wallet logic!
    const { firstName, lastName, email, phone, bvn } = req.body;
    if (!process.env.PAYSTACK_SECRET) return res.status(500).json({ error: "Key Missing" });

    try {
        const config = { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` } };
        const r1 = await axios.post('https://api.paystack.co/customer', { email, first_name: firstName, last_name: lastName, phone }, config);
        const code = r1.data.data.customer_code;
        if (bvn) { try { await axios.post(`https://api.paystack.co/customer/${code}/identification`, { country: "NG", type: "bank_verification_number", value: bvn, first_name: firstName, last_name: lastName }, config); } catch(e){} }
        
        let acct = phone;
        if (r1.data.data.dedicated_account) acct = r1.data.data.dedicated_account.account_number;
        else { try { const r2 = await axios.post('https://api.paystack.co/dedicated_account', { customer: code, preferred_bank: "wema-bank" }, config); acct = r2.data.data.account_number; } catch(e){} }
        
        // Send Welcome Email
        sendEmail(email, firstName, "Welcome to F8FU!", "Your automated wallet is ready. Send money to account: " + acct);
        
        res.json({ status: 'success', data: { customer_code: code, account_number: acct } });
    } catch (e) {
        if (e.response?.status === 400) {
             const fetchRes = await axios.get(`https://api.paystack.co/customer/${email}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` } });
             res.json({ status: 'success', data: { customer_code: fetchRes.data.data.customer_code, account_number: fetchRes.data.data.phone } });
        } else { res.status(500).json({ error: "Error" }); }
    }
});

app.post('/api/split', (req, res) => { /* Calculator Logic */ });

// --- 5. THE AUTOMATED WEBHOOK (Now with Emails) ---
app.post('/api/webhook', (req, res) => {
    const secret = process.env.PAYSTACK_SECRET;
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Invalid'); 

    const event = req.body;
    if (event.event === 'charge.success') {
        const amount = event.data.amount / 100;
        const email = event.data.customer.email;
        const firstName = event.data.customer.first_name || "User";

        console.log(`💰 Credit Alert: ₦${amount} from ${email}`);
        
        // 1. SEND CREDIT ALERT EMAIL
        sendEmail(email, firstName, "Credit Alert: ₦" + amount, 
            `We received ₦${amount} in your F8FU Wallet. The 4-minute auto-split timer has started.`);

        // 2. START 4-MINUTE TIMER
        setTimeout(async () => {
            if (!db) return;
            console.log(`🚀 Executing Split for ${email}`);

            try {
                // Find User
                const snapshot = await db.collection('users').where('wallet.email', '==', email).limit(1).get();
                if (snapshot.empty) return console.log("User not found for split");

                const userDoc = snapshot.docs[0].data();
                const b = userDoc.beneficiaries;
                if (!b) return console.log("No beneficiaries set");

                // Calculate
                const tithe = amount * 0.10;
                const savings = amount * 0.20;
                const needs = amount * 0.30;
                const invest = amount * 0.40;

                // Execute Transfers
                const r1 = await sendMoney(tithe, b.tithe.bank, b.tithe.number, "Tithe");
                const r2 = await sendMoney(savings, b.savings.bank, b.savings.number, "Savings");
                const r3 = await sendMoney(needs, b.needs.bank, b.needs.number, "Needs");
                const r4 = await sendMoney(invest, b.investment.bank, b.investment.number, "Invest");

                // 3. SEND DEBIT/REPORT EMAIL
                const report = `
                    Analysis Complete. Funds Distributed:
                    - Tithe (10%): ₦${tithe} [${r1}]
                    - Savings (20%): ₦${savings} [${r2}]
                    - Needs (30%): ₦${needs} [${r3}]
                    - Invest (40%): ₦${invest} [${r4}]
                    
                    Your F8FU Wallet balance is now cleared.
                `;
                
                sendEmail(email, firstName, "Transaction Report: ₦" + amount, report);
                console.log("✅ Report Email Sent");

            } catch (err) { console.error("Auto-Split Error:", err.message); }
        }, 4 * 60 * 1000);
    }
    res.sendStatus(200);
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
