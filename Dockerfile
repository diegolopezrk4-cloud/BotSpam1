FROM node:20-slim AS wsp

WORKDIR /app

# Install Python for TG bot
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv && rm -rf /var/lib/apt/lists/*

# Copy package files first for better caching
COPY package*.json ./
RUN npm ci --production

# Copy app files
COPY . .

# Create required directories
RUN mkdir -p sessions media comprobantes backups client_sessions data

# Expose ports: WSP API (3000), Panel (3001), TG API (3002)
EXPOSE 3000 3001 3002

# Start all services
CMD ["bash", "start.sh"]
