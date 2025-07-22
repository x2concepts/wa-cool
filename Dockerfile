# STAGE 1: Build de dependencies in een 'builder' image
FROM node:20-slim AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

# STAGE 2: Creëer de uiteindelijke, lichtgewicht productie-image
FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -yq \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libgconf-2-4 \
    libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxshmfence1 \
    libxss1 libxtst6 lsb-release wget xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Maak een niet-root gebruiker aan voor extra veiligheid
RUN useradd -m appuser

# Maak de sessie map aan VOORDAT we de permissies instellen
RUN mkdir -p /usr/src/app/wweb_session

# Zet de eigenaar van ALLE app-bestanden, inclusief de sessie-map, op de nieuwe gebruiker
RUN chown -R appuser:appuser /usr/src/app

# Schakel over naar de niet-root gebruiker
USER appuser

# Definieer de persistente volume voor de sessie-data
VOLUME /usr/src/app/wweb_session

# Definieer het commando om de applicatie te starten
CMD [ "npm", "start" ]
