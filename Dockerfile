FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
ENV NODE_ENV=production
ENV PORT=8791
EXPOSE 8791
CMD ["npm", "run", "start"]
