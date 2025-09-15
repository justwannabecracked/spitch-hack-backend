    # Stage 1: Build the application
    FROM node:18-alpine AS base

    # Install FFmpeg using the Alpine package manager
    RUN apk add --no-cache ffmpeg

    WORKDIR /usr/src/app

    COPY package*.json ./
    RUN npm install

    COPY . .
    RUN npm run build

    # Stage 2: Create a smaller, final image for production
    FROM node:18-alpine AS final

    # Re-install FFmpeg in the final image
    RUN apk add --no-cache ffmpeg

    WORKDIR /usr/src/app

    # Copy only the necessary built files and dependencies
    COPY --from=base /usr/src/app/dist ./dist
    COPY --from=base /usr/src/app/node_modules ./node_modules
    COPY --from=base /usr/src/app/package*.json ./

    # The command to run your application
    CMD ["node", "dist/main"]
    

