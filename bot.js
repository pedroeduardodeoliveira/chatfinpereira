// bot.js
let currentQR = null;
let lastQR = null;

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import cors from "cors";
import qrcode from "qrcode-terminal";
import { google } from "googleapis";
import pkg from "whatsapp-web.js";

const { Client, LocalAuth } = pkg;

console.log("Iniciando bot WhatsApp + Google Sheets...");

// =========================
// CONFIGURAÇÕES
// =========================

const SPREADSHEET_ID = "1pm0xKftMIWeE4l88jLfC-vk3qk4YIf-s0rIU3xAjl-0";
const SHEET_NAME = "Página1";

let messageDelayMs = 3000;
let isWhatsAppReady = false;

// Estatísticas
let lastRunInfo = {
  lastRunAt: null,
  totalSent: 0,
  totalNoWhatsapp: 0,
  totalErrors: 0,
};

let messageLog = [];

// =========================
// GOOGLE SHEETS
// =========================

async function getGoogleSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: "v4", auth: authClient });
}

async function getMessagesFromSheet() {
  const sheets = await getGoogleSheetsClient();
  const range = `${SHEET_NAME}!A:C`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });

  const rows = response.data.values || [];
  const messages = [];

  for (const row of rows) {
    const phone = row[0];
    const sendFlag = row[1];
    const text = row[2];

    if (!phone || String(sendFlag).trim() !== "1" || !text) continue;

    const normalized = normalizePhone(phone);
    if (normalized) {
      messages.push({ phone: normalized, text: text.trim() });
    }
  }

  return messages;
}

// =========================
// NORMALIZAÇÃO DE TELEFONE
// =========================

function normalizePhone(raw) {
  let digits = String(raw).replace(/\D/g, "");

  if (digits.startsWith("55") && digits.length >= 12 && digits.length <= 13)
    return digits;

  if (digits.length === 10 || digits.length === 11)
    return "55" + digits;

  if (digits.length >= 12 && digits.length <= 15)
    return digits;

  return null;
}

// =========================
// LOG
// =========================

function addToLog({ phone, status, info }) {
  messageLog.push({
    timestamp: new Date().toISOString(),
    phone,
    status,
    info: info || "",
  });

  if (messageLog.length > 500) messageLog.shift();
}

// =========================
// WHATSAPP CLIENT
// =========================

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "bot-planilha",
    dataPath: "./.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  },
});

client.on("qr", (qr) => {
  currentQR = qr;
  lastQR = qr;
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ WhatsApp conectado");
  isWhatsAppReady = true;
});

client.on("auth_failure", () => {
  console.log("❌ Falha de autenticação");
  isWhatsAppReady = false;
});

client.on("disconnected", () => {
  console.log("⚠️ Desconectado, reiniciando...");
  isWhatsAppReady = false;
  client.initialize();
});

client.initialize();

// =========================
// ENVIO DE MENSAGENS
// =========================

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendAllMessages() {
  if (!isWhatsAppReady) {
    console.warn("WhatsApp não está pronto");
    return;
  }

  const messages = await getMessagesFromSheet();

  let sent = 0;
  let noWhatsapp = 0;
  let errors = 0;

  for (let i = 0; i < messages.length; i++) {
    const { phone, text } = messages[i];

    try {
      const wid = await client.getNumberId(phone);

      if (!wid) {
        noWhatsapp++;
        addToLog({ phone, status: "no-whatsapp", info: "Sem WhatsApp" });
      } else {
        await client.sendMessage(wid._serialized, text);
        sent++;
        addToLog({ phone, status: "sent", info: "Mensagem enviada" });
      }
    } catch (err) {
      errors++;
      addToLog({
        phone,
        status: "error",
        info: err?.message || "Erro desconhecido",
      });
    }

    if (i < messages.length - 1) {
      await delay(messageDelayMs);
    }
  }

  lastRunInfo = {
    lastRunAt: new Date().toISOString(),
    totalSent: sent,
    totalNoWhatsapp: noWhatsapp,
    totalErrors: errors,
  };

  console.log("Envio concluído:", lastRunInfo);
}

async function sendTestToSingleNumber(phone, text) {
  if (!isWhatsAppReady) throw new Error("WhatsApp não conectado");

  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error("Telefone inválido");

  const wid = await client.getNumberId(normalized);
  if (!wid) throw new Error("Número não possui WhatsApp");

  await client.sendMessage(wid._serialized, text);
  addToLog({ phone: normalized, status: "sent", info: "Teste enviado" });

  return { to: wid._serialized };
}

// =========================
// EXPRESS / API
// =========================

const app = express();
app.use(cors());
app.use(bodyParser.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/qr", (req, res) => {
  res.json({ qr: currentQR || lastQR || null });
});

app.get("/api/status", (req, res) => {
  res.json({
    whatsappReady: isWhatsAppReady,
    lastRun: lastRunInfo,
  });
});

app.get("/api/log", (req, res) => {
  res.json({ log: messageLog });
});

app.post("/api/send-now", async (req, res) => {
  try {
    await sendAllMessages();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Erro no envio manual" });
  }
});

app.post("/api/send-test", async (req, res) => {
  const { phone, text } = req.body;

  if (!phone || !text) {
    return res.status(400).json({ error: "Informe telefone e texto" });
  }

  try {
    const result = await sendTestToSingleNumber(phone, text);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================
// SERVIDOR
// =========================

const PORT = process.env.PORT || 5002;

app.listen(PORT, () => {
  console.log(`🌐 Rodando em http://localhost:${PORT}`);
});

