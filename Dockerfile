FROM node:20-slim

# Instala dependências do Chromium
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxrandr2 \
  libgbm1 \
  libasound2 \
  libpangocairo-1.0-0 \
  libnss3 \
  libxdamage1 \
  libgtk-3-0 \
  libdrm2 \
  ca-certificates \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROME_BIN=/usr/bin/chromium

EXPOSE 3112

CMD ["node", "bot.js"]
