// bot.js
let currentQR = null;
let lastQR = null; // <-- garante que o QR nunca seja perdido

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import cors from "cors";
import schedule from "node-schedule";
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

let dailyTime = "18:00"; 
let messageDelayMs = 3000;
let dailyEnabled = true;

let isWhatsAppReady = false;

// Estatísticas
let lastRunInfo = {
  lastRunAt: null,
  totalSent: 0,
  totalNoWhatsapp: 0,
  totalErrors: 0,
};

let messageLog = [];
let dailyMessageCount = 0;

const BROWSER_EXECUTABLE_PATH =
  "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe";

// =========================
// GOOGLE SHEETS
// =========================

async function getGoogleSheetsClient() {
  console.log("Configurando cliente Google Sheets...");
  const auth = new google.auth.GoogleAuth({
    keyFile: "credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });
  return sheets;
}

// Lê a planilha
async function getMessagesFromSheet() {
  try {
    const sheets = await getGoogleSheetsClient();
    const range = `${SHEET_NAME}!A:C`;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });

    const rows = response.data.values || [];
    const messages = [];

    for (let row of rows) {
      const phone = row[0];
      const sendFlag = row[1];
      const text = row[2];

      if (!phone || typeof sendFlag === "undefined") continue;
      if (String(sendFlag).trim() === "1" && text && text.trim() !== "") {
        const normalizedPhone = normalizePhone(phone);
        if (normalizedPhone) {
          messages.push({ phone: normalizedPhone, text: text.trim() });
        }
      }
    }
    return messages;
  } catch (err) {
    console.error("Erro ao ler planilha:", err);
    throw err;
  }
}

// =========================
// NORMALIZAÇÃO DO TELEFONE
// =========================

function normalizePhone(phoneRaw) {
  let digits = String(phoneRaw).replace(/\D/g, "");

  if (digits.startsWith("55") && digits.length >= 12 && digits.length <= 13) {
    return digits;
  }

  if (digits.length === 11 || digits.length === 10) {
    return "55" + digits;
  }

  if (digits.length >= 12 && digits.length <= 15) {
    return digits;
  }

  return null;
}

// =========================
// LOG
// =========================

function addToLog({ phone, status, info }) {
  const entry = {
    timestamp: new Date().toISOString(),
    phone,
    status,
    info: info || "",
  };

  messageLog.push(entry);
  if (messageLog.length > 500) messageLog.shift();
  if (status === "sent") dailyMessageCount++;
}

schedule.scheduleJob("1 0 * * *", () => {
  dailyMessageCount = 0;
});

// =========================
// WHATSAPP CLIENT
// =========================

console.log("Inicializando cliente WhatsApp...");

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "bot-planilha" }),
  puppeteer: {
    headless: true,
    executablePath: BROWSER_EXECUTABLE_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("QR CODE RECEBIDO");
  currentQR = qr;
  lastQR = qr; // <-- salva para interface web
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ Cliente WhatsApp pronto!");
  isWhatsAppReady = true;
});

client.on("authenticated", () => {
  console.log("✅ Autenticado no WhatsApp.");
});

client.on("auth_failure", () => {
  console.log("❌ Falha de autenticação.");
  isWhatsAppReady = false;
});

client.on("disconnected", () => {
  console.log("⚠️ Desconectado. Reiniciando...");
  isWhatsAppReady = false;
  client.initialize();
});

client.initialize();

// =========================
// AGENDAMENTO DIÁRIO
// =========================

let scheduledJob = null;

function scheduleDailyJob() {
  if (scheduledJob) {
    scheduledJob.cancel();
    console.log("Agendamento anterior cancelado.");
  }

  if (!dailyEnabled) {
    console.log("Envio diário DESATIVADO.");
    return;
  }

  const [hourStr, minuteStr] = dailyTime.split(":");
  const hour = parseInt(hourStr);
  const minute = parseInt(minuteStr);

  const rule = new schedule.RecurrenceRule();
  rule.tz = "America/Sao_Paulo";
  rule.hour = hour;
  rule.minute = minute;

  scheduledJob = schedule.scheduleJob(rule, async () => {
    console.log(`⏰ Executando envio diário às ${dailyTime}`);
    await sendAllMessages();
  });

  console.log(`📅 Envio diário programado para ${dailyTime}`);
}

scheduleDailyJob();


// =========================
// ENVIO PLANILHA
// =========================

// Função de atraso entre mensagens
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendAllMessages() {
  if (!isWhatsAppReady) {
    console.warn("⚠️ WhatsApp não está pronto, envio cancelado.");
    return;
  }

  try {
    const messages = await getMessagesFromSheet();
    console.log(`Iniciando envio de ${messages.length} mensagens...`);

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
  } catch (err) {
    console.error("Erro geral no envio:", err);
  }
}


// =========================
// ENVIO TESTE
// =========================

async function sendTestToSingleNumber(rawPhone, text) {
  if (!isWhatsAppReady) throw new Error("WhatsApp não está conectado.");

  const normalized = normalizePhone(rawPhone);
  if (!normalized) throw new Error("Telefone inválido.");

  const wid = await client.getNumberId(normalized);

  if (!wid) {
    addToLog({ phone: normalized, status: "no-whatsapp", info: "Sem WhatsApp" });
    throw new Error("Número não possui WhatsApp.");
  }

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


// 🔥 ROTA QUE ENVIA O QR CODE PARA A INTERFACE WEB
app.get("/api/qr", (req, res) => {
  res.json({ qr: currentQR || lastQR || null });
});


// Status geral
app.get("/api/status", (req, res) => {
  res.json({
    whatsappReady: isWhatsAppReady,
    lastRun: lastRunInfo,
    todayCount: dailyMessageCount,
  });
});

// Config atual
app.get("/api/config", (req, res) => {
  res.json({
    time: dailyTime,
    delayMs: messageDelayMs,
    dailyEnabled,
  });
});

// Log
app.get("/api/log", (req, res) => {
  res.json({
    log: messageLog,
    todayCount: dailyMessageCount,
  });
});

// Atualiza horário
app.post("/api/time", (req, res) => {
  const { time } = req.body;

  if (!/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: "Formato inválido. Use HH:MM." });
  }

  dailyTime = time;
  scheduleDailyJob();

  res.json({ ok: true, time });
});

// Ativar / desativar envio diário
app.post("/api/daily", (req, res) => {
  dailyEnabled = Boolean(req.body.enabled);
  scheduleDailyJob();
  res.json({ ok: true, enabled: dailyEnabled });
});

// Envio imediato
app.post("/api/send-now", async (req, res) => {
  try {
    await sendAllMessages();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erro no envio manual." });
  }
});

// Envio de teste
app.post("/api/send-test", async (req, res) => {
  const { phone, text } = req.body;

  if (!phone || !text) {
    return res.status(400).json({ error: "Informe telefone e texto." });
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

const PORT = process.env.PORT || 3112;

app.listen(PORT, () => {
  console.log(`🌐 Interface web disponível em: http://localhost:${PORT}`);
});
