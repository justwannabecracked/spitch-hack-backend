    FROM node:18-alpine AS base

    RUN apk add --no-cache ffmpeg

    WORKDIR /usr/src/app

    COPY package*.json ./
    RUN npm install

    COPY . .
    RUN npm run build

    FROM node:18-alpine AS final

    RUN apk add --no-cache ffmpeg

    WORKDIR /usr/src/app

    COPY --from=base /usr/src/app/dist ./dist
    COPY --from=base /usr/src/app/node_modules ./node_modules
    COPY --from=base /usr/src/app/package*.json ./

    CMD ["node", "dist/main"]
    

