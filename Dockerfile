# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app .
EXPOSE 7148
CMD ["npx", "tsx", "app.ts"]
