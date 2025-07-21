# STAGE 1: Build de dependencies in een 'builder' image
# We gebruiken de volledige Node 20 image hier omdat deze alle build-tools bevat
FROM node:20-slim AS builder

# Zet de werkdirectory
WORKDIR /usr/src/app

# Kopieer package.json en package-lock.json
COPY package*.json ./

# Installeer alle dependencies.
# Dit gebeurt in een aparte laag die we later niet meenemen.
RUN npm install


# STAGE 2: Creëer de uiteindelijke, lichtgewicht productie-image
FROM node:20-slim

# Voorkom interactieve prompts tijdens package installaties (lost debconf warnings op)
ENV DEBIAN_FRONTEND=noninteractive

# Installeer alleen de RUNTIME dependencies voor de headless browser (Puppeteer).
# Dit is de volledige, aanbevolen lijst voor Debian (waar 'slim' op is gebaseerd).
RUN apt-get update && apt-get install -yq \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    # Ruim de apt-cache op om de image-grootte te verkleinen
    && rm -rf /var/lib/apt/lists/*

# Zet de werkdirectory
WORKDIR /usr/src/app

# Kopieer de geïnstalleerde dependencies uit de 'builder' stage
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Kopieer de applicatiecode
COPY . .

# Maak een niet-root gebruiker aan voor extra veiligheid
RUN useradd -m appuser

# Zet de eigenaar van de app-bestanden op de nieuwe gebruiker
RUN chown -R appuser:appuser /usr/src/app

# Schakel over naar de niet-root gebruiker
USER appuser

# Definieer de persistente volume voor de sessie-data
VOLUME /usr/src/app/wweb_session

# Definieer het commando om de applicatie te starten
CMD [ "npm", "start" ]
