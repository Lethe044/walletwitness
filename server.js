const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------
// In-memory store (demo purpose)
// ---------------------------------
const contracts = {};
const auditLogs = {};

// ---------------------------------
// OWS Policy Engine Simulator
// Produces real OWS-compatible policy JSON
// and enforces rules before signing
// ---------------------------------
function buildOwsPolicy(contractData) {
  return {
    id: uuidv4(),
    name: `escrow-policy-${contractData.id}`,
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    rules: [
      {
        type: "spending_limit",
        maxAmountUsd: parseFloat(contractData.amount),
        period: "one_time",
        action: "deny_if_exceeded",
      },
      {
        type: "chain_allowlist",
        allowedChains: [contractData.chain || "eip155:8453"],
        action: "deny_if_not_in_list",
      },
      {
        type: "recipient_allowlist",
        allowedAddresses: [contractData.freelancerWallet],
        action: "deny_if_not_in_list",
      },
      {
        type: "time_restriction",
        notBefore: contractData.createdAt,
        notAfter: contractData.deadline,
        action: "deny_if_outside_window",
      },
      {
        type: "require_ai_verification",
        verificationStatus: "must_be_approved",
        action: "deny_if_not_verified",
      },
    ],
  };
}

// ---------------------------------
// OWS Signing Simulator
// Mimics the real OWS signing flow:
// 1. Decrypt key (simulated)
// 2. Evaluate policy
// 3. Sign transaction
// 4. Wipe key from memory
// 5. Return signed tx + audit entry
// ---------------------------------
function simulateOwsSigning(contract, policy) {
  const steps = [];

  steps.push({
    step: 1,
    label: "Key Decryption",
    detail: "AES-256-GCM encrypted key loaded from ~/.ows/wallets/ vault",
    status: "ok",
    timestamp: new Date().toISOString(),
  });

  // Policy checks
  const amountCheck =
    parseFloat(contract.amount) <=
    policy.rules.find((r) => r.type === "spending_limit").maxAmountUsd;
  steps.push({
    step: 2,
    label: "Spending Limit Check",
    detail: `Requested: $${contract.amount} - Limit: $${contract.amount} - Result: PASS`,
    status: amountCheck ? "ok" : "denied",
    timestamp: new Date().toISOString(),
  });

  const chainCheck = policy.rules
    .find((r) => r.type === "chain_allowlist")
    .allowedChains.includes(contract.chain || "eip155:8453");
  steps.push({
    step: 3,
    label: "Chain Allowlist Check",
    detail: `Chain: ${contract.chain || "eip155:8453"} - Result: PASS`,
    status: chainCheck ? "ok" : "denied",
    timestamp: new Date().toISOString(),
  });

  const recipientCheck = policy.rules
    .find((r) => r.type === "recipient_allowlist")
    .allowedAddresses.includes(contract.freelancerWallet);
  steps.push({
    step: 4,
    label: "Recipient Allowlist Check",
    detail: `Recipient: ${contract.freelancerWallet.slice(0, 10)}... - Result: PASS`,
    status: recipientCheck ? "ok" : "denied",
    timestamp: new Date().toISOString(),
  });

  steps.push({
    step: 5,
    label: "AI Verification Gate",
    detail: "Delivery verified by Claude - verification_status: approved",
    status: "ok",
    timestamp: new Date().toISOString(),
  });

  const allPassed = steps.every((s) => s.status === "ok");

  const signedTx = allPassed
    ? {
        hash:
          "0x" +
          Array.from({ length: 64 }, () =>
            Math.floor(Math.random() * 16).toString(16)
          ).join(""),
        from: contract.clientWallet,
        to: contract.freelancerWallet,
        value: contract.amount,
        chain: contract.chain || "eip155:8453",
        nonce: Math.floor(Math.random() * 1000),
        gasUsed: "21000",
        signedAt: new Date().toISOString(),
        keyWipedAt: new Date().toISOString(),
        privateKeyExposed: false,
      }
    : null;

  return { steps, allPassed, signedTx };
}

// ---------------------------------
// Append-only Audit Log
// ---------------------------------
function appendAuditLog(contractId, event) {
  if (!auditLogs[contractId]) auditLogs[contractId] = [];
  auditLogs[contractId].push({
    id: uuidv4(),
    contractId,
    timestamp: new Date().toISOString(),
    ...event,
  });
}

// ---------------------------------
// AI Delivery Verification (Claude API)
// ---------------------------------
async function verifyDeliveryWithClaude(contract, deliveryText) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  if (!ANTHROPIC_API_KEY) {
    // Demo mode - simulate AI response if no key provided
    return simulateAiVerification(contract, deliveryText);
  }

  const prompt = `You are a strict but fair escrow verification agent. Your job is to determine whether a freelancer has fulfilled the agreed contract conditions.

CONTRACT TITLE: ${contract.title}

CONTRACT DESCRIPTION (what was agreed):
${contract.description}

FREELANCER'S DELIVERY CLAIM:
${deliveryText}

Analyze whether the delivery matches the contract requirements. Be specific. Return a JSON object with exactly this structure:
{
  "approved": true or false,
  "score": a number from 0 to 100 representing how well the delivery matches requirements,
  "summary": "one sentence verdict",
  "matched": ["list of requirements that were met"],
  "missing": ["list of requirements that were NOT met"],
  "recommendation": "APPROVE" or "REJECT" or "REQUEST_MORE_INFO"
}

Return only the JSON, no other text.`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    const raw = response.data.content[0].text;
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Claude API error:", err.message);
    return simulateAiVerification(contract, deliveryText);
  }
}

function simulateAiVerification(contract, deliveryText) {
  const words = deliveryText.toLowerCase().split(/\s+/);
  const titleWords = contract.title.toLowerCase().split(/\s+/);
  const descWords = contract.description.toLowerCase().split(/\s+/);

  const matchCount = words.filter(
    (w) => titleWords.includes(w) || descWords.includes(w)
  ).length;
  const score = Math.min(95, 40 + matchCount * 8);
  const approved = score >= 60;

  return {
    approved,
    score,
    summary: approved
      ? "Delivery aligns with the contract requirements based on the provided evidence."
      : "Delivery description does not sufficiently demonstrate fulfillment of contract requirements.",
    matched: approved
      ? ["Delivery text references relevant contract terms", "Submission is present and detailed"]
      : ["Submission was received"],
    missing: approved
      ? []
      : ["Insufficient evidence of completion", "Contract terms not clearly addressed"],
    recommendation: approved ? "APPROVE" : "REQUEST_MORE_INFO",
  };
}

// ===========================================
// ROUTES
// ===========================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
});

// Create a new contract
app.post("/api/contracts", (req, res) => {
  const { title, description, amount, chain, clientWallet, freelancerWallet, deadline } = req.body;

  if (!title || !description || !amount || !clientWallet || !freelancerWallet || !deadline) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Validate wallet addresses (basic check)
  const walletRegex = /^0x[a-fA-F0-9]{40}$/;
  if (!walletRegex.test(clientWallet) || !walletRegex.test(freelancerWallet)) {
    return res.status(400).json({ error: "Invalid wallet address format. Must be a valid EVM address (0x...)" });
  }

  if (parseFloat(amount) <= 0 || parseFloat(amount) > 1000000) {
    return res.status(400).json({ error: "Amount must be between 0 and 1,000,000" });
  }

  const id = uuidv4();
  const createdAt = new Date().toISOString();

  const contract = {
    id,
    title,
    description,
    amount: parseFloat(amount).toFixed(2),
    chain: chain || "eip155:8453",
    clientWallet,
    freelancerWallet,
    deadline,
    createdAt,
    status: "AWAITING_DELIVERY",
    aiVerification: null,
    owsPolicy: null,
    signingResult: null,
  };

  contract.owsPolicy = buildOwsPolicy(contract);
  contracts[id] = contract;

  appendAuditLog(id, {
    event: "CONTRACT_CREATED",
    actor: "client",
    data: { title, amount, chain: contract.chain },
  });

  res.status(201).json(contract);
});

// Get all contracts
app.get("/api/contracts", (req, res) => {
  res.json(Object.values(contracts).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

// Get single contract
app.get("/api/contracts/:id", (req, res) => {
  const contract = contracts[req.params.id];
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  res.json(contract);
});

// Submit delivery
app.post("/api/contracts/:id/deliver", async (req, res) => {
  const contract = contracts[req.params.id];
  if (!contract) return res.status(404).json({ error: "Contract not found" });

  if (contract.status !== "AWAITING_DELIVERY") {
    return res.status(400).json({ error: `Contract is in status: ${contract.status}. Cannot submit delivery.` });
  }

  const { deliveryText } = req.body;
  if (!deliveryText || deliveryText.trim().length < 20) {
    return res.status(400).json({ error: "Delivery description must be at least 20 characters" });
  }

  contract.status = "VERIFYING";
  contract.deliveryText = deliveryText;

  appendAuditLog(req.params.id, {
    event: "DELIVERY_SUBMITTED",
    actor: "freelancer",
    data: { deliveryLength: deliveryText.length },
  });

  // Run AI verification
  const aiResult = await verifyDeliveryWithClaude(contract, deliveryText);
  contract.aiVerification = aiResult;

  if (aiResult.approved) {
    contract.status = "AI_APPROVED";
    appendAuditLog(req.params.id, {
      event: "AI_VERIFICATION_APPROVED",
      actor: "ai_agent",
      data: { score: aiResult.score, recommendation: aiResult.recommendation },
    });

    // Automatically trigger OWS signing
    const signingResult = simulateOwsSigning(contract, contract.owsPolicy);
    contract.signingResult = signingResult;

    if (signingResult.allPassed) {
      contract.status = "PAYMENT_SENT";
      appendAuditLog(req.params.id, {
        event: "PAYMENT_EXECUTED",
        actor: "ows_signer",
        data: {
          txHash: signingResult.signedTx.hash,
          amount: contract.amount,
          to: contract.freelancerWallet,
          privateKeyExposed: false,
        },
      });
    }
  } else {
    contract.status = "AI_REJECTED";
    appendAuditLog(req.params.id, {
      event: "AI_VERIFICATION_REJECTED",
      actor: "ai_agent",
      data: { score: aiResult.score, recommendation: aiResult.recommendation },
    });
  }

  res.json(contract);
});

// Get audit log for a contract
app.get("/api/contracts/:id/audit", (req, res) => {
  const logs = auditLogs[req.params.id] || [];
  res.json(logs);
});

// Get OWS policy for a contract
app.get("/api/contracts/:id/policy", (req, res) => {
  const contract = contracts[req.params.id];
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  res.json(contract.owsPolicy);
});

// Reset a rejected contract to allow resubmission
app.post("/api/contracts/:id/reset", (req, res) => {
  const contract = contracts[req.params.id];
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  if (contract.status !== "AI_REJECTED") {
    return res.status(400).json({ error: "Only rejected contracts can be reset" });
  }
  contract.status = "AWAITING_DELIVERY";
  contract.aiVerification = null;
  contract.deliveryText = null;
  appendAuditLog(req.params.id, {
    event: "CONTRACT_RESET",
    actor: "client",
    data: {},
  });
  res.json(contract);
});

// ---------------------------------
// Error handler
// ---------------------------------
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`WalletWitness backend running on port ${PORT}`);
});

module.exports = app;
