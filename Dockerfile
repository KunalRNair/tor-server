FROM node:20-slim

# Install FFmpeg + build tools for native deps (webtorrent needs them)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
