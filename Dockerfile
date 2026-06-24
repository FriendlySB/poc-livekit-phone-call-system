FROM node:22.11-slim

WORKDIR /app
COPY . .
RUN npm install 

EXPOSE 3000
ENTRYPOINT ["npm","run","start"]
