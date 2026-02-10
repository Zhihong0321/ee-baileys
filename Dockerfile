# Use Node.js 20 slim image as base
FROM node:20-slim

# Install system dependencies: FFmpeg and build tools for native modules
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the source code
COPY . .

# Build the TypeScript project
RUN npm run build

# Create sessions directory (this will be used for the Railway volume)
RUN mkdir -p sessions

# Expose the port (Railway will provide this via PORT env)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
