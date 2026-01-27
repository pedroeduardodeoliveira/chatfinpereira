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
import fs from "fs";

const { Client, LocalAuth } = pkg;

console.log("Iniciando bot WhatsApp + Google Sheets...");

// =========================
// CONFIGURAÇÕES
// =========================

const SPREADSHEET_ID = "1pm0xKftMIWeE4l88jLfC-vk3qk4YIf-s0rIU3xAjl-0";
const SHEET_NAME = "Página1";

const CONFIG_PATH = path.join(process.cwd(), "config.json");

let messageDelayMs = 3000;

// Carregar config
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const json = JSON.parse(raw);
    if (json.messageDelayMs) messageDelayMs = json.messageDelayMs;
    console.log("✅ Configurações carregadas:", json);
  }
} catch (e) {
  console.error("Erro ao carregar confirm.json:", e);
}

function saveConfig() {
  try {
    const data = {
      messageDelayMs
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
    console.log("💾 Configurações salvas.");
  } catch (e) {
    console.error("Erro ao salvar config:", e);
  }
}

let isWhatsAppReady = false;
let isSending = false; // Bloqueio de concorrência

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
async function getMessagesFromSheet(targetFlag) {
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
      if (String(sendFlag).trim() === targetFlag && text && text.trim() !== "") {
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
  // 1. Número Internacional (Marcado com +)
  if (String(phoneRaw).trim().startsWith("+")) {
    const digits = String(phoneRaw).replace(/\D/g, "");
    // Aceita se tiver entre 7 e 15 dígitos (padrão internacional variavel)
    if (digits.length >= 7 && digits.length <= 15) {
      return digits;
    }
    return null; // Inválido se muito curto
  }

  // 2. Lógica Brasil (Legado / Padrão sem +)
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
  if (messageLog.length > 100) messageLog.shift(); // Otimizado: max 100 logs
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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--no-first-run"],
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
  currentQR = null; // Libera memória
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




// =========================
// ENVIO PLANILHA
// =========================

// Função de atraso entre mensagens
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendAllMessages(targetFlag = "1") {
  if (!isWhatsAppReady) {
    console.warn("⚠️ WhatsApp não está pronto, envio cancelado.");
    return;
  }

  if (isSending) {
    console.warn("⚠️ Já existe um envio em andamento. Aguarde terminar.");
    return;
  }

  isSending = true;

  try {
    const messages = await getMessagesFromSheet(targetFlag);
    console.log(`Iniciando envio (Flag "${targetFlag}") de ${messages.length} mensagens...`);

    let sent = 0;
    let noWhatsapp = 0;
    let errors = 0;

    for (let i = 0; i < messages.length; i++) {
      const { phone, text } = messages[i];

      try {
        const wid = await client.getNumberId(phone);

        if (!wid) {
          noWhatsapp++;
          addToLog({ phone, status: "no-whatsapp", info: `[Lista ${targetFlag}] Sem WhatsApp` });
        } else {
          await client.sendMessage(wid._serialized, text);
          sent++;
          addToLog({ phone, status: "sent", info: `[Lista ${targetFlag}] Mensagem enviada` });
        }
      } catch (err) {
        errors++;
        addToLog({
          phone,
          status: "error",
          info: `[Lista ${targetFlag}] ${err?.message || "Erro desconhecido"}`,
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
  } finally {
    isSending = false;
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
    delayMs: messageDelayMs,
  });
});

// Log
app.get("/api/log", (req, res) => {
  res.json({
    log: messageLog,
    todayCount: dailyMessageCount,
  });
});

// Atualiza horários


// Envio imediato
app.post("/api/send-now", async (req, res) => {
  try {
    const flag = req.body.flag || "1"; // Default to "1" if not provided
    await sendAllMessages(flag);
    res.json({ ok: true, flag });
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
