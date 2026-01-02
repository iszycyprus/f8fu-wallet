const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. CALCULATOR API ---
app.post('/api/split', (req, res) => {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: "No amount" });
    const amt = parseFloat(amount);
    res.json({
        savings: amt * 0.20,
        tithe: amt * 0.10,
        investment: amt * 0.40,
        needs: amt * 0.30
    });
});

// --- 2. CREATE WALLET API (With BVN & KYC) ---
app.post('/api/create-wallet', async (req, res) => {
    const { firstName, lastName, email, phone, bvn } = req.body;
    
    // Security Check
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
        console.log(`Creating wallet for: ${email}`);
        
        // A. Create Customer Profile
        const response = await axios.post('https://api.paystack.co/customer', { 
            email, first_name: firstName, last_name: lastName, phone 
        }, config);

        const customerCode = response.data.data.customer_code;
        
        // B. Submit BVN for Validation (Crucial for OPay/Kuda)
        if (bvn) {
            console.log(`Validating BVN for ${customerCode}...`);
            try {
                await axios.post(`https://api.paystack.co/customer/${customerCode}/identification`, {
                    country: "NG",
                    type: "bank_verification_number",
                    value: bvn,
                    first_name: firstName,
                    last_name: lastName
                }, config);
                console.log("BVN Submitted Successfully.");
            } catch (kycError) {
                // We log the error but don't stop the process
                console.log("KYC Note: " + (kycError.response?.data?.message || "Validation skipped"));
            }
        }

        // C. Get the Account Number
        let accountNum = phone; // Fallback
        
        if (response.data.data.dedicated_account) {
            accountNum = response.data.data.dedicated_account.account_number;
        } else {
             try {
                // Explicitly request a NUBAN if one wasn't auto-generated
                const dvaRes = await axios.post('https://api.paystack.co/dedicated_account', {
                    customer: customerCode,
                    preferred_bank: "wema-bank" 
                }, config);
                accountNum = dvaRes.data.data.account_number;
            } catch (dvaErr) {
                console.log("DVA Note: " + (dvaErr.response?.data?.message || "Using fallback"));
            }
        }

        res.json({ 
            status: 'success', 
            data: {
                customer_code: customerCode,
                account_number: accountNum
            }
        });

    } catch (error) {
        // Handle "User Already Exists" smartly
        if (error.response && error.response.status === 400) {
            try {
                const fetchRes = await axios.get(`https://api.paystack.co/customer/${email}`, config);
                res.json({ 
                    status: 'success', 
                    data: {
                        customer_code: fetchRes.data.data.customer_code,
                        account_number: fetchRes.data.data.phone || phone
                    }
                });
            } catch (fetchErr) {
                res.status(500).json({ status: 'error', error: "Account recovery failed." });
            }
        } else {
            const msg = error.response?.data?.message || "Payment Server Error";
            res.status(500).json({ status: 'error', error: msg });
        }
    }
});

// --- 3. WEBHOOK LISTENER (For Deposits) ---
app.post('/api/webhook', (req, res) => {
    const secret = process.env.PAYSTACK_SECRET;
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');
    
    if (hash !== req.headers['x-paystack-signature']) {
        return res.status(400).send('Invalid signature'); 
    }

    const event = req.body;
    if (event.event === 'charge.success') {
        console.log(`💰 PAYMENT RECEIVED: ₦${event.data.amount / 100} from ${event.data.customer.email}`);
    }
    res.sendStatus(200);
});

// Serve Frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log(`F8FU Server running on port ${PORT}`);
});
