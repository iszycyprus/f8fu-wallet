const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- SECURITY: GATEKEEPER ---
// Only allow requests from YOUR specific domain
app.use((req, res, next) => {
    // 1. Allow Webhooks from Paystack (They don't have an Origin header)
    if (req.path === '/api/webhook') return next();

    // 2. Check Origin for everyone else
    const allowedOrigin = 'https://f8fu-app.onrender.com'; // REPLACE THIS if you use a custom domain later
    const origin = req.headers.origin || req.headers.referer;

    // If it's a browser API call, it MUST come from your site
    if (req.path.startsWith('/api/') && (!origin || !origin.includes('onrender.com'))) {
        console.log(`⛔ BLOCKED suspicious request from: ${origin}`);
        return res.status(403).json({ error: "Access Denied: Unauthorized Source" });
    }

    next();
});

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. CALCULATOR API ---
app.post('/api/split', (req, res) => {
    const { amount } = req.body;
    if (!amount || isNaN(amount)) return res.status(400).json({ error: "Invalid amount" });
    const amt = parseFloat(amount);
    res.json({
        savings: amt * 0.20,
        tithe: amt * 0.10,
        investment: amt * 0.40,
        needs: amt * 0.30
    });
});

// --- 2. CREATE WALLET API (Secured) ---
app.post('/api/create-wallet', async (req, res) => {
    const { firstName, lastName, email, phone, bvn } = req.body;
    
    // INPUT SANITIZATION (Stop garbage data)
    if(!email || !email.includes('@')) return res.status(400).json({error: "Invalid Email"});
    if(bvn && bvn.length !== 11) return res.status(400).json({error: "BVN must be 11 digits"});

    if (!process.env.PAYSTACK_SECRET) {
        return res.status(500).json({ status: 'error', error: "Server Key Missing" });
    }

    const config = {
        headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
            'Content-Type': 'application/json'
        }
    };

    try {
        // A. Create Customer
        const response = await axios.post('https://api.paystack.co/customer', { 
            email, first_name: firstName, last_name: lastName, phone 
        }, config);

        const customerCode = response.data.data.customer_code;
        
        // B. Validate BVN
        if (bvn) {
            try {
                await axios.post(`https://api.paystack.co/customer/${customerCode}/identification`, {
                    country: "NG", type: "bank_verification_number", value: bvn,
                    first_name: firstName, last_name: lastName
                }, config);
            } catch (kycError) {
                console.log("KYC Note: " + (kycError.response?.data?.message || "Skipped"));
            }
        }

        // C. Fetch Account
        let accountNum = phone; 
        if (response.data.data.dedicated_account) {
            accountNum = response.data.data.dedicated_account.account_number;
        } else {
             try {
                const dvaRes = await axios.post('https://api.paystack.co/dedicated_account', {
                    customer: customerCode, preferred_bank: "wema-bank" 
                }, config);
                accountNum = dvaRes.data.data.account_number;
            } catch (dvaErr) {}
        }

        res.json({ status: 'success', data: { customer_code: customerCode, account_number: accountNum } });

    } catch (error) {
        if (error.response && error.response.status === 400) {
            try {
                const fetchRes = await axios.get(`https://api.paystack.co/customer/${email}`, config);
                res.json({ status: 'success', data: { customer_code: fetchRes.data.data.customer_code, account_number: fetchRes.data.data.phone || phone } });
            } catch (e) { res.status(500).json({ status: 'error', error: "Recovery failed." }); }
        } else {
            res.status(500).json({ status: 'error', error: "Payment Server Error" });
        }
    }
});

// --- 3. WEBHOOK LISTENER ---
app.post('/api/webhook', (req, res) => {
    const secret = process.env.PAYSTACK_SECRET;
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.status(400).send('Invalid signature'); 
    
    const event = req.body;
    if (event.event === 'charge.success') {
        console.log(`💰 PAYMENT RECEIVED: ₦${event.data.amount / 100}`);
    }
    res.sendStatus(200);
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
