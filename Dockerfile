FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY scrape-and-notify.mjs ./

CMD ["node", "scrape-and-notify.mjs"]
